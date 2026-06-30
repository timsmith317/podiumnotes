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

export function addErrorListener(cb: (message: string) => void) {
  return SpeechFollow.addListener('onError', (e: { message: string }) => cb(e.message));
}