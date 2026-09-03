// File: index.ts → ~/Projects/podiumnotes/modules/speech-player/index.ts
//
// Thin wrapper over the native SpeechPlayer module (sibling of speech-follow).
// Synthesis-to-file, playback control, and event subscriptions for Listen mode.

import { requireNativeModule } from 'expo';

const SpeechPlayer = requireNativeModule('SpeechPlayer');

export type Voice = { id: string; name: string; language: string; quality: number };

export async function getVoices(): Promise<Voice[]> {
  return await SpeechPlayer.getVoices();
}

// Renders text to an .m4a at `path` (absolute). rate is the AVSpeechUtterance
// rate (0..1); lib/listen.js maps the WPM setting onto it.
export async function synthesizeToFile(
  text: string,
  path: string,
  options: { voiceId?: string; rate?: number } = {}
): Promise<{ uri: string; duration: number }> {
  return await SpeechPlayer.synthesizeToFile(text, path, options);
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

export function addProgressListener(cb: (e: { elapsed: number; duration: number }) => void) {
  return SpeechPlayer.addListener('onProgress', cb);
}

export function addStateListener(cb: (state: string) => void) {
  return SpeechPlayer.addListener('onState', (e: { state: string }) => cb(e.state));
}

export function addErrorListener(cb: (message: string) => void) {
  return SpeechPlayer.addListener('onError', (e: { message: string }) => cb(e.message));
}
