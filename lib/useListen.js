// File: useListen.js → ~/Projects/podiumnotes/lib/useListen.js
//
// Listen mode's controller. All playback state and actions, no UI.
//
// This used to be components/ListenSheet.js — a bottom card that owned both
// the logic and its own controls. The card is gone: the presenter's floating
// HUD now doubles as the transport (A− becomes back-15, A+ becomes
// forward-15, the mic becomes the rate control, and the scroll track becomes
// the scrubber), so a second set of controls over the text was redundant.
// The logic moved here so the HUD can drive it.
//
// Position model:
//   • Playback RESUMES where you stopped, per note, audiobook style. The
//     position is saved on pause, on unmount, and on a throttle while
//     playing.
//   • Relocating is pure time arithmetic against the audio — there is no
//     text-offset → time mapping anywhere in this file, and therefore
//     nothing that can drift.
//   • Reaching the end clears the saved position, so the next play starts at
//     the top rather than at the final second.
//
// There is no substitute voice. If the model isn't installed, the caller
// hides the control rather than quietly narrating in someone else's voice.

import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as SpeechPlayer from '../modules/speech-player';
import {
  getListenPrefs, setListenPrefs, paragraphAtTime,
  getListenPosition, setListenPosition, clearListenPosition,
  supertonicAvailable, modelPaths, beginListening, listenCacheKey,
  sanitizeForSynthesis,
} from './listen';

// 1.25 was the only five-character label ("1.25×") in a set where everything
// else is two to four, and it overflowed the round control. 1.3 is close
// enough in feel and keeps every label the same width.
const RATE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.3, 1.5];

// ── Tunables ──
const SAVE_EVERY_SEC = 5;     // throttle for position writes during playback
const RESUME_MIN_SEC = 3;     // below this, just start at the top
const RESUME_TAIL_SEC = 10;   // resuming this close to the end starts over
const SEEK_SETTLE_MS = 1200;  // ignore stale progress ticks for this long after a seek
const SEEK_TOLERANCE = 1.5;   // seconds; a tick this close to the target means the seek landed
const PREPARE_RETRIES = 3;    // transient collisions with a head-start render
const PREPARE_RETRY_MS = 1200;

export function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Drives Listen mode for one note.
 *
 * `active` should be true whenever the note is on screen — it gates the
 * availability probe and the engine pre-warm, not playback itself, which
 * deliberately continues while the user is elsewhere in the app.
 */
