// File: SpeechFollowModule.swift → ~/Projects/podiumnotes/modules/speech-follow/ios/SpeechFollowModule.swift
//
// Streams on-device live speech transcription to JS via the "onTranscript"
// event. A recognition task is time-limited, so it auto-restarts while
// listening to follow a long talk.
//
// ── macOS (Designed for iPad) notes ──
//
// Voice follow worked on iPhone and iPad but silently did nothing on a Mac.
// Two things in the original were the likely cause, and both are changed
// here:
//
//   1. Microphone permission went through AVAudioSession.requestRecordPermission.
//      Under Designed for iPad that can fail to invoke its completion handler
//      at all — so the promise never resolved, the JS await never returned,
//      and nothing happened with no error to show for it. AVCaptureDevice's
//      equivalent is cross-platform and always calls back.
//
//   2. AVAudioSession category/activation were `try` calls that aborted the
//      whole session if they threw. On macOS the session is a shim and can
//      throw for reasons that don't actually prevent capture, so they are
//      now best-effort — matching what SpeechPlayer already does.
//
// Everything is logged with a [sf] prefix so one run on any platform shows
// which stage fails: authorization, recognizer availability, audio format,
// or engine start.

import ExpoModulesCore
import Speech
import AVFoundation

public class SpeechFollowModule: Module {
  private let audioEngine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var listening = false
  private var localeId = "en-US"

  public func definition() -> ModuleDefinition {
    Name("SpeechFollow")

    Events("onTranscript", "onStatus", "onError")

    AsyncFunction("requestPermissions") { (promise: Promise) in
      SFSpeechRecognizer.requestAuthorization { status in
        NSLog("[sf] speech authorization: \(Self.authName(status))")
        let speechOK = status == .authorized

        // AVCaptureDevice rather than AVAudioSession: the session variant
        // can silently never call back on macOS, which left this promise
        // pending forever.
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        NSLog("[sf] mic authorization (before request): \(Self.captureName(micStatus))")

        AVCaptureDevice.requestAccess(for: .audio) { micOK in
          NSLog("[sf] mic granted: \(micOK) | speech granted: \(speechOK)")
          DispatchQueue.main.async { promise.resolve(speechOK && micOK) }
        }
      }
    }

    // Reports every stage at once, so a single call says which one fails.
    AsyncFunction("diagnose") { () -> [String: Any] in
      let rec = SFSpeechRecognizer(locale: Locale(identifier: self.localeId)) ?? SFSpeechRecognizer()
      let input = self.audioEngine.inputNode
      let fmt = input.outputFormat(forBus: 0)
      let info: [String: Any] = [
        "speechAuth": Self.authName(SFSpeechRecognizer.authorizationStatus()),
        "micAuth": Self.captureName(AVCaptureDevice.authorizationStatus(for: .audio)),
        "recognizerExists": rec != nil,
        "recognizerAvailable": rec?.isAvailable ?? false,
        "onDeviceSupported": rec?.supportsOnDeviceRecognition ?? false,
        "inputSampleRate": fmt.sampleRate,
        "inputChannels": Int(fmt.channelCount),
        "hasAudioInput": fmt.channelCount > 0 && fmt.sampleRate > 0,
      ]
      NSLog("[sf] diagnose: \(info)")
      return info
    }

    AsyncFunction("start") { (locale: String, promise: Promise) in
      DispatchQueue.main.async {
        self.localeId = locale.isEmpty ? "en-US" : locale
        do {
          try self.beginSession()
          promise.resolve(true)
        } catch {
          NSLog("[sf] beginSession threw: \(error.localizedDescription)")
          self.sendEvent("onError", ["message": error.localizedDescription])
          self.endSession()
          promise.resolve(false)
        }
      }
    }

    Function("stop") {
      DispatchQueue.main.async { self.endSession() }
    }

    OnDestroy { self.endSession() }
  }

  private func beginSession() throws {
    endSession()
    NSLog("[sf] beginSession locale=\(localeId)")

    let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer()
    guard let rec = rec else {
      NSLog("[sf] FAIL: no recognizer for locale \(localeId)")
      sendEvent("onError", ["message": "Speech recognizer unavailable for \(localeId)"])
      return
    }
    NSLog("[sf] recognizer available=\(rec.isAvailable) onDevice=\(rec.supportsOnDeviceRecognition)")
    guard rec.isAvailable else {
      NSLog("[sf] FAIL: recognizer reports unavailable")
      sendEvent("onError", ["message": "Speech recognizer unavailable"])
      return
    }
    recognizer = rec
    listening = true
    try startTask()
    sendEvent("onStatus", ["listening": true])
  }

  private func startTask() throws {
    // Best effort: on macOS the audio session is a shim and can throw for
    // reasons that don't prevent capture. A throw here used to abort the
    // whole session.
    configureRecordSession()

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer?.supportsOnDeviceRecognition == true {
      req.requiresOnDeviceRecognition = true
    } else {
      // Falling back to server recognition needs a network connection —
      // worth knowing if this is where Mac behaviour diverges.
      NSLog("[sf] on-device recognition unsupported; using server recognition")
    }
    request = req

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    NSLog("[sf] input format: \(format.sampleRate) Hz, \(format.channelCount) ch")
    guard format.channelCount > 0, format.sampleRate > 0 else {
      // The classic Designed-for-iPad microphone failure: the node exists
      // but reports no channels, and installTap would crash.
      NSLog("[sf] FAIL: input node has no usable format — microphone unavailable")
      sendEvent("onError", ["message": "No microphone input available"])
      listening = false
      return
    }

    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      req.append(buffer)
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
      NSLog("[sf] audio engine started")
    } catch {
      NSLog("[sf] FAIL: audio engine start: \(error.localizedDescription)")
      throw error
    }

    task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        self.sendEvent("onTranscript", ["text": result.bestTranscription.formattedString])
      }
      if let error = error {
        NSLog("[sf] recognition error: \(error.localizedDescription)")
      }
      if error != nil || (result?.isFinal ?? false) {
        self.cycleTask()
      }
    }
    NSLog("[sf] recognition task created: \(task != nil)")
  }

  private func configureRecordSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[sf] audio session unavailable (continuing): \(error.localizedDescription)")
    }
  }

  // Recognition tasks are time-limited; restart to keep following a long talk.
  private func cycleTask() {
    guard listening else { return }
    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    request?.endAudio(); request = nil
    task?.cancel(); task = nil
    do { try startTask() } catch {
      sendEvent("onError", ["message": error.localizedDescription])
    }
  }

  private func endSession() {
    listening = false
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio(); request = nil
    task?.cancel(); task = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    sendEvent("onStatus", ["listening": false])
  }

  // MARK: - Readable status names

  private static func authName(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch s {
    case .authorized:    return "authorized"
    case .denied:        return "denied"
    case .restricted:    return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default:    return "unknown"
    }
  }

  private static func captureName(_ s: AVAuthorizationStatus) -> String {
    switch s {
    case .authorized:    return "authorized"
    case .denied:        return "denied"
    case .restricted:    return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default:    return "unknown"
    }
  }
}
