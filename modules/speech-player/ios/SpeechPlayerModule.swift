// File: SpeechPlayerModule.swift → ~/Projects/podiumnotes/modules/speech-player/ios/SpeechPlayerModule.swift
//
// Listen mode's native core. Two halves:
//
//   1. SYNTHESIS — renders a note's text to an .m4a file ONCE via
//      AVSpeechSynthesizer.write (all on-device, faster than realtime),
//      chunked by paragraph so arbitrarily long speeches render reliably.
//      Playing a real file (instead of speaking live) is what makes the rest
//      of the system behave like a proper audio app.
//
//   2. PLAYBACK — AVPlayer + a .playback audio session + MPNowPlayingInfoCenter
//      + MPRemoteCommandCenter. That combination is what puts the note title
//      on the lock screen and the CarPlay Now Playing screen, and makes
//      steering-wheel / lock-screen play-pause-skip work with the phone
//      put away. Interruptions (calls, nav prompts) pause and auto-resume.
//
// Sibling of modules/speech-follow — same expo-modules DSL, same event style.

import ExpoModulesCore
import AVFoundation
import MediaPlayer

public class SpeechPlayerModule: Module {
  // Playback
  private var player: AVPlayer?
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var interruptionObserver: NSObjectProtocol?
  private var routeObserver: NSObjectProtocol?
  private var loop = false
  private var playbackRate: Float = 1.0
  private var currentTitle = ""
  private var duration: Double = 0
  private var commandsRegistered = false

  // Synthesis (retained for the duration of a write pass)
  private var synthesizer: AVSpeechSynthesizer?
  private var synthFile: AVAudioFile?
  private var synthChunks: [String] = []
  private var synthChunkIndex = 0
  private var synthVoiceId: String?
  private var synthRate: Float = AVSpeechUtteranceDefaultSpeechRate
  private var synthFrames: AVAudioFramePosition = 0
  private var synthSampleRate: Double = 22050
  private var synthURL: URL?
  private var synthPromise: Promise?

  public func definition() -> ModuleDefinition {
    Name("SpeechPlayer")

    Events("onProgress", "onState", "onError")

    // ── Voices ──
    // English voices, best quality first. quality: 3 premium, 2 enhanced, 1 default.
    AsyncFunction("getVoices") { () -> [[String: Any]] in
      let voices = AVSpeechSynthesisVoice.speechVoices()
        .filter { $0.language.hasPrefix("en") }
        .map { v -> [String: Any] in
          let quality: Int
          switch v.quality {
          case .premium: quality = 3
          case .enhanced: quality = 2
          default: quality = 1
          }
          return ["id": v.identifier, "name": v.name, "language": v.language, "quality": quality]
        }
        .sorted { ($0["quality"] as! Int, $0["name"] as! String) > ($1["quality"] as! Int, $1["name"] as! String) }
      return voices
    }

    // ── Synthesis ──
    // Renders `text` to an .m4a at `path` (absolute, from JS's cache scheme).
    // rate is AVSpeechUtterance rate (0..1); JS maps the WPM setting onto it.
    // Resolves { uri, duration } when the file is complete.
    AsyncFunction("synthesizeToFile") { (text: String, path: String, options: [String: Any], promise: Promise) in
      DispatchQueue.main.async {
        guard self.synthPromise == nil else {
          promise.reject("E_BUSY", "A synthesis is already in progress")
          return
        }
        let url = URL(fileURLWithPath: path.replacingOccurrences(of: "file://", with: ""))
        do {
          try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
          if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
          }
        } catch {
          promise.reject("E_FILE", "Could not prepare output file: \(error.localizedDescription)")
          return
        }

        // Paragraph-chunked: one giant utterance is where long-text synthesis
        // gets flaky; per-paragraph utterances written to one file is robust,
        // and postUtteranceDelay gives natural paragraph pauses for free.
        let chunks = text
          .components(separatedBy: "\n\n")
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
          .filter { !$0.isEmpty }
        guard !chunks.isEmpty else {
          promise.reject("E_EMPTY", "Nothing to synthesize")
          return
        }

        self.synthChunks = chunks
        self.synthChunkIndex = 0
        self.synthVoiceId = options["voiceId"] as? String
        self.synthRate = (options["rate"] as? Double).map { Float($0) } ?? AVSpeechUtteranceDefaultSpeechRate
        self.synthFile = nil
        self.synthFrames = 0
        self.synthURL = url
        self.synthPromise = promise
        self.synthesizer = AVSpeechSynthesizer()
        self.writeNextChunk()
      }
    }

