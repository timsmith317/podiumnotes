// File: SupertonicEngine.swift → ~/Projects/podiumnotes/modules/speech-player/ios/SupertonicEngine.swift
//
// Supertonic 3 (ONNX) synthesis backend for Listen mode — the second engine
// alongside AVSpeechSynthesizer.
//
// Design notes:
//
//   • MODEL FILES ARE NOT BUNDLED HERE. JS passes an absolute `modelDir` (and
//     an absolute `stylePath`) on every call, so asset delivery — bundled,
//     On-Demand Resources, or downloaded to documentDirectory — is decided
//     entirely in JavaScript and this file never changes when that changes.
//
//   • The ORT sessions cost ~0.5s to build and the voice style ~0.04s, so both
//     are cached. prepare() is the pre-warm hook: call it when a note opens in
//     the presenter and tapping Listen finds the model already resident.
//
//   • Paragraph chunking and mark offsets come from the caller so both engines
//     produce identical paragraph → time maps. Supertonic internally splits
//     long input further (chunkText in Helper.swift, 300 chars for English)
//     and inserts its own inter-chunk silence; that's below our paragraph
//     granularity and doesn't affect marks.
//
//   • `speed` is Supertonic's own synthesis-time pace control (0.7–2.0). The
//     WPM setting maps straight onto it — no post-hoc time stretching, and
//     none of the quality loss that comes from synthesizing at a slow rate.
//
//   • Everything runs on a private serial queue. Inference is synchronous and
//     CPU-heavy; on the main thread it would freeze the UI outright.
//
//   • TWO OUTPUT MODES. synthesize() writes one file and returns when the
//     whole thing is done — fine for short notes, unusable for a sermon at
//     ~7s of compute per paragraph. synthesizeSegments() writes ONE FILE PER
//     PARAGRAPH and reports each as it lands, so playback can start on the
//     first one and the rest arrive underneath it. Because RTF is ~0.27x the
//     renderer outruns playback roughly four to one, so the buffer only ever
//     grows once started.
//
//   • Segmented renders are cancellable and resumable: a segment file that
//     already exists on disk is skipped, so an interrupted render picks up
//     where it stopped instead of starting the sermon over.

import Foundation
import AVFoundation
import onnxruntime_objc

final class SupertonicEngine {
  enum EngineError: LocalizedError {
    case notLoaded
    case busy
    case badOutput(String)

    var errorDescription: String? {
      switch self {
      case .notLoaded:          return "Supertonic model is not loaded"
      case .busy:               return "A synthesis is already in progress"
      case .badOutput(let why): return why
      }
    }
  }

  /// Result of a completed render, mirroring the AVSpeechSynthesizer path.
  struct Render {
    let uri: String
    let duration: Double
    let marks: [[String: Any]]
  }

  private let env: ORTEnv
  private var tts: TextToSpeech?
  private var loadedDir: String?
  private var styles: [String: Style] = [:]
  private var running = false
  private var cancelled = false

  /// Serial by construction — one render at a time, off the main thread.
  private let queue = DispatchQueue(label: "app.podiumnotes.supertonic", qos: .userInitiated)

  init() throws {
    env = try ORTEnv(loggingLevel: .warning)
  }

  var isLoaded: Bool { queue.sync { tts != nil } }
  var isBusy: Bool { queue.sync { running } }

  // MARK: - Loading

  /// Build (or reuse) the ONNX sessions for `modelDir`. Safe to call repeatedly;
  /// only the first call for a given directory does real work.
  func prepare(modelDir: String, completion: @escaping (Error?) -> Void) {
    queue.async {
      do {
        try self.loadIfNeeded(modelDir: modelDir)
        completion(nil)
      } catch {
        completion(error)
      }
    }
  }

  private func loadIfNeeded(modelDir: String) throws {
    if loadedDir == modelDir, tts != nil { return }
    let dir = modelDir.replacingOccurrences(of: "file://", with: "")
    let loaded = try loadTextToSpeech(dir, false, env)
    tts = loaded
    loadedDir = dir
    styles.removeAll()   // styles are tied to the model that produced them
  }

  private func styleFor(path: String) throws -> Style {
    let p = path.replacingOccurrences(of: "file://", with: "")
    if let cached = styles[p] { return cached }
    let s = try loadVoiceStyle([p], verbose: false)
    styles[p] = s
    return s
  }

  /// Drop the sessions — for memory pressure or a model directory change.
  func unload() {
    queue.async {
      self.tts = nil
      self.loadedDir = nil
      self.styles.removeAll()
    }
  }

