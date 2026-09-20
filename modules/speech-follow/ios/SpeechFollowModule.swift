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
  // Recognition tasks are time-limited and restarted on purpose, so an error
  // normally means "cycle". But an error that will recur every time — a
  // disabled Dictation service, most of all — turns that into an infinite
  // restart loop holding the microphone open. Counting consecutive failures
  // with no transcript in between distinguishes the two.
  private var consecutiveFailures = 0
  private static let maxConsecutiveFailures = 8

  /// Errors that mean "nothing was said", not "recognition is broken".
  ///
  /// A tester reported voice follow working through every rehearsal at home
  /// and failing at the podium. Silence is the difference: at home you tap
  /// start and speak immediately, while at a lectern there is a gap — being
  /// introduced, walking up, a breath before the first line. SFSpeechRecognizer
  /// reports that silence as an error, and counting it as a failure ended the
  /// session after three quiet cycles, before a word was spoken.
  ///
  /// These are cycled like any completed task, without counting against the
  /// failure budget.
  private static func isSilenceError(_ error: NSError) -> Bool {
    // kAFAssistantErrorDomain 1110 "No speech detected", 203 "Retry",
    // 216 cancellation during a cycle.
    if error.domain == "kAFAssistantErrorDomain" {
      return error.code == 1110 || error.code == 203 || error.code == 216
    }
    // SFSpeechRecognizer surfaces the same condition through its own domain
    // on some releases.
    if error.domain == "com.apple.speech.recognition.AFAssistantErrorDomain" {
      return error.code == 1110 || error.code == 203
    }
    return false
  }

  public func definition() -> ModuleDefinition {
    Name("SpeechFollow")

    // Event names are MODULE-SCOPED only if they're unique. SpeechPlayer also
    // declares "onError", and a recognition failure was surfacing in Listen's
    // playback error handler — two unrelated alerts for one problem. Prefixed
    // names remove the ambiguity rather than filtering it downstream.
    Events("onTranscript", "onStatus", "onFollowError")

    AsyncFunction("requestPermissions") { (promise: Promise) in
      SFSpeechRecognizer.requestAuthorization { status in
        let speechOK = status == .authorized

        // AVCaptureDevice rather than AVAudioSession: the session variant
        // can silently never call back on macOS, which left this promise
        // pending forever.
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
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
          self.sendEvent("onFollowError", ["code": "start-failed", "message": error.localizedDescription])
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

    let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer()
    guard let rec = rec else {
      NSLog("[sf] FAIL: no recognizer for locale \(localeId)")
      sendEvent("onFollowError", ["code": "no-recognizer", "message": "Speech recognizer unavailable for \(localeId)"])
      return
    }
    guard rec.isAvailable else {
      NSLog("[sf] FAIL: recognizer reports unavailable")
      sendEvent("onFollowError", ["code": "unavailable", "message": "Speech recognizer unavailable"])
      return
    }
    recognizer = rec
    listening = true
    consecutiveFailures = 0
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
    guard format.channelCount > 0, format.sampleRate > 0 else {
      // The classic Designed-for-iPad microphone failure: the node exists
      // but reports no channels, and installTap would crash.
      NSLog("[sf] FAIL: input node has no usable format — microphone unavailable")
      sendEvent("onFollowError", ["code": "no-microphone", "message": "No microphone input available"])
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
    } catch {
      NSLog("[sf] FAIL: audio engine start: \(error.localizedDescription)")
      throw error
    }

    task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        self.consecutiveFailures = 0     // progress: the cycle is healthy
        self.sendEvent("onTranscript", ["text": result.bestTranscription.formattedString])
      }

      if let error = error {
        let ns = error as NSError
        NSLog("[sf] recognition error: \(ns.domain) \(ns.code) — \(error.localizedDescription)")

        // Silence is not a failure. Cycle and keep listening — after a
        // short pause, because a silence error can return immediately and
        // restarting with no delay would spin the recognizer hot through a
        // long gap before the speaker begins.
        if Self.isSilenceError(ns) {
          self.cycleTask(after: 0.4)
          return
        }

        // macOS routes SFSpeechRecognizer through the Dictation service. With
        // Dictation switched off in System Settings every task fails
        // immediately with this message — permissions look fine, the
        // microphone works, and nothing is transcribed. Worth naming
        // precisely, since the fix is one toggle and is impossible to guess.
        if error.localizedDescription.localizedCaseInsensitiveContains("dictation") {
          self.sendEvent("onFollowError", [
            "code": "dictation-disabled",
            "message": error.localizedDescription,
          ])
          self.endSession()
          return
        }

        self.consecutiveFailures += 1
        if self.consecutiveFailures >= Self.maxConsecutiveFailures {
          self.sendEvent("onFollowError", [
            "code": "recognition-failed",
            "message": error.localizedDescription,
          ])
          self.endSession()
          return
        }
      }

      if error != nil || (result?.isFinal ?? false) {
        self.cycleTask()
      }
    }
  }

  private func configureRecordSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      // .default, not .measurement.
      //
      // Apple's sample code uses .measurement, which disables the input
      // processing chain — including automatic gain control — to give the
      // recognizer raw audio. That is right for a phone held close to the
      // mouth, and wrong for a device on a lectern: at arm's length, with
      // room reverb and a PA putting the speaker's own voice back into the
      // room, the signal is quieter and messier, and AGC is exactly what
      // compensates. A tester's live failure after clean rehearsals is the
      // shape of problem this produces.
      try session.setCategory(.record, mode: .default, options: [.duckOthers])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("[sf] audio session unavailable (continuing): \(error.localizedDescription)")
    }
  }

  // Recognition tasks are time-limited; restart to keep following a long talk.
  private func cycleTask(after delay: TimeInterval = 0) {
    guard listening else { return }
    if delay > 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        self?.cycleTask()
      }
      return
    }
    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    request?.endAudio(); request = nil
    task?.cancel(); task = nil
    do { try startTask() } catch {
      sendEvent("onFollowError", ["code": "restart-failed", "message": error.localizedDescription])
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
