// File: lib/listen.js → ~/Projects/podiumnotes/lib/listen.js
//
// Listen mode's brains — sits between the SpeechPlayer native module and the
// player UI (components/ListenSheet.js).
//
//   • Cache-aware synthesis: audio renders once per (note body, voice, rate)
//     to documentDirectory/audio/<noteId>-<hash>.m4a. Edit the note, switch
//     voice, or change pace → new hash → one re-render; otherwise playback
//     is instant.
//   • WPM → utterance-rate mapping so the existing speaking-pace setting
//     carries into the audio.
//   • Listener preferences (voice, loop, playback rate) persisted in
//     AsyncStorage.
//   • Orphan cleanup for audio whose notes are gone.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as SpeechPlayer from '../modules/speech-player';

const PREFS_KEY = 'podiumnotes.listen.prefs.v1';
const AUDIO_DIR = FileSystem.documentDirectory + 'audio/';

// ── Preferences ──
const DEFAULT_PREFS = { voiceId: null, playbackRate: 1.0, loop: false };

export async function getListenPrefs() {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

export async function setListenPrefs(patch) {
  const current = await getListenPrefs();
  const next = { ...current, ...patch };
  try { await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (e) {}
  return next;
}

// ── WPM → AVSpeechUtterance rate ──
// The utterance rate is 0..1 with 0.5 ≈ ~180 wpm for English voices (it
// varies a little by voice). A linear map around that anchor, clamped to the
// range that still sounds like speech, keeps the audio duration roughly in
// line with the app's speaking-time estimate.
export function wpmToRate(wpm) {
  const w = Number(wpm) || 130;
  return Math.max(0.3, Math.min(0.62, 0.5 * (w / 180)));
}

// ── Cache ──
// djb2 over the inputs that shape the rendered audio.
function hashInputs(body, voiceId, rate) {
  const s = `${voiceId || 'default'}|${rate.toFixed(3)}|${body}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

export function audioPathFor(noteId, body, voiceId, rate) {
  return `${AUDIO_DIR}${noteId}-${hashInputs(body, voiceId, rate)}.m4a`;
}

// Render (or reuse) the audio for a note. Returns { uri, duration, cached }.
// Synthesis runs on-device and faster than realtime, but for a long speech
// it's a visible wait — callers show "Preparing audio…" until this resolves.
export async function ensureAudio(note, { voiceId, wpm }) {
  const rate = wpmToRate(wpm);
  const path = audioPathFor(note.id, note.body, voiceId, rate);
  const marksPath = path.replace(/\.m4a$/, '.marks.json');

  const info = await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }));
  if (info.exists && info.size > 0) {
    // The paragraph → time map rides in a sidecar; a cached file without one
    // (pre-marks renders) is treated as a miss so it re-renders with marks.
    try {
      const raw = await FileSystem.readAsStringAsync(marksPath);
      const marks = JSON.parse(raw);
      // Duration isn't stored; load() reports it, so cached hits pass 0.
      return { uri: path, duration: 0, marks, cached: true };
    } catch (e) {
      // fall through to re-render
    }
  }

  // A new render supersedes this note's older ones — clear them so edits
  // don't accumulate stale audio.
  await deleteAudioForNote(note.id).catch(() => {});

  const { uri, duration, marks = [] } = await SpeechPlayer.synthesizeToFile(
    note.body, path, voiceId ? { voiceId, rate } : { rate }
  );
  try { await FileSystem.writeAsStringAsync(marksPath, JSON.stringify(marks)); } catch (e) {}
  return { uri, duration, marks, cached: false };
}

// Time (seconds) of the paragraph containing charOffset — the exact seek
// target for "start where the band is". Falls back to a proportional guess
// when no marks are available.
export function timeForOffset(marks, charOffset, bodyLength, duration) {
  if (Array.isArray(marks) && marks.length) {
    let t = 0;
    for (const m of marks) {
      if (m.offset <= charOffset) t = m.time;
      else break;
    }
    return t;
  }
  if (!bodyLength || !duration) return 0;
  return Math.max(0, Math.min(duration - 1, (charOffset / bodyLength) * duration));
}

export async function deleteAudioForNote(noteId) {
  try {
    const names = await FileSystem.readDirectoryAsync(AUDIO_DIR);
    await Promise.all(
      names
        .filter(n => n.startsWith(`${noteId}-`))
        .map(n => FileSystem.deleteAsync(AUDIO_DIR + n, { idempotent: true }))
    );
  } catch (e) {
    // Directory may not exist yet — nothing to delete.
  }
}

// Remove audio for notes that no longer exist. Call opportunistically
// (e.g., from the notes list) with the current set of note ids.
export async function cleanupOrphanAudio(noteIds) {
  try {
    const keep = new Set(noteIds);
    const names = await FileSystem.readDirectoryAsync(AUDIO_DIR);
    await Promise.all(
      names
        .filter(n => {
          const noteId = n.split('-').slice(0, -1).join('-');
          return noteId && !keep.has(noteId);
        })
        .map(n => FileSystem.deleteAsync(AUDIO_DIR + n, { idempotent: true }))
    );
  } catch (e) {}
}
