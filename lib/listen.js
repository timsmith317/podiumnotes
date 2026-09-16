// File: lib/listen.js → ~/Projects/podiumnotes/lib/listen.js
//
// Listen mode's brains — sits between the SpeechPlayer native module and the
// player UI (components/ListenSheet.js).
//
//   • Two engines behind one contract: Apple's AVSpeechSynthesizer (always
//     available) and Supertonic 3 (neural, needs a model directory on disk).
//     Which one runs is decided by the chosen voice — see ensureAudio.
//   • Cache-aware synthesis: audio renders once per (note body, engine, voice,
//     pace)
//     to documentDirectory/audio/<noteId>-<hash>.m4a. Edit the note, switch
//     voice, or change pace → new hash → one re-render; otherwise playback
//     is instant.
//   • WPM → utterance-rate mapping so the existing speaking-pace setting
//     carries into the audio.
//   • Listener preferences (voice, loop, playback rate) persisted in
//     AsyncStorage.
//   • Per-note playback position persisted in AsyncStorage — reopening a
//     note resumes where you stopped, audiobook style.
//   • Orphan cleanup for audio whose notes are gone.
//   • Character normalization before synthesis. This is NOT cosmetic: the
//     Supertonic engine validates its input charset and THROWS on anything
//     outside it, so a single smart quote or em dash in a note would fail
//     the whole render. Apple's engine tolerates them, but we normalize for
//     both so one text path feeds both backends.
//
// A note on direction: the paragraph marks recorded during synthesis are
// exact (the native module timestamps each paragraph from its own rendered
// frame count). Reading them TIME → PARAGRAPH is therefore ground truth,
// which is what paragraphAtTime does. The reverse direction — text offset
// → time — additionally depended on the presenter's line map, and that is
// the mapping that never became reliable. It is deliberately gone.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as SpeechPlayer from '../modules/speech-player';

const PREFS_KEY = 'podiumnotes.listen.prefs.v1';
const POS_KEY = 'podiumnotes.listen.positions.v1';
const AUDIO_DIR = FileSystem.documentDirectory + 'audio/';

// ── Preferences ──
// Only playbackRate is user-settable now. Which engine runs is decided by
// whether the model is on disk, not by a stored preference — a preference
// pointing at a model that has since gone missing would strand Listen on an
// engine that can't run.
const DEFAULT_PREFS = {
  playbackRate: 1.0,
  loop: false,
};

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

// ── Playback position (resume) ──
// One small map of noteId → seconds. Written on pause, on close, and on a
// throttle during playback, so a crash or a force-quit still resumes near
// where you were.
//
// Deliberate choice: the position is NOT invalidated when the note is
// edited. An edit re-renders the audio, so the timestamp may drift by
// however much text changed above it — but drift of a few seconds is far
// less annoying than being silently thrown back to the top after every
// tweak, and the scrubber fixes it in one drag. Positions are always
// clamped to the current duration on read.