  // MARK: - Synthesis

  /// Render `chunks` (one per paragraph) to an AAC .m4a at `url`.
  ///
  /// `offsets` are the paragraph character offsets in the SANITIZED text and
  /// are copied verbatim into the marks, so the JS side's time → paragraph
  /// lookup behaves identically for both engines.
  ///
  /// `onProgress` fires on an arbitrary queue after each paragraph, with a
  /// 0…1 fraction — renders are long enough that a spinner alone is not
  /// acceptable feedback.
  func synthesize(
    chunks: [String],
    offsets: [Int],
    to url: URL,
    modelDir: String,
    stylePath: String,
    steps: Int,
    speed: Float,
    language: String,
    onProgress: @escaping (Double, Int, Int) -> Void,
    completion: @escaping (Result<Render, Error>) -> Void
  ) {
    queue.async {
      guard !self.running else {
        completion(.failure(EngineError.busy))
        return
      }
      self.running = true
      defer { self.running = false }

      do {
        try self.loadIfNeeded(modelDir: modelDir)
        guard let tts = self.tts else { throw EngineError.notLoaded }
        let style = try self.styleFor(path: stylePath)

        let sampleRate = Double(tts.sampleRate)
        var file: AVAudioFile?
        var totalFrames: AVAudioFramePosition = 0
        var marks: [[String: Any]] = []

        for (i, chunk) in chunks.enumerated() {
          // Mark the paragraph's start BEFORE rendering it, so the timestamp
          // is where playback should land to hear this paragraph from its
          // first word.
          let markTime = sampleRate > 0 ? Double(totalFrames) / sampleRate : 0
          marks.append(["offset": offsets[i], "time": markTime])

          let (samples, _) = try tts.call(chunk, language, style, steps, speed: speed)
          guard !samples.isEmpty else { continue }

          if file == nil {
            // AAC keeps a 30-minute sermon near 15 MB rather than 150.
            let settings: [String: Any] = [
              AVFormatIDKey: kAudioFormatMPEG4AAC,
              AVSampleRateKey: sampleRate,
              AVNumberOfChannelsKey: 1,
              AVEncoderBitRateKey: 64000,
            ]
            file = try AVAudioFile(
              forWriting: url,
              settings: settings,
              commonFormat: .pcmFormatFloat32,
              interleaved: false)
          }
          guard let out = file else { throw EngineError.badOutput("Could not open output file") }

          try Self.write(samples: samples, to: out)
          totalFrames += AVAudioFramePosition(samples.count)

          // A paragraph break of the same length the Apple path gets from
          // postUtteranceDelay, so the two engines pace alike.
          let gap = Int(sampleRate * 0.35)
          if i < chunks.count - 1, gap > 0 {
            try Self.write(samples: [Float](repeating: 0, count: gap), to: out)
            totalFrames += AVAudioFramePosition(gap)
          }

          onProgress(Double(i + 1) / Double(chunks.count), i + 1, chunks.count)
        }

        guard file != nil, totalFrames > 0 else {
          throw EngineError.badOutput("Synthesis produced no audio")
        }

        // Close the file before reporting success — AAC flushes on dealloc,
        // and a reader opening it too early sees a truncated file.
        file = nil

        completion(.success(Render(
          uri: url.absoluteString,
          duration: sampleRate > 0 ? Double(totalFrames) / sampleRate : 0,
          marks: marks
        )))
      } catch {
        try? FileManager.default.removeItem(at: url)   // no half-written files in the cache
        completion(.failure(error))
      }
    }
  }

  /// Ask an in-flight segmented render to stop at the next paragraph boundary.
  /// Cheap and safe to call from anywhere; the render resolves as cancelled.
  func cancel() {
    cancelled = true
  }

