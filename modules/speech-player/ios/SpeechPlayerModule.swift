// File: SpeechPlayerModule.swift → ~/Projects/podiumnotes/modules/speech-player/ios/SpeechPlayerModule.swift
//
// Listen mode's native core. Two halves:
//
//   1. SYNTHESIS — renders a note's text to an .m4a file ONCE, chunked by
//      paragraph so arbitrarily long speeches render reliably. TWO engines
//      share that contract and produce identical paragraph → time marks:
//        • AVSpeechSynthesizer.write — always available, no assets, default
//        • Supertonic 3 (SupertonicEngine.swift) — neural, far better voice,
//          needs an ONNX model directory whose path JS supplies per call
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
  private var synthChunkOffsets: [Int] = []
  private var synthMarks: [[String: Any]] = []
  private var synthChunkIndex = 0
  private var synthVoiceId: String?
  private var synthRate: Float = AVSpeechUtteranceDefaultSpeechRate
  private var synthFrames: AVAudioFramePosition = 0
  private var synthSampleRate: Double = 22050
  private var synthURL: URL?
  private var synthPromise: Promise?

  // Supertonic backend — created lazily, since building ORTEnv costs
  // something and most sessions never touch it.
  private var supertonic: SupertonicEngine?

  // ── Progressive playback state ──
  // One AVMutableComposition grows as segments land. Keeping a single
  // composition (rather than a queue of items) means currentTime, duration,
  // seekTo, Now Playing and the remote commands all keep working on one
  // global timeline exactly as they do for a normal single-file load.
  private var composition: AVMutableComposition?
  private var compTrack: AVMutableCompositionTrack?
  private var segmentBounds: [Double] = []   // cumulative end time of each appended segment
  private var gapBounds: [Double] = []       // …of only those that end with silence
  private var pendingSegments: [(url: URL, duration: Double, endsParagraph: Bool)] = []
  private var renderedDuration: Double = 0   // audio appended AND composed so far
  private var estimatedDuration: Double = 0  // word-count guess, until the render finishes
  private var renderComplete = false
  private var swapInFlight = false
  private var segmentGap: Double = 0.35

  // Renders are cancelled at the next PARAGRAPH boundary, not instantly, so a
  // cancelled render keeps firing callbacks for a while. Without a token
  // those late callbacks append the OLD voice's segments into the NEW
  // composition — which is exactly how switching voices produced the right
  // label and the wrong audio. Every callback checks it still owns the job.
  private var progressiveGen = 0

  // True when playback ran off the end of the composed audio mid-render.
  // The play head is parked at the buffer edge waiting for more; the next
  // append resumes it.
  private var underrun = false
  private var lastSegmentAt: CFAbsoluteTime = 0

  // Swapping the player item is never free: it costs a brief audio seam and
  // a settling period where currentTime is unreliable. So swap RARELY — the
  // composition usually finishes rendering long before playback needs it, so
  // one or two swaps cover an entire note.
  //
  // SWAP_WINDOW  — start looking for a paragraph gap once the item has this
  //                little left. Waiting for silence is only worth it here.
  // SWAP_URGENT  — swap now, gap or not; running out is worse than a seam.
  private let SWAP_WINDOW: Double = 30
  private let SWAP_URGENT: Double = 8

  /// Progress ticks are unreliable for a moment after a swap — currentTime
  /// can report near zero before the seek settles, which reaches the UI as
  /// the scrubber flicking back to the start.
  private var suppressProgressUntil: CFAbsoluteTime = 0

  private func supertonicEngine() throws -> SupertonicEngine {
    if let e = supertonic { return e }
    let e = try SupertonicEngine()
    supertonic = e
    return e
  }

  public func definition() -> ModuleDefinition {
    Name("SpeechPlayer")

    Events("onProgress", "onState", "onError", "onSynthProgress")

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
        // gets flaky; per-paragraph chunks are robust, and each chunk's
        // CHARACTER OFFSET is kept so the output carries a paragraph → time
        // map. Shared with the progressive path so the two can't diverge.
        let (chunks, offsets) = Self.paragraphChunks(text)
        guard !chunks.isEmpty else {
          promise.reject("E_EMPTY", "Nothing to synthesize")
          return
        }

        // Both engines consume the same chunks/offsets — one chunking
        // implementation means the marks can't diverge between backends.
        if (options["engine"] as? String) == "supertonic" {
          self.runSupertonic(chunks: chunks, offsets: offsets, url: url,
                             options: options, promise: promise)
          return
        }

        self.synthChunks = chunks
        self.synthChunkOffsets = offsets
        self.synthMarks = []
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

    // Pre-warm: build the ONNX sessions ahead of the Listen tap. Loading
    // costs about half a second, which is dead time the user would otherwise
    // wait through before the first audio.
    AsyncFunction("prepareSynthEngine") { (modelDir: String, promise: Promise) in
      do {
        try self.supertonicEngine().prepare(modelDir: modelDir) { error in
          if let error = error {
            promise.reject("E_MODEL", "Could not load the speech model: \(error.localizedDescription)")
          } else {
            promise.resolve(true)
          }
        }
      } catch {
        promise.reject("E_MODEL", "Could not create the speech engine: \(error.localizedDescription)")
      }
    }

    AsyncFunction("unloadSynthEngine") { () -> Bool in
      self.supertonic?.unload()
      return true
    }

    // Progressive render + playback. Resolves as soon as the FIRST segment is
    // playable (typically a couple of seconds), then keeps rendering
    // underneath. At ~0.27x RTF the renderer outruns playback about four to
    // one, so the buffer only grows from there.
    AsyncFunction("beginProgressive") {
      (text: String, dir: String, base: String, title: String,
       options: [String: Any], promise: Promise) in

      guard let modelDir = options["modelDir"] as? String, !modelDir.isEmpty,
            let stylePath = options["stylePath"] as? String, !stylePath.isEmpty else {
        promise.reject("E_MODEL", "beginProgressive requires modelDir and stylePath")
        return
      }
      let steps = (options["steps"] as? Int) ?? 8
      let speed = Float((options["speed"] as? Double) ?? 1.0)
      let language = (options["language"] as? String) ?? "en"
      let startAfter = (options["startAfterSeconds"] as? Double) ?? 20.0

      let (paras, paraOffsets) = Self.paragraphChunks(text)
      let (chunks, offsets, gaps) = Self.splitLeadParagraphs(paras, paraOffsets)
      guard !chunks.isEmpty else {
        promise.reject("E_SYNTH", "Nothing to speak")
        return
      }

      let dirURL = URL(fileURLWithPath: dir.replacingOccurrences(of: "file://", with: ""))

      DispatchQueue.main.async {
        self.supertonic?.cancel()          // stop whatever was running

        do {
          try self.beginComposition(title: title, estimated: Self.estimateSeconds(text))
        } catch {
          promise.reject("E_LOAD", error.localizedDescription)
          return
        }

        // Capture the token AFTER beginComposition: it calls teardownPlayer,
        // which bumps the generation to disown the previous render's
        // in-flight callbacks. Taking the token before that would leave this
        // render's own callbacks one behind, so every one of them would
        // discard itself as superseded and the promise would never settle.
        let myGen = self.progressiveGen

        var resolved = false
        do {
          let engine = try self.supertonicEngine()
          engine.synthesizeSegments(
            chunks: chunks, offsets: offsets, dir: dirURL, base: base,
            modelDir: modelDir, stylePath: stylePath,
            steps: steps, speed: speed, language: language,
            gapSeconds: self.segmentGap, gapFlags: gaps,
            onSegment: { [weak self] index, url, duration, total in
              guard let self = self else { return }
              DispatchQueue.main.async {
                guard myGen == self.progressiveGen else { return }   // superseded
                // Wall-clock cost of this segment against the audio it
                // produced — the effective RTF, including file I/O and
                // composition work, not just inference.
                let now = CFAbsoluteTimeGetCurrent()
                let wall = self.lastSegmentAt > 0 ? now - self.lastSegmentAt : 0
                self.lastSegmentAt = now
                let rtf = duration > 0 ? wall / duration : 0

                // Where this chunk STARTS on the timeline, captured before it
                // is appended. Auto-follow needs marks as the render goes,
                // not only at the end — otherwise the text can't follow the
                // audio on a note's first play.
                //
                // The chunk's opening words travel with it rather than a
                // character offset: offsets index the SANITIZED text, while
                // the on-screen line map indexes the raw body, and
                // normalisation shifts them apart. Words survive that.
                let markTime = self.renderedDuration + self.pendingSeconds()
                let chunkText = index < chunks.count ? chunks[index] : ""
                let lead = String(chunkText.prefix(80))

                let endsPara = index < gaps.count ? gaps[index] : true
                self.enqueueSegment(url: url, duration: duration, endsParagraph: endsPara)
                // Every onSynthProgress event carries the same keys —
                // Expo's payload objects THROW on a missing property rather
                // than returning undefined, so an inconsistent shape breaks
                // the listener on the first event.
                self.sendEvent("onSynthProgress", [
                  "progress": Double(index + 1) / Double(total),
                  "chunk": index + 1,
                  "total": total,
                  "rendered": self.renderedDuration + self.pendingSeconds(),
                  "complete": false,
                  "marks": [[String: Any]](),
                  "rtf": rtf,
                  "markTime": markTime,
                  "markText": lead,
                  "endsParagraph": endsPara,
                ])
                // Hand control back to JS once there's enough buffered audio
                // to survive a thermal dip, not on the very first segment.
                if !resolved, self.renderedDuration >= startAfter || index + 1 == total {
                  resolved = true
                  promise.resolve([
                    "estimatedDuration": self.estimatedDuration,
                    "rendered": self.renderedDuration,
                  ])
                }
              }
            },
            completion: { [weak self] result in
              DispatchQueue.main.async {
                guard let self = self else { return }
                guard myGen == self.progressiveGen else { return }   // superseded
                switch result {
                case .success(let marks):
                  self.flushPending(force: true)
                  self.renderComplete = true
                  self.sendEvent("onSynthProgress", [
                    "progress": 1.0, "chunk": chunks.count, "total": chunks.count,
                    "rendered": self.renderedDuration, "complete": true,
                    "marks": marks, "rtf": 0.0,
                    "markTime": -1.0, "markText": "", "endsParagraph": true,
                  ])
                  if !resolved {
                    resolved = true
                    promise.resolve([
                      "estimatedDuration": self.estimatedDuration,
                      "rendered": self.renderedDuration,
                    ])
                  }
                case .failure(let e):
                  self.sendEvent("onError", ["message": e.localizedDescription])
                  if !resolved { resolved = true; promise.reject("E_SYNTH", e.localizedDescription) }
                }
              }
            }
          )
        } catch {
          promise.reject("E_MODEL", error.localizedDescription)
        }
      }
    }

    // Where the bundled speech model lives.
    //
    // The model ships INSIDE the app now (copied in at build time by
    // plugins/withSpeechModel.js), so only native code knows the path — JS
    // can't compute a bundle location. Returning it here keeps the existing
    // arrangement intact: JS still owns which paths get passed to
    // synthesis, it just asks where they are first.
    //
    // Empty strings rather than nulls: the bridge handles them more
    // predictably, and the caller only needs a truthiness check.
    Function("bundledModelPaths") { () -> [String: String] in
      guard let base = Bundle.main.resourceURL else {
        return ["modelDir": "", "styleDir": ""]
      }
      let onnx = base.appendingPathComponent("onnx")
      let styles = base.appendingPathComponent("voice_styles")
      let fm = FileManager.default
      // Check the config AND the largest weight file: a truncated copy would
      // otherwise pass as present and fail later inside ONNX.
      let ok = fm.fileExists(atPath: onnx.appendingPathComponent("tts.json").path)
        && fm.fileExists(atPath: onnx.appendingPathComponent("vector_estimator.onnx").path)
        && fm.fileExists(atPath: styles.appendingPathComponent("M1.json").path)
      if !ok {
        NSLog("[SpeechPlayer] bundled model missing under \(base.path)")
        return ["modelDir": "", "styleDir": ""]
      }
      return ["modelDir": onnx.path, "styleDir": styles.path]
    }

    Function("cancelProgressive") {
      self.supertonic?.cancel()
    }

    // Render segments to disk WITHOUT touching playback — the head start.
    //
    // A note opened in the presenter renders its opening ~20s in the
    // background, so tapping Listen later finds audio already waiting and
    // starts instantly. Stops as soon as the budget is met: rendering a whole
    // sermon nobody asked to hear would cost battery and, per the thermal
    // soak, real heat.
    //
    // Segments are the same files beginProgressive writes and are reused
    // rather than re-rendered, so this is literally the same render stopped
    // early.
    AsyncFunction("renderSegments") {
      (text: String, dir: String, base: String, options: [String: Any], promise: Promise) in

      guard let modelDir = options["modelDir"] as? String, !modelDir.isEmpty,
            let stylePath = options["stylePath"] as? String, !stylePath.isEmpty else {
        promise.reject("E_MODEL", "renderSegments requires modelDir and stylePath")
        return
      }
      let steps = (options["steps"] as? Int) ?? 8
      let speed = Float((options["speed"] as? Double) ?? 1.0)
      let language = (options["language"] as? String) ?? "en"
      let budget = (options["maxSeconds"] as? Double) ?? 20.0

      // Same split as beginProgressive — the head start must produce the
      // SAME segment files, or they'd be re-rendered instead of reused.
      let (paras, paraOffsets) = Self.paragraphChunks(text)
      let (chunks, offsets, gaps) = Self.splitLeadParagraphs(paras, paraOffsets)
      guard !chunks.isEmpty else {
        promise.resolve(["rendered": 0.0, "complete": true, "segments": 0])
        return
      }

      let dirURL = URL(fileURLWithPath: dir.replacingOccurrences(of: "file://", with: ""))
      var rendered = 0.0
      var count = 0

      do {
        let engine = try self.supertonicEngine()
        engine.synthesizeSegments(
          chunks: chunks, offsets: offsets, dir: dirURL, base: base,
          modelDir: modelDir, stylePath: stylePath,
          steps: steps, speed: speed, language: language,
          gapSeconds: self.segmentGap, gapFlags: gaps,
          onSegment: { index, _, duration, total in
            rendered += duration
            count = index + 1
            // Budget met — stop at the next paragraph boundary.
            if rendered >= budget && index + 1 < total {
              engine.cancel()
            }
          },
          completion: { result in
            DispatchQueue.main.async {
              switch result {
              case .success:
                promise.resolve([
                  "rendered": rendered,
                  "segments": count,
                  "complete": count >= chunks.count,
                ])
              case .failure(let e):
                promise.reject("E_SYNTH", e.localizedDescription)
              }
            }
          }
        )
      } catch {
        promise.reject("E_MODEL", error.localizedDescription)
      }
    }

    // ── Playback ──
    AsyncFunction("load") { (uri: String, title: String, promise: Promise) in
      DispatchQueue.main.async {
        do {
          try self.teardownPlayer(deactivateSession: false)
          self.configureAudioSession()

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

    // Mark this paragraph's start time before rendering it.
    let markTime = synthSampleRate > 0 ? Double(synthFrames) / synthSampleRate : 0
    synthMarks.append(["offset": synthChunkOffsets[synthChunkIndex], "time": markTime])

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


  /// Split on blank lines, keeping each paragraph's character offset in the
  /// source text. Offsets index whatever string is passed in — for Listen
  /// mode that's the SANITIZED text, which is what the JS marks reader uses.
  /// Split the opening paragraphs into sentences.
  ///
  /// Two different things are being tuned here. TIME-TO-FIRST-AUDIO depends
  /// only on chunk one, so the first chunk wants to be short. UNDERRUN RISK
  /// depends on whether the next chunk renders faster than the buffer
  /// drains — so the chunks right after the start want to be short too,
  /// letting the buffer climb from a small beginning instead of needing to
  /// be large before playback can safely start.
  ///
  /// Later chunks stay paragraph-sized: by then the buffer is far ahead, and
  /// paragraphs give the synthesizer better prosody.
  ///
  /// Returns a gap flag per chunk — only chunks that genuinely END a
  /// paragraph get trailing silence, so split sentences read continuously.
  static func splitLeadParagraphs(_ chunks: [String], _ offsets: [Int],
                                  paragraphsToSplit: Int = 4,
                                  minSentenceChars: Int = 40)
    -> ([String], [Int], [Bool]) {
    var outChunks: [String] = []
    var outOffsets: [Int] = []
    var outGaps: [Bool] = []

    for (i, para) in chunks.enumerated() {
      guard i < paragraphsToSplit else {
        outChunks.append(para); outOffsets.append(offsets[i]); outGaps.append(true)
        continue
      }
      let pieces = sentencePieces(para, minChars: minSentenceChars)
      if pieces.count <= 1 {
        outChunks.append(para); outOffsets.append(offsets[i]); outGaps.append(true)
        continue
      }
      for (j, piece) in pieces.enumerated() {
        outChunks.append(piece.text)
        outOffsets.append(offsets[i] + piece.offset)
        outGaps.append(j == pieces.count - 1)   // silence only at the real end
      }
    }
    return (outChunks, outOffsets, outGaps)
  }

  /// Sentence boundaries at least `minChars` apart, so "Dr." and "3:16"
  /// don't each become their own chunk.
  private static func sentencePieces(_ text: String, minChars: Int)
    -> [(text: String, offset: Int)] {
    var pieces: [(String, Int)] = []
    var segStart = text.startIndex
    var idx = text.startIndex
    while idx < text.endIndex {
      let ch = text[idx]
      if ch == "." || ch == "!" || ch == "?" {
        let after = text.index(after: idx)
        let runLen = text.distance(from: segStart, to: after)
        if runLen >= minChars, after < text.endIndex, text[after] == " " {
          let piece = String(text[segStart..<after]).trimmingCharacters(in: .whitespaces)
          if !piece.isEmpty {
            pieces.append((piece, text.distance(from: text.startIndex, to: segStart)))
          }
          segStart = text.index(after: after)
          idx = segStart
          continue
        }
      }
      idx = text.index(after: idx)
    }
    let tail = String(text[segStart...]).trimmingCharacters(in: .whitespaces)
    if !tail.isEmpty {
      pieces.append((tail, text.distance(from: text.startIndex, to: segStart)))
    }
    return pieces.map { (text: $0.0, offset: $0.1) }
  }

  static func paragraphChunks(_ text: String) -> ([String], [Int]) {
    var chunks: [String] = []
    var offsets: [Int] = []
    var searchStart = text.startIndex
    for piece in text.components(separatedBy: "\n\n") {
      let trimmed = piece.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }
      if let r = text.range(of: trimmed, range: searchStart..<text.endIndex) {
        chunks.append(trimmed)
        offsets.append(text.distance(from: text.startIndex, to: r.lowerBound))
        searchStart = r.upperBound
      } else {
        chunks.append(trimmed)
        offsets.append(offsets.last ?? 0)
      }
    }
    return (chunks, offsets)
  }

  /// The end-of-item notification is bound to a specific AVPlayerItem, so a
  /// composition swap orphans it. Rebind without disturbing the periodic
  /// time observer, which belongs to the player and survives.
  private func reinstallItemObservers() { installEndObserver() }

  /// End-of-item means two very different things depending on whether the
  /// render has finished, and getting it wrong is what made playback reset
  /// to the start after the first paragraph.
  private func installEndObserver() {
    if let obs = endObserver { NotificationCenter.default.removeObserver(obs); endObserver = nil }
    guard let p = player else { return }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      // Mid-render this is a BUFFER UNDERRUN, not the end of the speech.
      // Park at the buffer edge and wait — the next appended segment
      // resumes playback from here.
      if !self.renderComplete {
        self.underrun = true
        self.pushNowPlaying(playing: false)
        self.sendEvent("onState", ["state": "buffering"])
        return
      }
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
  }

  // MARK: - Progressive composition
  //
  // Appending audio to a playing AVPlayer means handing it a NEW AVPlayerItem,
  // because an item snapshots its asset. Done carelessly that's an audible
  // seam every time. Two things avoid it:
  //
  //   1. Segments are batched — we only swap when the play head is getting
  //      close to the end of what's composed, not once per paragraph.
  //   2. The swap is timed to land inside a paragraph gap. Each segment
  //      carries 0.35s of trailing silence and we know every boundary, so a
  //      sub-100ms swap inside that window is inaudible.

  private func beginComposition(title: String, estimated: Double) throws {
    try teardownPlayer(deactivateSession: false)
    // Session setup is BEST EFFORT, not a precondition. On iOS it always
    // succeeds; for an iOS app running on Apple Silicon macOS, AVAudioSession
    // is present but not fully functional, and a throw here would turn
    // "background audio category unavailable" into "playback failed" — the
    // audio itself plays fine without it.
    configureAudioSession()

    let comp = AVMutableComposition()
    guard let track = comp.addMutableTrack(
      withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
      throw NSError(domain: "SpeechPlayer", code: -10,
                    userInfo: [NSLocalizedDescriptionKey: "Could not create an audio track"])
    }
    composition = comp
    compTrack = track
    segmentBounds = []
    gapBounds = []
    pendingSegments = []
    renderedDuration = 0
    renderComplete = false
    swapInFlight = false
    underrun = false
    suppressProgressUntil = 0
    lastSegmentAt = CFAbsoluteTimeGetCurrent()
    estimatedDuration = estimated
    currentTitle = title
    duration = estimated
    player = nil
  }

  private func pendingSeconds() -> Double {
    return pendingSegments.reduce(0) { $0 + $1.duration }
  }

  /// Queue a finished segment. The first batch starts playback; later ones
  /// wait for a safe moment.
  private func enqueueSegment(url: URL, duration segDuration: Double, endsParagraph: Bool) {
    pendingSegments.append((url, segDuration, endsParagraph))
    if player == nil {
      flushPending(force: true)   // nothing playing yet — no seam to hide
      if composition != nil, renderedDuration > 0 { buildPlayer() }
    } else {
      flushPending(force: false)
    }
  }

  /// Move pending segments into the composition. `force` skips the
  /// "is it worth swapping yet" check.
  private func flushPending(force: Bool) {
    guard let comp = composition, let track = compTrack, !pendingSegments.isEmpty else { return }

    let headroom = renderedDuration - currentElapsed()
    // Don't churn: swap only when the buffer ahead of the play head is
    // getting thin, or when the caller insists. Only applies once audio is
    // actually playing — before that, holding segments back would stall
    // renderedDuration and a resume point beyond 45s could never be reached.
    let isPlaying = (player?.rate ?? 0) > 0
    if !force, player != nil, isPlaying, !underrun, headroom > 45 { return }

    var appended = false
    for seg in pendingSegments {
      let asset = AVURLAsset(url: seg.url)
      guard let src = asset.tracks(withMediaType: .audio).first else { continue }
      let range = CMTimeRange(start: .zero, duration: asset.duration)
      do {
        try track.insertTimeRange(range, of: src, at: comp.duration)
        renderedDuration = CMTimeGetSeconds(comp.duration)
        segmentBounds.append(renderedDuration)
        // Only a real paragraph end gives us silence to hide a swap in.
        if seg.endsParagraph { gapBounds.append(renderedDuration) }
        appended = true
      } catch {
        sendEvent("onError", ["message": "Could not append audio segment: \(error.localizedDescription)"])
      }
    }
    pendingSegments.removeAll()
    guard appended, player != nil else { return }
    scheduleSwap()
  }

  private func buildPlayer() {
    guard let comp = composition, let snapshot = comp.copy() as? AVComposition else { return }
    let item = AVPlayerItem(asset: snapshot)
    let p = AVPlayer(playerItem: item)
    p.actionAtItemEnd = .pause
    player = p
    duration = max(renderedDuration, estimatedDuration)
    installObservers()
    registerRemoteCommands()
    pushNowPlaying(playing: false)
  }

  /// Swap in a player item that includes the newly appended audio, waiting
  /// for a paragraph gap so the transition falls in silence.
  private func scheduleSwap() {
    guard !swapInFlight, let p = player, let comp = composition,
          let snapshot = comp.copy() as? AVComposition else { return }
    swapInFlight = true

    // After an underrun the rate is 0 but the user never paused — resuming
    // is exactly what they're waiting for.
    let resume = p.rate > 0 || underrun
    let at = p.currentTime()

    // Prefer to swap inside a paragraph gap, where the seam is inaudible —
    // but only while there's time to wait for one.
    //
    // What matters is audio left in the CURRENT ITEM, not in the
    // composition. The item is a snapshot; playback stops at ITS end even
    // when the composition holds minutes more. Measuring the composition
    // let the item run dry between sparse paragraph gaps, and the
    // end-of-item handler then read that as the end of the speech and
    // jumped back to the start.
    let remaining = itemRemaining(from: at)
    if resume, !underrun, remaining > SWAP_URGENT,
       !isInParagraphGap(CMTimeGetSeconds(at)) {
      swapInFlight = false
      return
    }

    let item = AVPlayerItem(asset: snapshot)
    // Seek the item BEFORE it goes live; replaceCurrentItem on an already
    // positioned item is near-instant.
    item.seek(to: at, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      guard let self = self else { return }
      DispatchQueue.main.async {
        p.replaceCurrentItem(with: item)
        self.duration = self.renderComplete ? self.renderedDuration
                                            : max(self.renderedDuration, self.estimatedDuration)
        self.reinstallItemObservers()
        let wasUnderrun = self.underrun
        self.swapInFlight = false
        // Hold progress reporting briefly: currentTime is unreliable while
        // the new item settles, and a near-zero reading reaches the UI as a
        // scrubber flash.
        self.suppressProgressUntil = CFAbsoluteTimeGetCurrent() + 0.8
        if resume {
          // A freshly swapped item is not readyToPlay yet, and setting rate
          // on a player whose item isn't ready is silently DROPPED. That is
          // why playback used to sit still after an underrun until the user
          // tapped play: the audio and position were both correct, the rate
          // assignment just never took. Confirm it actually started.
          self.startPlayback(p, announce: wasUnderrun)
        } else {
          self.pushNowPlaying(playing: false)
        }
      }
    }
  }

  /// Set the rate and VERIFY it took, retrying briefly while the item
  /// becomes ready. Returns via Now Playing and, for a recovery from an
  /// underrun, an onState event so the UI can drop "Catching up…".
  private func startPlayback(_ p: AVPlayer, announce: Bool, attempt: Int = 0) {
    p.rate = playbackRate
    if p.rate > 0 {
      if announce || underrun {
        underrun = false
        sendEvent("onState", ["state": "playing"])
      }
      pushNowPlaying(playing: true)
      return
    }
    guard attempt < 12 else {          // ~2.4s; something else is wrong
      pushNowPlaying(playing: false)
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      guard let self = self, self.player === p else { return }
      self.startPlayback(p, announce: announce, attempt: attempt + 1)
    }
  }

  /// Ask for the playback category, ignoring failure. See beginComposition.
  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio)
      try session.setActive(true)
    } catch {
      NSLog("[SpeechPlayer] audio session unavailable: \(error.localizedDescription)")
    }
  }

  /// Seconds of audio left in the item currently loaded in the player.
  private func itemRemaining(from at: CMTime) -> Double {
    guard let item = player?.currentItem else { return 0 }
    let dur = CMTimeGetSeconds(item.duration)
    guard dur.isFinite, dur > 0 else { return .greatestFiniteMagnitude }
    return dur - CMTimeGetSeconds(at)
  }

  /// Does the composition hold audio that the current item doesn't?
  private func itemIsStale() -> Bool {
    guard let item = player?.currentItem else { return false }
    let dur = CMTimeGetSeconds(item.duration)
    guard dur.isFinite else { return false }
    return renderedDuration > dur + 0.25
  }

  /// Runs on every progress tick: append whatever's waiting, and refresh the
  /// player item before it runs out. Without this a finished render could
  /// sit fully composed while the player still held an early snapshot.
  private func maintainPlayback(elapsed: Double) {
    if !pendingSegments.isEmpty { flushPending(force: false) }
    guard !swapInFlight, itemIsStale(), let p = player else { return }
    let remaining = itemRemaining(from: p.currentTime())
    // Only swap when the item is actually running low. Swapping at every
    // paragraph gap — which is what this used to do, since the item is
    // stale for most of a render — meant a seam and a scrubber flicker at
    // every paragraph for no benefit.
    if remaining <= SWAP_URGENT {
      scheduleSwap()
    } else if remaining <= SWAP_WINDOW, isInParagraphGap(elapsed) {
      scheduleSwap()
    }
  }

  /// True when `t` falls in the trailing silence of a segment.
  private func isInParagraphGap(_ t: Double) -> Bool {
    for end in gapBounds {
      if t >= end - segmentGap && t <= end + 0.05 { return true }
    }
    return false
  }

  private func currentElapsed() -> Double {
    guard let p = player else { return 0 }
    let t = CMTimeGetSeconds(p.currentTime())
    return t.isFinite ? t : 0
  }

  /// Rough duration from word count, for the scrubber before the render ends.
  /// ~153 wpm is Supertonic's measured pace at speed 1.0.
  private static func estimateSeconds(_ text: String) -> Double {
    let words = text.split{ $0 == " " || $0 == "\n" || $0 == "\t" }.count
    return Double(words) / 153.0 * 60.0
  }

  // Hand a prepared chunk list to the Supertonic backend and adapt its
  // result to the same shape AVSpeechSynthesizer's path resolves with.
  private func runSupertonic(chunks: [String], offsets: [Int], url: URL,
                             options: [String: Any], promise: Promise) {
    guard let modelDir = options["modelDir"] as? String, !modelDir.isEmpty else {
      promise.reject("E_MODEL", "engine 'supertonic' requires a modelDir")
      return
    }
    guard let stylePath = options["stylePath"] as? String, !stylePath.isEmpty else {
      promise.reject("E_MODEL", "engine 'supertonic' requires a stylePath")
      return
    }
    let steps = (options["steps"] as? Int) ?? 8
    let speed = Float((options["speed"] as? Double) ?? 1.0)
    let language = (options["language"] as? String) ?? "en"

    do {
      let engine = try supertonicEngine()
      engine.synthesize(
        chunks: chunks, offsets: offsets, to: url,
        modelDir: modelDir, stylePath: stylePath,
        steps: steps, speed: speed, language: language,
        onProgress: { [weak self] fraction, done, total in
          self?.sendEvent("onSynthProgress", [
            "progress": fraction, "chunk": done, "total": total,
          ])
        },
        completion: { [weak self] result in
          DispatchQueue.main.async {
            switch result {
            case .success(let r):
              promise.resolve(["uri": r.uri, "duration": r.duration, "marks": r.marks])
            case .failure(let e):
              self?.sendEvent("onError", ["message": e.localizedDescription])
              promise.reject("E_SYNTH", e.localizedDescription)
            }
          }
        }
      )
    } catch {
      promise.reject("E_MODEL", "Could not create the speech engine: \(error.localizedDescription)")
    }
  }

  private func finishSynthesis(promise: Promise) {
    let seconds = synthSampleRate > 0 ? Double(synthFrames) / synthSampleRate : 0
    let uri = synthURL?.absoluteString ?? ""
    let marks = synthMarks
    resetSynthesis()
    promise.resolve(["uri": uri, "duration": seconds, "marks": marks])
  }

  private func resetSynthesis() {
    synthFile = nil
    synthChunks = []
    synthChunkOffsets = []
    synthMarks = []
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
      // Drop ticks while a swap settles, or the scrubber jumps to zero and
      // back. Playback itself is unaffected.
      if CFAbsoluteTimeGetCurrent() < self.suppressProgressUntil { return }
      // Audio is moving, so any underrun is over — this also catches the
      // race where the end-of-item notice lands just after a swap.
      if self.underrun, (self.player?.rate ?? 0) > 0 {
        self.underrun = false
        self.sendEvent("onState", ["state": "playing"])
      }
      self.sendEvent("onProgress", [
        "elapsed": elapsed,
        "duration": self.duration,
        "rendered": self.renderedDuration > 0 ? self.renderedDuration : self.duration,
      ])
      self.maintainPlayback(elapsed: elapsed)
      // Keep the lock screen / CarPlay scrubber honest without a full push.
      MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
    }

    installEndObserver()

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
    supertonic?.cancel()
    progressiveGen += 1        // disown any callbacks still in flight
    composition = nil
    compTrack = nil
    segmentBounds = []
    gapBounds = []
    pendingSegments = []
    renderedDuration = 0
    estimatedDuration = 0
    renderComplete = false
    swapInFlight = false
    unregisterRemoteCommands()
    if deactivateSession {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      // notifyOthersOnDeactivation is what lets the user's music pick back up.
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }
}
