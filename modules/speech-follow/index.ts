// modules/speech-follow/index.ts
//
// Replaces the generated index.ts. Thin wrapper over the native SpeechFollow
// module: permissions, start/stop, and event subscriptions for live transcripts.

import { requireNativeModule } from 'expo';

const SpeechFollow = requireNativeModule('SpeechFollow');

export async function requestPermissions(): Promise<boolean> {
  return await SpeechFollow.requestPermissions();
}

export async function start(locale: string = 'en-US'): Promise<boolean> {
  return await SpeechFollow.start(locale);
}

export function stop(): void {
  SpeechFollow.stop();
}

export function addTranscriptListener(cb: (text: string) => void) {
  return SpeechFollow.addListener('onTranscript', (e: { text: string }) => cb(e.text));
}

export function addStatusListener(cb: (listening: boolean) => void) {
  return SpeechFollow.addListener('onStatus', (e: { listening: boolean }) => cb(e.listening));
}

// The event is "onFollowError", not "onError": SpeechPlayer declares an
// "onError" of its own, and identically named events were reaching both
// modules' listeners — a disabled Dictation service produced a voice-follow
// alert AND a playback alert.
//
// The whole payload is forwarded rather than just the message, so callers can
// branch on `code` instead of matching error text that Apple may reword.
export function addErrorListener(
  cb: (e: { code?: string; message: string }) => void
) {
  return SpeechFollow.addListener('onFollowError', (e: { code?: string; message: string }) => cb(e));
}