export function useListen(note, wpm, active = true) {
  // phase: idle | preparing | ready | playing | paused | finished | error
  const [phase, _setPhase] = useState('idle');
  const phaseRef = useRef('idle');     // sync mirror — event handlers must not act on stale state
  const setPhase = (p) => { phaseRef.current = p; _setPhase(p); };
  const [elapsed, _setElapsed] = useState(0);
  const [duration, _setDuration] = useState(0);
  const [prefs, setPrefs] = useState({ playbackRate: 1.0, loop: false });
  // The only voice question left: is James's model on disk? If not, Listen
  // silently falls back to the system voice rather than failing.
  const [stReady, setStReady] = useState(false);
  const [synthPct, setSynthPct] = useState(0);     // 0…1 during a neural render
  const [rendered, setRendered] = useState(0);     // seconds of audio that exist
  const renderedRef = useRef(0);

  const loadedForRef = useRef(null);   // `${noteId}|${voiceId}|${wpm}` currently loaded
  const subsRef = useRef([]);
  const genRef = useRef(0);            // prepare-generation token: latest request wins
  const marksRef = useRef([]);         // paragraph → time map for the loaded audio
  // Cues drive text auto-follow: { time, text } per rendered chunk, where
  // `text` is the chunk's opening words. Kept separate from `marks` because
  // marks carry character offsets into the SANITIZED text, which don't line
  // up with the body shown on screen.
  const cueRef = useRef([]);
  const [cueCount, setCueCount] = useState(0);
  const speechTextRef = useRef('');    // the SANITIZED text that was synthesized;
                                       // mark offsets index this, not note.body

  // Refs mirroring state, because the PanResponder and the native event
  // listeners are created once and would otherwise close over stale values.
  const elapsedRef = useRef(0);
  const durationRef = useRef(0);
  const noteRef = useRef(note);
  const busyRef = useRef(false);
  const pendingSeekRef = useRef(null);     // target of an in-flight seek
  const pendingSeekTimer = useRef(null);
  const lastSaveRef = useRef(0);
  const retryTimer = useRef(null);

  const setElapsed = (v) => { elapsedRef.current = v; _setElapsed(v); };
  const setDuration = (v) => { durationRef.current = v; _setDuration(v); };

  useEffect(() => { noteRef.current = note; }, [note]);
  useEffect(() => { busyRef.current = phase === 'preparing'; }, [phase]);

  // ── Seeking ──
  // Every seek goes through here so the UI jumps immediately and then
  // ignores the half-second of stale progress ticks still in flight from
  // the native periodic observer.
  function seek(target) {
    const d = durationRef.current;
    const t = Math.max(0, Math.min(d ? d - 0.25 : 0, target));
    pendingSeekRef.current = t;
    if (pendingSeekTimer.current) clearTimeout(pendingSeekTimer.current);
    pendingSeekTimer.current = setTimeout(() => { pendingSeekRef.current = null; }, SEEK_SETTLE_MS);
    SpeechPlayer.seekTo(t);
    setElapsed(t);
    return t;
  }

  function savePosition(t) {
    const id = noteRef.current?.id;
    if (!id) return;
    lastSaveRef.current = t;
    // Never let a persistence failure take down playback or a drag.
    try {
      const r = setListenPosition(id, t);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      if (__DEV__) console.warn('[listen] savePosition failed:', e);
    }
  }

  // Voices + prefs load once; module event subscriptions live for the
  // sheet's (mounted-forever) lifetime.
  useEffect(() => {
    (async () => {
      try {
        const [p, ready] = await Promise.all([getListenPrefs(), supertonicAvailable()]);
        setStReady(ready);
        setPrefs(p);
      } catch (e) {}
    })();
    subsRef.current = [
      SpeechPlayer.addProgressListener((evt) => {
        const e = evt?.elapsed ?? 0;
        const d = evt?.duration ?? 0;
        let r; try { r = evt?.rendered; } catch (_) { r = undefined; }
        if (d > 0) setDuration(d);
        if (typeof r === 'number' && r > 0) { renderedRef.current = r; setRendered(r); }
        // Drop ticks that predate an in-flight seek, or the bar snaps back.
        if (pendingSeekRef.current != null) {
          if (Math.abs(e - pendingSeekRef.current) > SEEK_TOLERANCE) return;
          pendingSeekRef.current = null;
        }
        setElapsed(e);
        if (phaseRef.current === 'playing' && Math.abs(e - lastSaveRef.current) >= SAVE_EVERY_SEC) {
          savePosition(e);
        }
      }),
      SpeechPlayer.addStateListener((state) => {
        // While a prepare is in flight, the stop() that preceded it echoes
        // back over the bridge — acting on it killed the spinner and
        // unlocked the picker mid-synthesis. Preparing owns the phase.
        if (phaseRef.current === 'preparing' && (state === 'stopped' || state === 'paused')) return;
        if (state === 'playing') setPhase('playing');
        else if (state === 'paused') { setPhase('paused'); savePosition(elapsedRef.current); }
        else if (state === 'finished') {
          setPhase('finished');
          // Finished means "done" — don't resume at the last second next time.
          clearListenPosition(noteRef.current?.id);
          lastSaveRef.current = 0;
          setElapsed(0);
        }
        else if (state === 'buffering') { setPhase('buffering'); }
        else if (state === 'stopped') {
          setPhase('idle');
          setElapsed(0);
          // Stopping tears down the player, so whatever was loaded no longer
          // is. Without this, clearing the audio cache (which stops playback)
          // left the key matching a composition whose files were gone — play
          // did nothing at all.
          loadedForRef.current = null;
        }
      }),
      SpeechPlayer.addSynthProgressListener((e) => {
        // Marks arrive one per segment DURING the render, so the text can
        // follow the audio on a note's first play rather than only after
        // rendering finishes.
        const mt = (() => { try { return e?.markTime; } catch (_) { return undefined; } })();
        const mx = (() => { try { return e?.markText; } catch (_) { return undefined; } })();
        if (typeof mt === 'number' && mt >= 0 && typeof mx === 'string' && mx) {
          const list = cueRef.current;
          // Segments arrive in order, but guard anyway — a duplicate would
          // put the follower into a loop.
          if (!list.length || mt > list[list.length - 1].time) {
            list.push({ time: mt, text: mx });
            setCueCount(list.length);
          }
        }
        // Read defensively: Expo event payloads throw on a missing property
        // instead of returning undefined, so never destructure a key that
        // might not be in every event.
        const pick = (k) => { try { return e?.[k]; } catch (_) { return undefined; } };
        const progress = pick('progress');
        const r = pick('rendered');
        const marks = pick('marks');
        setSynthPct(typeof progress === 'number' ? progress : 0);
        if (typeof r === 'number' && r > 0) { renderedRef.current = r; setRendered(r); }
        // The full marks array only arrives with the completion event; until
        // then the scrub preview has nothing to work from.
        if (Array.isArray(marks) && marks.length) marksRef.current = marks;
      }),
      SpeechPlayer.addErrorListener((message) => {
        // Kept as defence in depth. The root cause was event-name collision:
        // SpeechFollow also declared "onError", so recognition failures
        // reached this playback handler too. SpeechFollow now emits
        // "onFollowError", which should make this filter dead code — but a
        // stray playback alert is worse than an unused guard, so it stays
        // until the rename is confirmed on device.
        if (/dictation|siri/i.test(String(message || ''))) return;
        setPhase('error');
        Alert.alert('Listen', message || 'Playback failed.');
      }),
    ];
    return () => {
      subsRef.current.forEach(s => { try { s.remove(); } catch (e) {} });
      subsRef.current = [];
      if (pendingSeekTimer.current) clearTimeout(pendingSeekTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  // Whenever the card opens, confirm the model is still there and warm it.
  useEffect(() => {
    if (!active) return;
    // Re-probe on open: the model may have arrived since last time.
    supertonicAvailable().then((ready) => {
      setStReady(ready);
      // Pre-warm: building the ONNX sessions costs about half a second, and
      // paying it here removes it from the gap after the play tap.
      const paths = modelPaths();
      if (ready && paths) SpeechPlayer.prepareSynthEngine(paths.modelDir).catch(() => {});
    }).catch(() => {});
  }, [active]);

  // Leaving the note doesn't stop playback, but it's a natural moment to
  // checkpoint — a force-quit after this still resumes correctly.
  useEffect(() => {
    if (active) return;
    if (phaseRef.current === 'playing' || phaseRef.current === 'paused') {
      savePosition(elapsedRef.current);
    }
  }, [active]);

  // Looping a single speech isn't a rehearsal need, and with loop on the
  // native module never reports `finished` — so the end-of-audio position
  // reset would never fire. Held off explicitly (a stale `loop: true` may
  // still be sitting in saved prefs from an earlier build).
  useEffect(() => { SpeechPlayer.setLoop(false); }, []);
  useEffect(() => { SpeechPlayer.setPlaybackRate(prefs.playbackRate || 1.0); }, [prefs.playbackRate]);

  // `attempt` drives a quiet retry. Tapping Listen the instant a note opens
  // can collide with the head start that's still rendering, and that is a
  // reason to WAIT, not to fail — the user asked for audio, and audio is
  // seconds away. Only a persistent failure is worth interrupting them for.
  async function prepareAndPlay(attempt = 0) {
    // No substitute voice. Hearing a different narrator mid-app reads as
    // something broken, not as a graceful degradation — so if James isn't
    // installed, Listen says so and plays nothing.
    // stReady is filled in by an async probe, and the HUD's play button
    // mounts this sheet and asks for playback in the same tick — so on a
    // first press the probe hasn't landed yet and stReady is still false.
    // Re-check before refusing, rather than blaming a missing voice for a
    // race.
    if (!stReady) {
      const ready = await supertonicAvailable();
      if (!ready) {
        setPhase('error');
        Alert.alert('Listen', "The narrator voice isn't installed yet.");
        return;
      }
      setStReady(true);
    }
    // The generation token still matters: a prepare superseded by a note
    // change or a stop must abort rather than play over its replacement.
    const gen = ++genRef.current;
    // Derived from the note's TEXT, not just its id: editing a note must
    // invalidate audio rendered from the old words. The previous key changed
    // only with the note id and pace, so after an edit this block was skipped
    // entirely and the stale composition replayed.
    const key = listenCacheKey(note, { wpm }) || `${note.id}|${wpm}`;
    try {
      if (loadedForRef.current !== key) {
        setPhase('preparing');
        setSynthPct(0);
        // Progressive: playback begins on the first segments while the
        // rest render underneath. The head start rendered when this note
        // opened usually means there is nothing to wait for at all.
        const [began, saved] = await Promise.all([
          beginListening(note, { wpm }),
          getListenPosition(note.id),
        ]);
        if (gen !== genRef.current) return;
        const d = began.estimatedDuration || 0;
        renderedRef.current = began.rendered || 0;
        setRendered(began.rendered || 0);
        speechTextRef.current = sanitizeForSynthesis(note.body).text || note.body;
        marksRef.current = [];   // arrives with the completion event
        cueRef.current = [];     // rebuilt as segments land
        setCueCount(0);
        setDuration(d || 0);
        loadedForRef.current = key;

        // Resume where this note was left off, clamped twice: to the
        // estimated duration (the note may have been edited shorter), and to
        // what's actually rendered — seeking to minute 12 of a render that
        // has reached minute 3 would stall.
        let start = 0;
        if (d > 0 && saved >= RESUME_MIN_SEC && saved < d - RESUME_TAIL_SEC) start = saved;
        if (renderedRef.current > 0 && start > renderedRef.current - 2) {
          start = Math.max(0, renderedRef.current - 2);
        }
        lastSaveRef.current = start;
        if (start > 0) seek(start); else setElapsed(0);
      }
      SpeechPlayer.play();
      setPhase('playing');
    } catch (e) {
      if (gen !== genRef.current) return;
      if (__DEV__) console.warn(`[listen] prepare attempt ${attempt + 1} failed:`, e?.message || e);

      if (attempt < PREPARE_RETRIES) {
        // Stay in 'preparing' so the card keeps saying "Preparing audio…"
        // rather than flashing an error and then working on the next tap.
        retryTimer.current = setTimeout(() => {
          if (gen === genRef.current) prepareAndPlay(attempt + 1);
        }, PREPARE_RETRY_MS);
        return;
      }
      setPhase('error');
      Alert.alert('Listen', 'Could not prepare the audio. ' + String(e?.message || e));
    }
  }

  function togglePlay() {
    if (phase === 'playing') { SpeechPlayer.pause(); return; }

    // Resuming is only valid while the loaded audio still matches the note.
    // Edit a note and come back, and the phase is 'paused' or 'finished' —
    // this used to call play() straight through, replaying audio rendered
    // from the OLD words while the screen showed the new ones. The key check
    // lived in prepareAndPlay, which those branches never reached.
    const key = listenCacheKey(note, { wpm }) || `${note.id}|${wpm}`;
    const loadedIsCurrent = loadedForRef.current === key;

    if (loadedIsCurrent && (phase === 'paused' || phase === 'finished')) {
      SpeechPlayer.play();
      setPhase('playing');
      return;
    }
    prepareAndPlay();
  }

  // Ends the listening session outright — the long-press exit. Saves where
  // you were (so a later play resumes there) and cancels any in-flight
  // render, since nobody asked for the rest of the audio.
  function stop() {
    savePosition(elapsedRef.current);
    genRef.current += 1;                  // disown any prepare in flight
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    SpeechPlayer.cancelProgressive();
    SpeechPlayer.stop();
    loadedForRef.current = null;
  }

  function restart() {
    if (!durationRef.current) return;
    const t = seek(0);
    savePosition(t);
  }

  function nudge(delta) {
    if (!durationRef.current) return;
    const t = seek(elapsedRef.current + delta);
    savePosition(t);
  }

  async function cycleRate() {
    const i = RATE_STEPS.indexOf(prefs.playbackRate);
    const next = RATE_STEPS[(i + 1 + RATE_STEPS.length) % RATE_STEPS.length] ?? 1.0;
    const saved = await setListenPrefs({ playbackRate: next });
    setPrefs(p => ({ ...p, playbackRate: saved.playbackRate }));
  }


  // Paragraph preview at an arbitrary time — used while dragging the HUD
  // scrubber. Reads the marks TIME → PARAGRAPH, the exact direction.
  function previewAt(t) {
    return paragraphAtTime(marksRef.current, t, speechTextRef.current || note.body);
  }

  // The cue playing at `t` — the last one that has already started.
  function cueAt(t) {
    const list = cueRef.current;
    if (!list.length) return null;
    let found = null;
    for (const c of list) {
      if (c.time <= t + 0.01) found = c;
      else break;
    }
    return found;
  }

  // The current cue AND the one after it. The follower needs both: the pair
  // bounds the paragraph in time and in text, which is what lets it scroll
  // through a paragraph that's taller than the screen instead of jumping
  // once and letting the voice walk off the bottom.
  function cueSpanAt(t) {
    const list = cueRef.current;
    if (!list.length) return { cue: null, next: null };
    let i = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k].time <= t + 0.01) i = k; else break;
    }
    if (i < 0) return { cue: null, next: null };
    return { cue: list[i], next: i + 1 < list.length ? list[i + 1] : null };
  }

  return {
    // state
    phase, elapsed, duration, rendered, synthPct, stReady, cueCount,
    playbackRate: prefs.playbackRate,
    playing: phase === 'playing',
    busy: phase === 'preparing',
    // actions
    play: togglePlay, pause: () => SpeechPlayer.pause(),
    seek, restart, nudge, cycleRate, savePosition, previewAt, stop, cueAt, cueSpanAt,
  };
}
