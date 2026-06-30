// modules/speech-follow/ios/SpeechFollowModule.swift
//
// Replaces the generated SpeechFollowModule.swift. Streams on-device live
// speech transcription to JS via the "onTranscript" event. A recognition task
// is time-limited, so it auto-restarts while listening to follow a long talk.

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
        let speechOK = status == .authorized
        AVAudioSession.sharedInstance().requestRecordPermission { micOK in
          DispatchQueue.main.async { promise.resolve(speechOK && micOK) }
        }
      }
    }

    AsyncFunction("start") { (locale: String, promise: Promise) in
      DispatchQueue.main.async {
        self.localeId = locale.isEmpty ? "en-US" : locale
        do {
          try self.beginSession()
          promise.resolve(true)
        } catch {
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
    let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer()
    guard let rec = rec, rec.isAvailable else {
      sendEvent("onError", ["message": "Speech recognizer unavailable"])
      return
    }
    recognizer = rec
    listening = true
    try startTask()
    sendEvent("onStatus", ["listening": true])
  }

  private func startTask() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
    try session.setActive(true, options: .notifyOthersOnDeactivation)

    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer?.supportsOnDeviceRecognition == true {
      req.requiresOnDeviceRecognition = true
    }
    request = req

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      req.append(buffer)
    }
    audioEngine.prepare()
    try audioEngine.start()

    task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        self.sendEvent("onTranscript", ["text": result.bestTranscription.formattedString])
      }
      if error != nil || (result?.isFinal ?? false) {
        self.cycleTask()
      }
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
}