async function readPositions() {
  try {
    const raw = await AsyncStorage.getItem(POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

export async function getListenPosition(noteId) {
  const map = await readPositions();
  const t = Number(map[noteId]);
  return isFinite(t) && t > 0 ? t : 0;
}

export async function setListenPosition(noteId, seconds) {
  if (!noteId) return;
  const t = Number(seconds);
  if (!isFinite(t) || t < 0) return;
  try {
    const map = await readPositions();
    map[noteId] = Math.round(t * 10) / 10;
    await AsyncStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch (e) {}
}

export async function clearListenPosition(noteId) {
  if (!noteId) return;
  try {
    const map = await readPositions();
    if (!(noteId in map)) return;
    delete map[noteId];
    await AsyncStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch (e) {}
}

// ── Supertonic assets ──
//
// Paths live here, not in Swift. The native module takes absolute paths on
// every call, so moving the model later (On-Demand Resources, a download into
// documentDirectory) is a change to THIS file only.

// The model SHIPS INSIDE THE APP, copied into the bundle at build time by
// plugins/withSpeechModel.js. It used to be hand-copied into each device's
// Documents folder — a separate 400MB copy per device per variant, and a
// container hunt every time one was reinstalled.
//
// Only native code can resolve a bundle path, so ask once and cache. Paths
// are still passed explicitly into every synthesis call, so the arrangement
// is unchanged: JS decides which paths are used, it just looks them up.
//
// There is deliberately NO fallback to Documents. A fallback would let a
// broken build-time copy keep working on a developer's device while failing
// silently for everyone else.

let _modelPaths = null;

export function modelPaths() {
  if (_modelPaths !== null) return _modelPaths;
  try {
    const p = SpeechPlayer.bundledModelPaths();
    _modelPaths = (p && p.modelDir) ? p : false;
  } catch (e) {
    if (__DEV__) console.warn('[listen] bundledModelPaths failed:', e?.message || e);
    _modelPaths = false;
  }
  return _modelPaths;
}

export function supertonicStylePath(styleId) {
  const p = modelPaths();
  if (!p) return '';
  return `${p.styleDir}/${styleId || VOICE_STYLE_ID}.json`;
}

// The engine is usable when the bundled model resolved. Native already
// verifies the config, the largest weight file and the voice style are
// present, so there's nothing to re-check here.
//
// (ensureDocumentsVisible lived here: it created the audio cache folder so
// iOS would list the app under "On My iPhone" for hand-copying the model.
// Nothing is hand-copied now.)
export async function supertonicAvailable() {
  return !!modelPaths();
}

// ── WPM → speed ──
//
// Supertonic takes pace at SYNTHESIS time (0.7–2.0), so there's no
// time-stretching and none of the quality loss that comes from rendering
// slowly — the problem that made the Apple engine sound stretched.
//
// The anchor comes from the on-device benchmark: 424 characters rendered to
// 27.5s of audio at speed 1.0, which is about 153 wpm.
const SUPERTONIC_BASE_WPM = 153;

export function wpmToSupertonicSpeed(wpm) {
  const w = Number(wpm) || 130;
  return Math.max(0.7, Math.min(2.0, w / SUPERTONIC_BASE_WPM));
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

// ── Character normalization ──
//
// Folds typographic characters down to the ASCII range the synthesizer
// accepts. Dashes become commas because that is what they mean out loud — a
// pause. A literal "-" tends to be read aloud as the word "dash" or
// swallowed entirely, neither of which is what the writer meant.
//
// IMPORTANT: this changes character offsets. The marks a render produces are
// offsets into the SANITIZED text, so anything reading marks (the scrubber's
// paragraph preview) must read the sanitized text too — which is why
// ensureAudio returns it as `speechText`.

const CHAR_MAP = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",   // single quotes
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',   // double quotes
  '\u2032': "'", '\u2033': '"',                                  // prime marks
  '\u2026': '...',                                                // ellipsis
  '\u2014': ', ', '\u2015': ', ',                                 // em dash, horizontal bar
  '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u200B': '',     // exotic spaces
  '\u2022': '', '\u00B7': '', '\u25CF': '',                      // bullets
  '\u2E3B': '\n\n', '\u2E3A': '\n\n',                           // 3-em / 2-em dash dividers
  '\u00BD': ' one half', '\u00BC': ' one quarter', '\u00BE': ' three quarters',
  '\u00B0': ' degrees', '\u2122': '', '\u00AE': '', '\u00A9': '',
  '\u0301': '', '\u0300': '',                                    // stray combining accents
};

// Returns { text, dropped } — `dropped` counts characters that survived the
// map and had to be removed outright. Each one is a silent hole in the
// audio, so they're worth surfacing in dev rather than swallowing.
export function sanitizeForSynthesis(input) {
  let text = typeof input === 'string' ? input : '';

  // An en dash between digits is a range ("3-5" reads as "three to five");
  // anywhere else it's just a pause, same as an em dash.
  text = text.replace(/(\d)\u2013(?=\d)/g, '$1 to ');
  text = text.replace(/\u2013/g, ', ');

  for (const [src, dst] of Object.entries(CHAR_MAP)) {
    if (text.includes(src)) text = text.split(src).join(dst);
  }

  const dropped = {};
  let out = '';
  for (const ch of text) {
    if (ch.charCodeAt(0) < 127 || ch === '\n' || ch === '\t') out += ch;
    else dropped[ch] = (dropped[ch] || 0) + 1;
  }
  text = out;

  // Tidy what the substitutions pile up.
  text = text.replace(/[ \t]+,/g, ',');        // " — x" left " , x"
  text = text.replace(/,[ \t]*,+/g, ',');
  text = text.replace(/,\s*([.!?;:])/g, '$1');
  text = text.replace(/[ \t]{2,}/g, ' ');
  // Collapse runs of blank lines — the native module splits paragraphs on
  // "\n\n" and would otherwise emit empty chunks.
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]*\n[ \t]*/g, '\n').trim();

  return { text, dropped };
}

// ── Cache ──
// djb2 over the inputs that shape the rendered audio.
function hashInputs(body, key) {
  const s = `${key}|${body}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

// `key` identifies everything that shapes the audio besides the text itself:
// engine, voice, and pace. Different engines therefore never collide in the
// cache, and switching back to one you used before is still an instant hit.
export function audioPathFor(noteId, body, key) {
  return `${AUDIO_DIR}${noteId}-${hashInputs(body, key)}.m4a`;
}

// Render (or reuse) the audio for a note. Returns { uri, duration, cached }.
// Synthesis runs on-device and faster than realtime, but for a long speech
// it's a visible wait — callers show "Preparing audio…" until this resolves.
export async function ensureAudio(note, { engine = 'apple', voiceId, wpm, steps = 8 }) {
  const useSupertonic = engine === 'supertonic';
  const rate = wpmToRate(wpm);
  const speed = wpmToSupertonicSpeed(wpm);

  const cacheKey = useSupertonic
    ? `st|${VOICE_STYLE_ID}|${speed.toFixed(3)}|${steps}`
    : `ap|${voiceId || 'default'}|${rate.toFixed(3)}`;

  const synthOptions = useSupertonic
    ? {
        engine: 'supertonic',
        modelDir: modelPaths() ? modelPaths().modelDir : '',
        stylePath: supertonicStylePath(VOICE_STYLE_ID),
        steps,
        speed,
        language: 'en',
      }
    : (voiceId ? { voiceId, rate } : { rate });

  // Everything downstream — hash, synthesis, marks — works on the sanitized
  // text, never the raw body. Hashing the sanitized form also means a future
  // change to CHAR_MAP invalidates exactly the notes it actually affects.
  const { text: speechText, dropped } = sanitizeForSynthesis(note.body);
  if (__DEV__ && Object.keys(dropped).length) {
    const detail = Object.entries(dropped).map(([c, n]) => `${JSON.stringify(c)} x${n}`).join(', ');
    console.warn(`[listen] dropped unsupported character(s) before synthesis: ${detail}`);
  }

  const path = audioPathFor(note.id, speechText, cacheKey);
  const marksPath = path.replace(/\.m4a$/, '.marks.json');

  const info = await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }));
  if (info.exists && info.size > 0) {
    // The paragraph → time map rides in a sidecar; a cached file without one
    // (pre-marks renders) is treated as a miss so it re-renders with marks.
    try {
      const raw = await FileSystem.readAsStringAsync(marksPath);
      const marks = JSON.parse(raw);
      // Duration isn't stored; load() reports it, so cached hits pass 0.
      // speechText is recomputed rather than cached — sanitizing is
      // deterministic and cheap, and it keeps the sidecar to just marks.
      return { uri: path, duration: 0, marks, speechText, cached: true };
    } catch (e) {
      // fall through to re-render
    }
  }

  // A new render supersedes this note's older ones — clear them so edits
  // don't accumulate stale audio.
  await deleteAudioForNote(note.id).catch(() => {});

  const { uri, duration, marks = [] } = await SpeechPlayer.synthesizeToFile(
    speechText, path, synthOptions
  );
  try { await FileSystem.writeAsStringAsync(marksPath, JSON.stringify(marks)); } catch (e) {}
  return { uri, duration, marks, speechText, cached: false };
}

// ── Progressive rendering ──
//
// Long notes are unusable rendered whole: 262 words took 35 seconds before a
// single sample played, because nothing plays until everything is rendered.
// Segmented rendering fixes that — each paragraph is its own file, playback
// starts on the first one, and at ~0.27x RTF the renderer outruns playback
// about four to one, so the buffer only grows.
//
// Segments live in their own directory per (note, engine, voice, pace), so a
// voice change doesn't invalidate a render you might switch back to, and a
// note edit simply produces a different directory.

const HEAD_START_SECONDS = 20;   // enough to start instantly and stay ahead

// ── The narrator ──
//
// Podium Notes ships a single voice. Switching voices mid-note meant
// re-rendering everything before the switch point just to preserve your
// place — about 0.27s of work per second of audio, so 15s a minute in and
// worse the deeper you went. One voice removes that problem entirely, and a
// named narrator reads better than a style id.
export const VOICE_NAME = 'James';
export const VOICE_STYLE_ID = 'M1';

export function segmentDirFor(noteId, speechText, cacheKey) {
  return `${AUDIO_DIR}${noteId}-${hashInputs(speechText, cacheKey)}/`;
}

// Options shared by the head start and the real render, so the two agree on
// where segments live and what they sound like.
// The narrator reads at the model's natural pace. It used to read at the
// user's Speaking Pace setting, which conflated two unrelated things:
// Speaking Pace exists to estimate how long THEY will take at the podium,
// and quietly slowing the narrator down gave one control a second, unstated
// meaning. Listening is for hearing what you wrote, not for rehearsing
// timing — and the HUD's rate control is there when someone does want to
// speed it up.
//
// It also removes a whole class of cache mismatch: speed was part of the key,
// so changing Speaking Pace silently orphaned every rendered note.
const SUPERTONIC_SPEED = 1.0;

function supertonicJob(note, { steps = 8 } = {}) {
  const paths = modelPaths();
  if (!paths) return null;
  const { text: speechText } = sanitizeForSynthesis(note.body);
  const speed = SUPERTONIC_SPEED;
  const cacheKey = `st|${VOICE_STYLE_ID}|${speed.toFixed(3)}|${steps}`;
  return {
    speechText,
    dir: segmentDirFor(note.id, speechText, cacheKey),
    base: 'seg',
    options: {
      modelDir: paths.modelDir,
      stylePath: supertonicStylePath(VOICE_STYLE_ID),
      steps,
      speed,
      language: 'en',
    },
  };
}

// Identity of a note's rendered audio: the segment directory, which is
// hashed from the SANITIZED TEXT plus voice and pace. Anything that changes
// what the audio should sound like changes this string.
//
// Callers use it to decide whether audio already loaded is still the right
// audio. A key built from the note id alone silently replayed the previous
// render after an edit — the words changed, the key didn't, so nothing
// re-rendered.
export function listenCacheKey(note, opts) {
  const job = supertonicJob(note, opts || {});
  return job ? job.dir : '';
}

// Render the opening of a note in the background so Listen starts instantly.
// Safe to call repeatedly — existing segments are skipped, so this is a cheap
// no-op once the head start exists. Returns false when the engine isn't
// available rather than throwing; a missing head start is never fatal.
export async function prepareHeadStart(note, opts) {
  if (!note?.body?.trim()) return false;
  try {
    if (!(await supertonicAvailable())) return false;
    const job = supertonicJob(note, opts || {});
    if (!job) return false;
    await SpeechPlayer.renderSegments(job.speechText, job.dir, job.base, {
      ...job.options,
      maxSeconds: HEAD_START_SECONDS,
    });
    return true;
  } catch (e) {
    if (__DEV__) console.warn('[listen] head start failed:', e?.message || e);
    return false;
  }
}

// Start a progressive render and get the player ready. Resolves as soon as
// there's enough audio to begin — usually immediately, because the head start
// already put segments on disk.
export async function beginListening(note, opts) {
  const o = opts || {};
  const job = supertonicJob(note, o);
  if (!job) throw new Error('Speech model is not available');

  // Editing a note renders into a new directory and stranded the old one:
  // measured, a single edit took a sermon's cache from 1.6MB to 3.3MB, and
  // nothing ever reclaimed it. Sweep the note's other renders as this one
  // starts — they can only belong to text or settings no longer in use.
  //
  // Deliberately NOT awaited: deleting is housekeeping and must not delay
  // the first audio, which is the number this whole design is built around.
  deleteSegmentsForNote(note.id, job.dir).catch(() => {});
  return await SpeechPlayer.beginProgressive(
    job.speechText, job.dir, job.base, note.title || 'Podium Notes',
    {
      ...job.options,
      // Where in the note to begin. Native resolves this to the paragraph
      // containing it, using the same word-count estimate that produces the
      // total on the scrubber, and reports the paragraph's own start back as
      // renderedFrom. Omitted or 0 renders from the beginning.
      startSeconds: o.startSeconds || 0,
      // POSITION ESTIMATES only — the narrator still reads at natural pace.
      // The presenter's scroll timer uses the reader's Speaking Pace, so the
      // audio timeline has to use the same number or the two modes disagree
      // about where a paragraph sits.
      estimateWPM: Number(o.wpm) || 130,
      // The lead chunk is one sentence (~2s of compute), so waiting for more
      // than a few seconds of audio just delays the start for no benefit —
      // the renderer outruns playback about four to one from here.
      // The opening paragraphs are rendered as SENTENCES, so early chunks
      // arrive far faster than playback drains them and the buffer climbs
      // from a small start. That makes a large pre-roll unnecessary — this
      // only needs to cover the first sentence or two.
      // Measured on device: RTF 0.27, drifting to 0.39 when hot. So the
      // renderer produces audio roughly four times faster than playback
      // consumes it, and the buffer GROWS by about 0.7s for every second
      // played — starting on a 5s sentence leaves ~49s buffered a minute
      // later. An underrun would need RTF above 1.0, slower than real time.
      //
      // Waiting for 6s of audio was therefore guarding against something
      // this hardware cannot do, at a cost of ~1.6s before the first word.
      startAfterSeconds: opts?.startAfterSeconds ?? 2,
    }
  );
}

// How much audio already exists for a note, in seconds — drives the buffered
// portion of the scrubber before playback starts.
export async function renderedSecondsFor(note, opts) {
  try {
    const job = supertonicJob(note, opts || {});
    if (!job) return 0;
    const names = await FileSystem.readDirectoryAsync(job.dir);
    return names.filter(n => n.endsWith('.m4a')).length;
  } catch (e) {
    return 0;
  }
}

// Delete every segment directory for a note (all voices, all paces).
// Remove a note's segment directories, optionally sparing one.
//
// `keepDir` is what makes this safe to call as a render begins: every OTHER
// directory for that note can only exist for text or settings the note has
// moved away from, so it is genuinely dead. Deleting everything instead
// would throw away the render currently being played.
export async function deleteSegmentsForNote(noteId, keepDir) {
  const keepName = keepDir ? keepDir.replace(AUDIO_DIR, '').replace(/\/$/, '') : null;
  try {
    const names = await FileSystem.readDirectoryAsync(AUDIO_DIR);
    await Promise.all(
      names
        .filter(n => n.startsWith(`${noteId}-`) && !n.endsWith('.m4a') && !n.endsWith('.json'))
        .filter(n => n !== keepName)
        .map(n => FileSystem.deleteAsync(AUDIO_DIR + n, { idempotent: true }))
    );
  } catch (e) {}
}

// ── Marks, read in the direction that's exact ──

// The paragraph playing at `timeSec`: returns { offset, time } from the
// marks, or null. Marks are ordered by time, so this is a simple scan back
// to the last paragraph that had already started.
export function markAtTime(marks, timeSec) {
  if (!Array.isArray(marks) || !marks.length) return null;
  let found = marks[0];
  for (const m of marks) {
    if (m.time <= timeSec + 0.01) found = m;
    else break;
  }
  return found;
}

// A short preview of the paragraph playing at `timeSec` — shown while
// dragging the scrubber so you can see where you're about to land.
//
// `body` MUST be the sanitized text that was synthesized (ensureAudio's
// `speechText`), not the raw note body. Mark offsets index the sanitized
// string; passing the raw body drifts the preview by however many
// characters normalization changed.
export function paragraphAtTime(marks, timeSec, body, maxChars = 70) {
  const m = markAtTime(marks, timeSec);
  if (!m || typeof body !== 'string') return '';
  const start = Math.max(0, Math.min(body.length, m.offset));
  const text = body.slice(start, start + maxChars * 2).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // Trim at a word boundary so the ellipsis doesn't land mid-word.
  const cut = text.slice(0, maxChars);
  const sp = cut.lastIndexOf(' ');
  return (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

// ── Cache size and clearing ──
//
// Rendered audio accumulates at roughly 15MB per sermon and nothing surfaced
// it. On an app that is already ~390MB because the voice ships inside it,
// finding a few hundred unexplained megabytes with no way to reclaim them is
// a reasonable thing to be annoyed about.

export async function audioCacheBytes() {
  async function walk(dir) {
    let names = [];
    try {
      names = await FileSystem.readDirectoryAsync(dir);
    } catch (e) {
      return 0;   // directory may not exist yet
    }
    let total = 0;
    for (const name of names) {
      const path = dir + name;
      try {
        const info = await FileSystem.getInfoAsync(path, { size: true });
        if (!info.exists) continue;
        // Progressive renders live in per-note subdirectories of segments.
        total += info.isDirectory ? await walk(path + '/') : (info.size || 0);
      } catch (e) {}
    }
    return total;
  }
  return walk(AUDIO_DIR);
}

// Everything here is derived from the notes, so clearing costs only the time
// to render again. Playback is stopped first — deleting the files underneath
// a playing composition would fail in confusing ways.
//
// Saved positions go too. They were kept at first, on the reasoning that a
// timestamp survives a re-render and losing your place is worse than
// re-rendering — but that made the one deliberate reset in the app fail to
// reset: clear the cache, press play, and it resumed mid-note with no way
// back to the start except scrubbing. Resume should be something that
// happens on its own, not something you have to undo.
export async function clearAudioCache() {
  try { SpeechPlayer.cancelProgressive(); } catch (e) {}
  try { SpeechPlayer.stop(); } catch (e) {}
  try { await FileSystem.deleteAsync(AUDIO_DIR, { idempotent: true }); } catch (e) {}
  try { await FileSystem.makeDirectoryAsync(AUDIO_DIR, { intermediates: true }); } catch (e) {}
  try { await AsyncStorage.removeItem(POS_KEY); } catch (e) {}
}

export async function deleteAudioForNote(noteId) {
  await deleteSegmentsForNote(noteId);
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

// Remove audio for notes that no longer exist, and prune their saved
// positions in the same pass. Call opportunistically (e.g., from the notes
// list) with the current set of note ids.
export async function cleanupOrphanAudio(noteIds) {
  const keep = new Set(noteIds);
  try {
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
  try {
    const map = await readPositions();
    let changed = false;
    for (const id of Object.keys(map)) {
      if (!keep.has(id)) { delete map[id]; changed = true; }
    }
    if (changed) await AsyncStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch (e) {}
}