    // ── Playback ──
    AsyncFunction("load") { (uri: String, title: String, promise: Promise) in
      DispatchQueue.main.async {
        do {
          try self.teardownPlayer(deactivateSession: false)
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.playback, mode: .spokenAudio)
          try session.setActive(true)

          let url = URL(fileURLWithPath: uri.replacingOccurrences(of: "file://", with: ""))
          let item = AVPlayerItem(url: url)
          let p = AVPlayer(playerItem: item)
          p.actionAtItemEnd = .pause
          self.player = p
          self.currentTitle = title
          self.duration = CMTimeGetSeconds(AVURLAsset(url: url).duration)

          self.installObservers()
          self.registerRemoteCommands()
          self.pushNowPlaying(playing: false)
          promise.resolve(["duration": self.duration])
        } catch {
          self.sendEvent("onError", ["message": error.localizedDescription])
          promise.reject("E_LOAD", error.localizedDescription)
        }
      }
    }

    Function("play") {
      DispatchQueue.main.async {
        guard let p = self.player else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        p.rate = self.playbackRate
        self.pushNowPlaying(playing: true)
        self.sendEvent("onState", ["state": "playing"])
      }
    }

    Function("pause") {
      DispatchQueue.main.async {
        self.player?.pause()
        self.pushNowPlaying(playing: false)
        self.sendEvent("onState", ["state": "paused"])
      }
    }

    Function("seekTo") { (seconds: Double) in
      DispatchQueue.main.async {
        guard let p = self.player else { return }
        let wasPlaying = p.rate > 0
        p.seek(to: CMTime(seconds: max(0, seconds), preferredTimescale: 600)) { _ in
          if wasPlaying { p.rate = self.playbackRate }
          self.pushNowPlaying(playing: wasPlaying)
        }
      }
    }

    Function("setLoop") { (value: Bool) in
      self.loop = value
    }

    // Playback speed on top of the synthesized rate (1.0 = as rendered).
    Function("setPlaybackRate") { (value: Double) in
      DispatchQueue.main.async {
        self.playbackRate = Float(max(0.5, min(2.0, value)))
        if let p = self.player, p.rate > 0 { p.rate = self.playbackRate }
        self.pushNowPlaying(playing: (self.player?.rate ?? 0) > 0)
      }
    }

    // Stop releases the audio session so the user's music can resume.
    Function("stop") {
      DispatchQueue.main.async {
        try? self.teardownPlayer(deactivateSession: true)
        self.sendEvent("onState", ["state": "stopped"])
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        try? self.teardownPlayer(deactivateSession: true)
        self.synthesizer?.stopSpeaking(at: .immediate)
        self.synthesizer = nil
      }
    }
  }

  // ── Synthesis internals ──

  private func writeNextChunk() {
    guard let promise = synthPromise else { return }
    guard synthChunkIndex < synthChunks.count else {
      finishSynthesis(promise: promise)
      return
    }

    let utterance = AVSpeechUtterance(string: synthChunks[synthChunkIndex])
    utterance.rate = synthRate
    utterance.postUtteranceDelay = 0.35   // paragraph breath
    if let id = synthVoiceId, let voice = AVSpeechSynthesisVoice(identifier: id) {
      utterance.voice = voice
    }
    synthChunkIndex += 1

    synthesizer?.write(utterance) { [weak self] buffer in
      guard let self = self else { return }
      guard let pcm = buffer as? AVAudioPCMBuffer else { return }
      if pcm.frameLength == 0 {
        // Utterance complete — next paragraph (async: write's callback
        // arrives on an internal queue; hop to main for our state).
        DispatchQueue.main.async { self.writeNextChunk() }
        return
      }
      do {
        if self.synthFile == nil {
          // Create the file lazily from the first buffer's format, encoding
          // to AAC (.m4a) so a 30-minute sermon is ~15 MB, not 150.
          self.synthSampleRate = pcm.format.sampleRate
          let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: pcm.format.sampleRate,
            AVNumberOfChannelsKey: pcm.format.channelCount,
            AVEncoderBitRateKey: 64000,
          ]
          self.synthFile = try AVAudioFile(
            forWriting: self.synthURL!,
            settings: settings,
            commonFormat: pcm.format.commonFormat,
            interleaved: pcm.format.isInterleaved)
        }
        try self.synthFile?.write(from: pcm)
        self.synthFrames += AVAudioFramePosition(pcm.frameLength)
      } catch {
        DispatchQueue.main.async {
          self.synthPromise?.reject("E_WRITE", "Audio write failed: \(error.localizedDescription)")
          self.resetSynthesis()
        }
      }
    }
  }

  private func finishSynthesis(promise: Promise) {
    let seconds = synthSampleRate > 0 ? Double(synthFrames) / synthSampleRate : 0
    let uri = synthURL?.absoluteString ?? ""
    resetSynthesis()
    promise.resolve(["uri": uri, "duration": seconds])
  }

  private func resetSynthesis() {
    synthFile = nil
    synthChunks = []
    synthChunkIndex = 0
    synthFrames = 0
    synthURL = nil
    synthPromise = nil
    synthesizer = nil
  }

  // ── Playback internals ──

  private func installObservers() {
    guard let p = player else { return }

    timeObserver = p.addPeriodicTimeObserver(
      forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main
    ) { [weak self] time in
      guard let self = self else { return }
      let elapsed = CMTimeGetSeconds(time)
      self.sendEvent("onProgress", ["elapsed": elapsed, "duration": self.duration])
      // Keep the lock screen / CarPlay scrubber honest without a full push.
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
    }

    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      if self.loop {
        self.player?.seek(to: .zero)
        self.player?.rate = self.playbackRate
        self.pushNowPlaying(playing: true)
      } else {
        self.player?.seek(to: .zero)
        self.pushNowPlaying(playing: false)
        self.sendEvent("onState", ["state": "finished"])
      }
    }

    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self = self,
            let info = note.userInfo,
            let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
      switch type {
      case .began:
        self.pushNowPlaying(playing: false)
        self.sendEvent("onState", ["state": "paused"])
      case .ended:
        let optRaw = (info[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
        if AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
          self.player?.rate = self.playbackRate
          self.pushNowPlaying(playing: true)
          self.sendEvent("onState", ["state": "playing"])
        }
      @unknown default: break
      }
    }

    // Headphones/CarPlay unplugged → pause (the polite audio-app behavior).
    routeObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard let self = self,
            let info = note.userInfo,
            let reasonRaw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: reasonRaw) == .oldDeviceUnavailable else { return }
      self.player?.pause()
      self.pushNowPlaying(playing: false)
      self.sendEvent("onState", ["state": "paused"])
    }
  }

  private func registerRemoteCommands() {
    guard !commandsRegistered else { return }
    commandsRegistered = true
    let center = MPRemoteCommandCenter.shared()

    center.playCommand.addTarget { [weak self] _ in
      guard let self = self, self.player != nil else { return .noActionableNowPlayingItem }
      self.player?.rate = self.playbackRate
      self.pushNowPlaying(playing: true)
      self.sendEvent("onState", ["state": "playing"])
      return .success
    }
    center.pauseCommand.addTarget { [weak self] _ in
      self?.player?.pause()
      self?.pushNowPlaying(playing: false)
      self?.sendEvent("onState", ["state": "paused"])
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self = self, let p = self.player else { return .noActionableNowPlayingItem }
      if p.rate > 0 {
        p.pause(); self.pushNowPlaying(playing: false)
        self.sendEvent("onState", ["state": "paused"])
      } else {
        p.rate = self.playbackRate; self.pushNowPlaying(playing: true)
        self.sendEvent("onState", ["state": "playing"])
      }
      return .success
    }
    center.skipBackwardCommand.isEnabled = true
    center.skipBackwardCommand.preferredIntervals = [15]
    center.skipBackwardCommand.addTarget { [weak self] _ in
      guard let self = self, let p = self.player else { return .noActionableNowPlayingItem }
      let t = max(0, CMTimeGetSeconds(p.currentTime()) - 15)
      p.seek(to: CMTime(seconds: t, preferredTimescale: 600))
      return .success
    }
    center.skipForwardCommand.isEnabled = true
    center.skipForwardCommand.preferredIntervals = [15]
    center.skipForwardCommand.addTarget { [weak self] _ in
      guard let self = self, let p = self.player else { return .noActionableNowPlayingItem }
      let t = min(self.duration, CMTimeGetSeconds(p.currentTime()) + 15)
      p.seek(to: CMTime(seconds: t, preferredTimescale: 600))
      return .success
    }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let self = self, let p = self.player,
            let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      p.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 600))
      return .success
    }
  }

  private func unregisterRemoteCommands() {
    guard commandsRegistered else { return }
    commandsRegistered = false
    let center = MPRemoteCommandCenter.shared()
    [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
     center.skipBackwardCommand, center.skipForwardCommand,
     center.changePlaybackPositionCommand].forEach { $0.removeTarget(nil) }
  }

  private func pushNowPlaying(playing: Bool) {
    let elapsed = player.map { CMTimeGetSeconds($0.currentTime()) } ?? 0
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: currentTitle.isEmpty ? "Podium Notes" : currentTitle,
      MPMediaItemPropertyArtist: "Podium Notes",
      MPMediaItemPropertyPlaybackDuration: duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? Double(playbackRate) : 0.0,
    ]
  }

  private func teardownPlayer(deactivateSession: Bool) throws {
    if let obs = timeObserver { player?.removeTimeObserver(obs); timeObserver = nil }
    if let obs = endObserver { NotificationCenter.default.removeObserver(obs); endObserver = nil }
    if let obs = interruptionObserver { NotificationCenter.default.removeObserver(obs); interruptionObserver = nil }
    if let obs = routeObserver { NotificationCenter.default.removeObserver(obs); routeObserver = nil }
    player?.pause()
    player = nil
    unregisterRemoteCommands()
    if deactivateSession {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      // notifyOthersOnDeactivation is what lets the user's music pick back up.
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}
