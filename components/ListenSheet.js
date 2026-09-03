// File: ListenSheet.js → ~/Projects/podiumnotes/components/ListenSheet.js
//
// Listen mode's player — a bottom card over the presenter. Drives the
// SpeechPlayer native module through lib/listen.js.
//
// Design notes:
//   • Stays MOUNTED once opened (the screen toggles `open`); closing the
//     card does NOT stop playback — that's the car flow: start it, close
//     the card, lock the phone, control from the lock screen / steering
//     wheel. Stop is an explicit button.
//   • Synthesis state is always visible ("Preparing audio…") — the silent
//     working pause was the #1 confusion in module smoke testing.
//   • Voice picker lists every installed English voice, best quality first,
//     with a pointer to Settings for devices that only have the basic ones.
//     Switching voice re-renders the note's audio once (cache keyed on voice).

import { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, StyleSheet, ActivityIndicator,
  ScrollView, Alert,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import * as SpeechPlayer from '../modules/speech-player';
import { getListenPrefs, setListenPrefs, ensureAudio, timeForOffset } from '../lib/listen';
import { ui } from '../lib/scale';

const RATE_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ListenSheet({ open, note, wpm, colors, insets, getBandOffset, onClose }) {
  // phase: idle | preparing | ready | playing | paused | finished | error
  const [phase, _setPhase] = useState('idle');
  const phaseRef = useRef('idle');     // sync mirror — event handlers must not act on stale state
  const setPhase = (p) => { phaseRef.current = p; _setPhase(p); };
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [voices, setVoices] = useState([]);
  const [prefs, setPrefs] = useState({ voiceId: null, playbackRate: 1.0, loop: false });
  const [pickerOpen, setPickerOpen] = useState(false);
  const loadedForRef = useRef(null);   // `${noteId}|${voiceId}|${wpm}` currently loaded
  const subsRef = useRef([]);
  const barW = useRef(0);              // progress bar width for tap-to-seek
  const genRef = useRef(0);            // prepare-generation token: latest request wins
  const marksRef = useRef([]);         // paragraph → time map for the loaded audio

  // Voices + prefs load once; module event subscriptions live for the
  // sheet's (mounted-forever) lifetime.
  useEffect(() => {
    (async () => {
      try {
        const [v, p] = await Promise.all([SpeechPlayer.getVoices(), getListenPrefs()]);
        setVoices(v);
        // Default voice: persisted choice if still installed, else best quality.
        const valid = p.voiceId && v.some(x => x.id === p.voiceId);
        setPrefs({ ...p, voiceId: valid ? p.voiceId : (v[0]?.id ?? null) });
      } catch (e) {}
    })();
    subsRef.current = [
      SpeechPlayer.addProgressListener(({ elapsed, duration }) => {
        setElapsed(elapsed);
        if (duration > 0) setDuration(duration);
      }),
      SpeechPlayer.addStateListener((state) => {
        // While a prepare is in flight, the stop() that preceded it echoes
        // back over the bridge — acting on it killed the spinner and
        // unlocked the picker mid-synthesis. Preparing owns the phase.
        if (phaseRef.current === 'preparing' && (state === 'stopped' || state === 'paused')) return;
        if (state === 'playing') setPhase('playing');
        else if (state === 'paused') setPhase('paused');
        else if (state === 'finished') setPhase('finished');
        else if (state === 'stopped') { setPhase('idle'); setElapsed(0); }
      }),
      SpeechPlayer.addErrorListener((message) => {
        setPhase('error');
        Alert.alert('Listen', message || 'Playback failed.');
      }),
    ];
    return () => {
      subsRef.current.forEach(s => { try { s.remove(); } catch (e) {} });
      subsRef.current = [];
    };
  }, []);

  // Refresh the voice inventory whenever the card opens, so voices
  // downloaded in Settings appear without an app restart.
  useEffect(() => {
    if (!open) return;
    SpeechPlayer.getVoices().then(setVoices).catch(() => {});
  }, [open]);

  // The band is the cursor, on demand: jump the audio to the paragraph the
  // band is sitting on RIGHT NOW. Fired by the "Start at band" button (the
  // card is non-modal — scroll the speech with the player open, then tap)
  // and on card open when not actively playing.
  function jumpToBand() {
    const off = getBandOffset ? getBandOffset() : 0;
    if (!duration) {
      // Nothing loaded yet — preparing will pull the offset itself.
      if (phaseRef.current === 'idle') prepareAndPlay();
      return;
    }
    const t = timeForOffset(marksRef.current, off, note.body.length, duration);
    if (__DEV__) console.log('[listen] jumpToBand: offset', off, '→', t.toFixed(1) + 's');
    SpeechPlayer.seekTo(t);
    setElapsed(t);
  }

  useEffect(() => {
    if (!open || !duration) return;
    if (phaseRef.current === 'paused' || phaseRef.current === 'finished') jumpToBand();
  }, [open]);

  // Keep native loop/rate in line with prefs.
  useEffect(() => { SpeechPlayer.setLoop(!!prefs.loop); }, [prefs.loop]);
  useEffect(() => { SpeechPlayer.setPlaybackRate(prefs.playbackRate || 1.0); }, [prefs.playbackRate]);

  async function prepareAndPlay(voiceIdOverride) {
    // Explicit voice avoids the stale-closure race that made a mid-play
    // voice switch re-render the OLD voice; the generation token makes any
    // superseded prepare abort instead of playing over the new one.
    const voiceId = voiceIdOverride !== undefined ? voiceIdOverride : prefs.voiceId;
    const gen = ++genRef.current;
    const key = `${note.id}|${voiceId || 'default'}|${wpm}`;
    try {
      if (loadedForRef.current !== key) {
        setPhase('preparing');
        const { uri, marks } = await ensureAudio(note, { voiceId, wpm });
        if (gen !== genRef.current) return;
        const { duration: d } = await SpeechPlayer.load(uri, note.title || 'Podium Notes');
        if (gen !== genRef.current) return;
        marksRef.current = marks || [];
        setDuration(d || 0);
        loadedForRef.current = key;
        // Start at the paragraph containing the band line — the offset is
        // PULLED at this instant (never a stale prop), mapped to the
        // paragraph's exact start via the synthesis marks.
        const off = getBandOffset ? getBandOffset() : 0;
        const t = timeForOffset(marksRef.current, off, note.body.length, d);
        if (__DEV__) console.log('[listen] load seek: offset', off, '→', t.toFixed(1) + 's of', (d || 0).toFixed(1) + 's,', (marks || []).length, 'marks');
        if (t > 0.5) SpeechPlayer.seekTo(t);
        setElapsed(t);
      }
      SpeechPlayer.play();
      setPhase('playing');
    } catch (e) {
      if (gen !== genRef.current) return;
      setPhase('error');
      Alert.alert('Listen', 'Could not prepare the audio. ' + String(e?.message || e));
    }
  }

  function togglePlay() {
    if (phase === 'playing') { SpeechPlayer.pause(); return; }
    if (phase === 'paused' || phase === 'finished') { SpeechPlayer.play(); setPhase('playing'); return; }
    prepareAndPlay();
  }

  function handleStop() {
    SpeechPlayer.stop();
    loadedForRef.current = null;
  }

  async function chooseVoice(voiceId) {
    if (phaseRef.current === 'preparing') return;  // one render at a time — native rejects overlaps
    setPickerOpen(false);
    if (voiceId === prefs.voiceId) return;
    await setListenPrefs({ voiceId });
    setPrefs(p => ({ ...p, voiceId }));
    const wasActive = phase === 'playing' || phase === 'paused';
    SpeechPlayer.stop();
    loadedForRef.current = null;
    setElapsed(0);
    setDuration(0);
    if (wasActive) {
      prepareAndPlay(voiceId);              // explicit — never the stale closure
    } else {
      setPhase('idle');
    }
  }

  async function cycleRate() {
    const i = RATE_STEPS.indexOf(prefs.playbackRate);
    const next = RATE_STEPS[(i + 1 + RATE_STEPS.length) % RATE_STEPS.length] ?? 1.0;
    const saved = await setListenPrefs({ playbackRate: next });
    setPrefs(p => ({ ...p, playbackRate: saved.playbackRate }));
  }

  async function toggleLoop() {
    const saved = await setListenPrefs({ loop: !prefs.loop });
    setPrefs(p => ({ ...p, loop: saved.loop }));
  }

  function seekFromBar(e, barWidth) {
    if (!duration || barWidth <= 0) return;
    const x = e.nativeEvent.locationX;
    const target = Math.max(0, Math.min(duration, (x / barWidth) * duration));
    SpeechPlayer.seekTo(target);
    setElapsed(target);
  }

  if (!open) return null;

  const currentVoice = voices.find(v => v.id === prefs.voiceId);
  const busy = phase === 'preparing';
  const playing = phase === 'playing';
  const qualityLabel = (q) => (q === 3 ? 'Premium' : q === 2 ? 'Enhanced' : 'Basic');
  // Some iOS voices bake the tier into the name ("Zoe (Premium)") — strip it
  // so our badge doesn't duplicate it.
  const displayName = (v) => v.name.replace(/\s*\((Premium|Enhanced|Compact)\)\s*$/i, '');

  return (
    <>
      {/* Non-modal: no backdrop — the speech stays scrollable behind the
          card, so "pause → scroll → Start at band → play" needs no closing
          and reopening. Close via the chevron; playback continues. */}
      <View style={[styles.card, {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        paddingBottom: (insets?.bottom ?? 0) + ui(14),
      }]}>
        {/* Header: title + close */}
        <View style={styles.headRow}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {note.title || 'Listen'}
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <SymbolView name="chevron.down" size={ui(20)} tintColor={colors.textMuted} type="monochrome" />
          </TouchableOpacity>
        </View>

        {/* Voice row → opens the picker */}
        <TouchableOpacity
          style={[styles.voiceRow, { borderColor: colors.border }]}
          onPress={() => setPickerOpen(o => !o)}
        >
          <SymbolView name="person.wave.2" size={ui(18)} tintColor={colors.textMuted} type="monochrome" />
          <Text style={[styles.voiceName, { color: colors.text }]} numberOfLines={1}>
            {currentVoice ? `${displayName(currentVoice)} · ${qualityLabel(currentVoice.quality)}` : 'System voice'}
          </Text>
          <SymbolView name={pickerOpen ? 'chevron.up' : 'chevron.down'} size={ui(14)} tintColor={colors.textMuted} type="monochrome" />
        </TouchableOpacity>

        {pickerOpen && (
          <View style={[styles.picker, { borderColor: colors.border }]}>
            <ScrollView style={{ maxHeight: ui(180) }}>
              {voices.map(v => (
                <TouchableOpacity key={v.id} style={[styles.pickerRow, busy && { opacity: 0.4 }]} onPress={() => chooseVoice(v.id)} disabled={busy}>
                  <Text style={[styles.pickerName, { color: colors.text, fontWeight: v.id === prefs.voiceId ? '700' : '400' }]}>
                    {displayName(v)}
                  </Text>
                  <Text style={[styles.pickerQuality, { color: colors.textMuted }]}>
                    {qualityLabel(v.quality)} · {v.language}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <Text style={[styles.pickerHint, { color: colors.textMuted }]}>
              More natural voices: Settings → Accessibility → Spoken Content → Voices
            </Text>
          </View>
        )}

        {/* Start at band — pull the band's position now and jump there */}
        <TouchableOpacity
          style={[styles.bandJump, { borderColor: colors.border }]}
          onPress={jumpToBand}
          disabled={busy}
        >
          <SymbolView name="arrow.down.to.line" size={ui(15)} tintColor={colors.accent} type="monochrome" />
          <Text style={[styles.bandJumpText, { color: colors.text }]}>Start at band</Text>
        </TouchableOpacity>

        {/* Progress bar (tap to seek) */}
        <Pressable
          onLayout={e => { barW.current = e.nativeEvent.layout.width; }}
          onPress={e => seekFromBar(e, barW.current)}
          style={[styles.barTrack, { backgroundColor: colors.border }]}
          disabled={busy || !duration}
        >
          <View style={[styles.barFill, {
            backgroundColor: colors.accent,
            width: duration ? `${Math.min(100, (elapsed / duration) * 100)}%` : '0%',
          }]} />
        </Pressable>
        <View style={styles.timeRow}>
          <Text style={[styles.time, { color: colors.textMuted }]}>{fmt(elapsed)}</Text>
          <Text style={[styles.time, { color: colors.textMuted }]}>
            {busy ? 'Preparing audio…' : duration ? `-${fmt(Math.max(0, duration - elapsed))}` : ' '}
          </Text>
        </View>

        {/* Transport */}
        <View style={styles.transport}>
          <TouchableOpacity
            onPress={toggleLoop}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{ opacity: prefs.loop ? 1 : 0.4 }}
          >
            <SymbolView name="repeat" size={ui(22)} tintColor={prefs.loop ? colors.accent : colors.textMuted} type="monochrome" />
          </TouchableOpacity>

          <TouchableOpacity onPress={() => SpeechPlayer.seekTo(Math.max(0, elapsed - 15))} disabled={busy || !duration} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
            <SymbolView name="gobackward.15" size={ui(26)} tintColor={colors.text} type="monochrome" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.playBtn, { backgroundColor: colors.accent }]}
            onPress={togglePlay}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color={colors.accentText ?? '#fff'} />
              : <SymbolView name={playing ? 'pause.fill' : 'play.fill'} size={ui(26)} tintColor={colors.accentText ?? '#fff'} type="monochrome" />}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => SpeechPlayer.seekTo(Math.min(duration, elapsed + 15))} disabled={busy || !duration} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
            <SymbolView name="goforward.15" size={ui(26)} tintColor={colors.text} type="monochrome" />
          </TouchableOpacity>

          <TouchableOpacity onPress={cycleRate} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={[styles.rateText, { color: colors.text }]}>{prefs.playbackRate}×</Text>
          </TouchableOpacity>
        </View>

        {/* Stop — the explicit end; closing the card keeps playing */}
        {(playing || phase === 'paused') && (
          <TouchableOpacity style={styles.stopRow} onPress={handleStop}>
            <Text style={[styles.stopText, { color: colors.textMuted }]}>Stop listening</Text>
          </TouchableOpacity>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 31,
    borderTopLeftRadius: ui(18), borderTopRightRadius: ui(18),
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: ui(18), paddingTop: ui(14),
    shadowColor: '#000', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 12,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: ui(10) },
  title: { fontSize: ui(16), fontWeight: '700', flex: 1, marginRight: ui(10) },
  voiceRow: {
    flexDirection: 'row', alignItems: 'center', gap: ui(8),
    borderWidth: 1, borderRadius: ui(9),
    paddingHorizontal: ui(12), paddingVertical: ui(8), marginBottom: ui(12),
  },
  voiceName: { flex: 1, fontSize: ui(14), fontWeight: '600' },
  bandJump: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: ui(6),
    borderWidth: 1, borderRadius: ui(9),
    paddingVertical: ui(8), marginBottom: ui(12),
  },
  bandJumpText: { fontSize: ui(13), fontWeight: '700' },
  picker: { borderWidth: 1, borderRadius: ui(9), marginBottom: ui(12), overflow: 'hidden' },
  pickerRow: { paddingHorizontal: ui(12), paddingVertical: ui(9) },
  pickerName: { fontSize: ui(14) },
  pickerQuality: { fontSize: ui(11), marginTop: 1 },
  pickerHint: { fontSize: ui(11), padding: ui(10), paddingTop: ui(6) },
  barTrack: { height: ui(6), borderRadius: ui(3), overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: ui(3) },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: ui(4), marginBottom: ui(10) },
  time: { fontSize: ui(12), fontVariant: ['tabular-nums'] },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: ui(6) },
  playBtn: {
    width: ui(56), height: ui(56), borderRadius: ui(28),
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.15, shadowRadius: 6, elevation: 6,
  },
  rateText: { fontSize: ui(15), fontWeight: '700', minWidth: ui(40), textAlign: 'center' },
  stopRow: { alignItems: 'center', marginTop: ui(12) },
  stopText: { fontSize: ui(13), fontWeight: '600' },
});