  /// Render one file per paragraph into `dir`, reporting each as it completes.
  ///
  /// `onSegment(index, url, duration, total)` fires on the engine queue the
  /// moment a segment is playable. The caller appends it to the composition;
  /// playback can begin as soon as the first one (or a short buffer of them)
  /// exists.
  ///
  /// Returns the full marks array. Mark times are cumulative segment
  /// durations, so they stay exact regardless of where playback started.
  func synthesizeSegments(
    chunks: [String],
    offsets: [Int],
    dir: URL,
    base: String,
    modelDir: String,
    stylePath: String,
    steps: Int,
    speed: Float,
    language: String,
    gapSeconds: Double = 0.35,
    /// Per-chunk: does this chunk END a paragraph? Only those get trailing
    /// silence. Sentence-sized chunks inside one paragraph must run together
    /// or the opening sounds stilted. Empty means "every chunk ends one".
    gapFlags: [Bool] = [],
    /// First chunk to render. Everything before it is left alone — its
    /// segments stay on disk and are reused if playback returns there.
    ///
    /// This is what lets a scrub land ahead of the render: the text is the
    /// source, so audio for any paragraph can be made on demand. There is no
    /// requirement that a render start at the beginning; it only ever did
    /// because "press play and listen through" was the only entry point.
    startIndex: Int = 0,
    onSegment: @escaping (Int, URL, Double, Int) -> Void,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    queue.async {
      guard !self.running else {
        completion(.failure(EngineError.busy))
        return
      }
      self.running = true
      self.cancelled = false
      defer { self.running = false }

      do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try self.loadIfNeeded(modelDir: modelDir)
        guard let tts = self.tts else { throw EngineError.notLoaded }
        let style = try self.styleFor(path: stylePath)

        let sampleRate = Double(tts.sampleRate)
        var marks: [[String: Any]] = []
        // Composition-relative: the first chunk rendered sits at 0 in the
        // composition, whatever its position in the note. SpeechPlayerModule
        // holds the note-time offset.
        var elapsed = 0.0

        let first = max(0, min(startIndex, chunks.count))
        for i in first..<chunks.count {
          let chunk = chunks[i]
          if self.cancelled { break }

          marks.append(["offset": offsets[i], "time": elapsed])
          let url = dir.appendingPathComponent(Self.segmentName(base: base, index: i))

          // Resume: a segment already on disk is reused rather than redone.
          // This is what makes an interrupted sermon cheap to restart.
          if let existing = Self.durationOf(url), existing > 0 {
            elapsed += existing
            onSegment(i, url, existing, chunks.count)
            continue
          }

          let (samples, _) = try tts.call(chunk, language, style, steps, speed: speed)
          guard !samples.isEmpty else { continue }

          let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64000,
          ]
          var file: AVAudioFile? = try AVAudioFile(
            forWriting: url, settings: settings,
            commonFormat: .pcmFormatFloat32, interleaved: false)
          guard let out = file else { throw EngineError.badOutput("Could not open \(url.lastPathComponent)") }

          try Self.write(samples: samples, to: out)
          var frames = samples.count

          // The paragraph gap is baked into the END of each segment, not
          // inserted between them at playback time. That keeps the pause
          // intact however the segments are assembled, and — because the
          // composition can only be swapped during silence without an audible
          // seam — it is also where item swaps get hidden.
          let endsParagraph = gapFlags.isEmpty || (i < gapFlags.count && gapFlags[i])
          let gap = Int(sampleRate * gapSeconds)
          if i < chunks.count - 1, endsParagraph, gap > 0 {
            try Self.write(samples: [Float](repeating: 0, count: gap), to: out)
            frames += gap
          }

          file = nil   // flush and close before anyone opens it for playback

          let dur = sampleRate > 0 ? Double(frames) / sampleRate : 0
          elapsed += dur
          onSegment(i, url, dur, chunks.count)
        }

        completion(.success(marks))
      } catch {
        completion(.failure(error))
      }
    }
  }

  /// Zero-padded so a lexical sort matches playback order.
  static func segmentName(base: String, index: Int) -> String {
    return String(format: "%@.part%03d.m4a", base, index)
  }

  /// Duration of an existing segment, or nil if it's missing or unreadable.
  private static func durationOf(_ url: URL) -> Double? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    guard let f = try? AVAudioFile(forReading: url) else {
      try? FileManager.default.removeItem(at: url)   // truncated leftover
      return nil
    }
    let sr = f.fileFormat.sampleRate
    return sr > 0 ? Double(f.length) / sr : nil
  }

  /// Copy raw float samples into the file's processing format and write them.
  private static func write(samples: [Float], to file: AVAudioFile) throws {
    let format = file.processingFormat
    guard let buffer = AVAudioPCMBuffer(
      pcmFormat: format,
      frameCapacity: AVAudioFrameCount(samples.count)
    ) else {
      throw EngineError.badOutput("Could not allocate an audio buffer")
    }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    guard let channel = buffer.floatChannelData?[0] else {
      throw EngineError.badOutput("Audio buffer has no float channel")
    }
    samples.withUnsafeBufferPointer { src in
      channel.update(from: src.baseAddress!, count: samples.count)
    }
    try file.write(from: buffer)
  }
}
