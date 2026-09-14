// File: index.ts → ~/Projects/podiumnotes/modules/speech-player/index.ts
//
// Thin wrapper over the native SpeechPlayer module (sibling of speech-follow).
// Synthesis-to-file, playback control, and event subscriptions for Listen mode.
//
// Two synthesis engines share one contract:
//
//   'apple'      AVSpeechSynthesizer. Always available, no assets, no setup.
//                Voices come from getVoices(); `rate` is the utterance rate.
//
//   'supertonic' Supertonic 3 via ONNX. Markedly better voice, but needs a
//                model directory and a voice-style file, both passed as
//                absolute paths. Keeping paths on the JS side means asset
//                delivery (bundle / On-Demand Resources / download) is decided
//                here and the native module never changes when it does.

import { requireNativeModule } from 'expo';

const SpeechPlayer = requireNativeModule('SpeechPlayer');

export type Voice = { id: string; name: string; language: string; quality: number };

export type SynthEngine = 'apple' | 'supertonic';

export type SynthOptions = {
  engine?: SynthEngine;
  // Apple
  voiceId?: string;
  rate?: number;
  // Supertonic
  modelDir?: string;    // absolute dir holding the .onnx files + tts.json
  stylePath?: string;   // absolute path to a voice style JSON (M1.json, F1.json, …)
  steps?: number;       // NFE, 5 (fast) … 12 (best). 8 is the default.
  speed?: number;       // 0.7 … 2.0, applied at synthesis time
  language?: string;    // BCP-ish code Supertonic understands; 'en' by default
};

export type SynthResult = {
  uri: string;
  duration: number;
  marks: { offset: number; time: number }[];
};

// The ten Supertonic preset styles. Names are the style filenames, so the
// caller builds a path as `${styleDir}/${id}.json`.
export const SUPERTONIC_VOICES: { id: string; label: string }[] = [
  { id: 'F1', label: 'Female 1' },
  { id: 'F2', label: 'Female 2' },
  { id: 'F3', label: 'Female 3' },
  { id: 'F4', label: 'Female 4' },
  { id: 'F5', label: 'Female 5' },
  { id: 'M1', label: 'Male 1' },
  { id: 'M2', label: 'Male 2' },
  { id: 'M3', label: 'Male 3' },
  { id: 'M4', label: 'Male 4' },
  { id: 'M5', label: 'Male 5' },
];

// Legacy novelty voices (Zarvox, Fred, Bells, ...) and the robotic Eloquence
// accessibility set share distinct identifier families — neither belongs in
// a listening picker.
const EXCLUDED_VOICE_IDS = /com\.apple\.speech\.synthesis\.voice|com\.apple\.eloquence/;

export async function getVoices(): Promise<Voice[]> {
  const voices: Voice[] = await SpeechPlayer.getVoices();
  return voices.filter(v => !EXCLUDED_VOICE_IDS.test(v.id));
}

// Renders text to an .m4a at `path` (absolute), chunked by paragraph, and
// returns a paragraph → time map alongside the file.
export async function synthesizeToFile(
  text: string,
  path: string,
  options: SynthOptions = {}
): Promise<SynthResult> {
  return await SpeechPlayer.synthesizeToFile(text, path, options);
}

// Build the ONNX sessions ahead of time. Costs ~0.5s on first call and is a
// no-op afterwards, so calling it when a note opens removes that half second
// from the gap between tapping Listen and hearing audio.
export async function prepareSynthEngine(modelDir: string): Promise<boolean> {
  return await SpeechPlayer.prepareSynthEngine(modelDir);
}

// Release the ONNX sessions (memory pressure, or switching model directory).
export async function unloadSynthEngine(): Promise<boolean> {
  return await SpeechPlayer.unloadSynthEngine();
}

export type ProgressiveOptions = SynthOptions & {
  /** Seconds of audio to buffer before handing control back. Default 20. */
  startAfterSeconds?: number;
};

// Render segment-by-segment and start playing before the render finishes.
//
// Resolves once `startAfterSeconds` of audio exists (or the render completes,
// whichever comes first) — then call play(). Rendering continues underneath;
// at ~0.27x RTF the buffer grows about four times faster than playback drains
// it, so it never catches up once started.
//
// Segments are written as `<dir>/<base>.partNNN.m4a` and are reused on a
// later run, so an interrupted sermon resumes instead of restarting.
export async function beginProgressive(
  text: string,
  dir: string,
  base: string,
  title: string,
  options: ProgressiveOptions = {}
): Promise<{ estimatedDuration: number; rendered: number }> {
  return await SpeechPlayer.beginProgressive(text, dir, base, title, options);
}

// Render the opening segments to disk without touching playback — the head
// start. Called when a note opens in the presenter so tapping Listen later
// finds audio already waiting. Stops once `maxSeconds` of audio exists;
// segments are reused by beginProgressive rather than re-rendered.
export async function renderSegments(
  text: string,
  dir: string,
  base: string,
  options: SynthOptions & { maxSeconds?: number } = {}
): Promise<{ rendered: number; segments: number; complete: boolean }> {
  return await SpeechPlayer.renderSegments(text, dir, base, options);
}

// Stop an in-flight progressive render at the next paragraph boundary.
// Finished segments stay on disk and are reused if the note is replayed.
export function cancelProgressive(): void { SpeechPlayer.cancelProgressive(); }

// Absolute paths to the speech model inside the app bundle. Empty strings
// when it isn't there — which should only happen if the build-time copy
// failed, since the model ships with the app.
export function bundledModelPaths(): { modelDir: string; styleDir: string } {
  return SpeechPlayer.bundledModelPaths();
}

export async function load(uri: string, title: string): Promise<{ duration: number }> {
  return await SpeechPlayer.load(uri, title);
}

export function play(): void { SpeechPlayer.play(); }
export function pause(): void { SpeechPlayer.pause(); }
export function seekTo(seconds: number): void { SpeechPlayer.seekTo(seconds); }
export function stop(): void { SpeechPlayer.stop(); }
export function setLoop(value: boolean): void { SpeechPlayer.setLoop(value); }
export function setPlaybackRate(value: number): void { SpeechPlayer.setPlaybackRate(value); }

// `rendered` is how much audio actually exists — during a progressive render
// that's less than `duration` (an estimate from word count), which is what
// lets the scrubber draw played-vs-buffered.
export function addProgressListener(
  cb: (e: { elapsed: number; duration: number; rendered?: number }) => void
) {
  return SpeechPlayer.addListener('onProgress', cb);
}

// Synthesis progress, one event per finished paragraph. Neural renders are
// long enough that a bare spinner isn't acceptable feedback.
export function addSynthProgressListener(
  cb: (e: {
    progress: number; chunk: number; total: number;
    rendered?: number; complete?: boolean;
    marks?: { offset: number; time: number }[];
  }) => void
) {
  return SpeechPlayer.addListener('onSynthProgress', cb);
}

export function addStateListener(cb: (state: string) => void) {
  return SpeechPlayer.addListener('onState', (e: { state: string }) => cb(e.state));
}

export function addErrorListener(cb: (message: string) => void) {
  return SpeechPlayer.addListener('onError', (e: { message: string }) => cb(e.message));
}
