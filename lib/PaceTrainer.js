// lib/PaceTrainer.js
// Speaking-pace trainer: the user reads three short passages aloud, timing each
// with a simple stopwatch (no speech recognition). WPM per round = words / sec
// * 60; the three rounds are averaged and offered as the new Speaking Pace.
// Self-contained modal — takes the theme colors, a scaling fn, and callbacks.
import { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Three original passages (~120 words each). Word counts are fixed constants so
// the measurement doesn't depend on re-counting at runtime.
const PASSAGES = [
  {
    words: 120,
    text: "Every great endeavor begins with a single, quiet decision. Long before the applause, before the results anyone can see, there is a moment when a person chooses to begin. That moment rarely feels dramatic. It often arrives on an ordinary afternoon, disguised as a small idea that refuses to leave. The people we admire most were not born certain of their path. They simply decided to take one honest step, and then another, trusting that clarity would arrive along the way. Courage is not the absence of doubt. It is the willingness to move forward while the doubt is still present. So begin where you are, with what you have, and let the rest unfold in its own good time.",
  },
  {
    words: 118,
    text: "The most powerful thing you can offer another person is your full attention. In a world designed to distract us, presence has become rare, and rare things are valuable. When you truly listen, without planning your reply, you give someone the sense that they matter. That feeling stays with people far longer than any clever advice. Think of the conversations that changed you. Chances are, they were not the ones where someone spoke brilliantly, but the ones where someone listened completely. We spend years learning how to speak well, yet almost no time learning how to listen well. Perhaps the finest gift we can give is simply to be there, quietly, for the person in front of us.",
  },
  {
    words: 116,
    text: "Progress is rarely a straight line, and it almost never moves as quickly as we would like. Most meaningful work happens in the unglamorous middle, long after the excitement of starting has faded and long before the reward of finishing appears. This is the stretch where most people quit, not because they lack talent, but because they mistake slowness for failure. But slow is not the same as stopped. A river shapes a canyon not through force, but through patience, returning to the same path day after day. Whatever you are building, trust the quiet accumulation of small efforts. Show up again tomorrow, and the day after that. In time, the results will speak for themselves.",
  },
];

const ROUNDS = PASSAGES.length;

export default function PaceTrainer({ visible, colors, uis, uit, onApply, onClose }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isTablet = Math.min(width, height) >= 700;
  const isLandscape = width > height;
  // Cap content width on large/landscape screens so text lines stay readable
  // instead of stretching edge-to-edge on an iPad.
  const contentMaxWidth = isTablet ? 640 : (isLandscape ? 560 : 520);

  // phase: 'intro' | 'reading' | 'roundDone' | 'allDone'
  const [phase, setPhase] = useState('intro');
  const [round, setRound] = useState(0);           // 0-based index into PASSAGES
  const [results, setResults] = useState([]);      // wpm per completed round
  const startRef = useRef(0);
  const [lastWpm, setLastWpm] = useState(0);

  // Track whether the passage has more text below the fold, to show/hide the
  // bottom fade + chevron cue. Recomputed on layout, content size, and scroll.
  const [moreBelow, setMoreBelow] = useState(false);
  const passageContentH = useRef(0);
  const passageViewH = useRef(0);
  const passageScrollY = useRef(0);
  function recomputeMore() {
    const c = passageContentH.current, v = passageViewH.current, y = passageScrollY.current;
    // "more below" if content exceeds the view AND we're not near the bottom.
    setMoreBelow(c > v + 4 && y < c - v - 8);
  }
  function onPassageScroll(e) {
    passageScrollY.current = e.nativeEvent.contentOffset.y;
    recomputeMore();
  }

  function reset() {
    setPhase('intro'); setRound(0); setResults([]); setLastWpm(0); startRef.current = 0;
  }

  function start() {
    passageScrollY.current = 0;
    startRef.current = Date.now();
    setPhase('reading');
  }

  function stop() {
    const secs = (Date.now() - startRef.current) / 1000;
    // Guard against absurdly fast taps (misfire) — need a few seconds to be real.
    const wpm = secs > 3 ? Math.round((PASSAGES[round].words / secs) * 60) : 0;
    setLastWpm(wpm);
    setPhase('roundDone');
  }

  function keepAndAdvance() {
    const next = [...results, lastWpm];
    setResults(next);
    if (round + 1 >= ROUNDS) {
      setPhase('allDone');
    } else {
      passageScrollY.current = 0;
      setRound(round + 1);
      setPhase('reading');
      startRef.current = Date.now();      // auto-start the next reading
    }
  }

  function redo() {
    passageScrollY.current = 0;
    setPhase('reading');
    startRef.current = Date.now();
  }

  const average = results.length
    ? Math.round(results.reduce((a, b) => a + b, 0) / results.length)
    : 0;

  function close() { reset(); onClose(); }
  function apply() { onApply(average); reset(); onClose(); }

  const s = makeStyles(colors, uis, uit, insets, isTablet, contentMaxWidth);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
      <View style={s.screen}>
        <View style={s.header}>
          <Text style={s.headerTitle}>Measure Your Pace</Text>
          <TouchableOpacity onPress={close} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.headerClose}>Close</Text>
          </TouchableOpacity>
        </View>

        {phase === 'intro' && (
          <ScrollView style={s.bodyScroll} contentContainerStyle={s.body}>
            <Text style={s.h1}>Find your speaking pace</Text>
            <Text style={s.p}>
              Speak at your normal public-speaking pace. For an accurate measurement,
              complete {ROUNDS} short readings — we'll average them.
            </Text>
            <Text style={s.p}>
              For each one: tap Start, read the passage aloud at a natural pace, then
              tap I'm Done. If you're interrupted, you can stop and take it again later.
            </Text>
            <TouchableOpacity style={s.primaryBtn} onPress={start}>
              <Text style={s.primaryBtnText}>Start Reading 1 of {ROUNDS}</Text>
            </TouchableOpacity>
          </ScrollView>
        )}

        {phase === 'reading' && (
          <View style={s.bodyOuter}>
            <View style={s.bodyFill}>
              <Text style={s.roundLabel}>Reading {round + 1} of {ROUNDS} — read aloud</Text>
              <View style={s.passageBox}>
                <ScrollView
                  style={s.passageScroll}
                  contentContainerStyle={s.passageWrap}
                  scrollEventThrottle={16}
                  onScroll={onPassageScroll}
                  onContentSizeChange={(w, h) => { passageContentH.current = h; }}
                  onLayout={(e) => { passageViewH.current = e.nativeEvent.layout.height; recomputeMore(); }}
                >
                  <Text style={s.passage}>{PASSAGES[round].text}</Text>
                </ScrollView>
                {moreBelow && (
                  <>
                    {/* Faux fade: stacked low-opacity bands of the bg color, so
                        the text visibly softens at the bottom — a "more below"
                        cue without a gradient dependency. Hidden once scrolled
                        to the end. */}
                    <View pointerEvents="none" style={[s.fade, s.fade1]} />
                    <View pointerEvents="none" style={[s.fade, s.fade2]} />
                    <View pointerEvents="none" style={[s.fade, s.fade3]} />
                    <View pointerEvents="none" style={s.moreHint}>
                      <Text style={s.moreHintText}>⌄</Text>
                    </View>
                  </>
                )}
              </View>
              <TouchableOpacity style={s.primaryBtn} onPress={stop}>
                <Text style={s.primaryBtnText}>I'm Done</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.textBtn} onPress={close}>
                <Text style={s.textBtnText}>Stop and take again later</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {phase === 'roundDone' && (
          <ScrollView style={s.bodyScroll} contentContainerStyle={s.body}>
            {lastWpm > 0 ? (
              <>
                <Text style={s.bigNumber}>{lastWpm}</Text>
                <Text style={s.bigUnit}>words per minute</Text>
                <Text style={s.p}>Reading {round + 1} of {ROUNDS} complete.</Text>
                <TouchableOpacity style={s.primaryBtn} onPress={keepAndAdvance}>
                  <Text style={s.primaryBtnText}>
                    {round + 1 >= ROUNDS ? 'See My Average' : `Next Reading (${round + 2} of ${ROUNDS})`}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.textBtn} onPress={redo}>
                  <Text style={s.textBtnText}>Redo this reading</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={s.p}>That was too quick to measure — please read the whole passage aloud.</Text>
                <TouchableOpacity style={s.primaryBtn} onPress={redo}>
                  <Text style={s.primaryBtnText}>Try This Reading Again</Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        )}

        {phase === 'allDone' && (
          <ScrollView style={s.bodyScroll} contentContainerStyle={s.body}>
            <Text style={s.h1}>Your speaking pace</Text>
            <Text style={s.bigNumber}>{average}</Text>
            <Text style={s.bigUnit}>words per minute</Text>
            <Text style={s.breakdown}>
              Readings: {results.join(' · ')} wpm
            </Text>
            <TouchableOpacity style={s.primaryBtn} onPress={apply}>
              <Text style={s.primaryBtnText}>Use This Pace</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.textBtn} onPress={reset}>
              <Text style={s.textBtnText}>Start Over</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.textBtn} onPress={close}>
              <Text style={s.textBtnText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function makeStyles(colors, uis, uit, insets, isTablet, contentMaxWidth) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: uis(20),
      paddingTop: insets.top + uis(12),      // clear the status bar / notch
      paddingBottom: uis(12),
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
      backgroundColor: colors.headerBg,
    },
    headerTitle: { fontSize: uit(18), fontWeight: '700', color: colors.text, letterSpacing: -0.2 },
    headerClose: { fontSize: uit(16), fontWeight: '700', color: colors.text },
    // Outer fills the screen; inner columns handle their own width capping.
    bodyOuter: { flex: 1 },
    bodyScroll: { flex: 1, width: '100%' },
    body: {
      width: '100%', maxWidth: contentMaxWidth, alignSelf: 'center',
      paddingHorizontal: uis(24),
      paddingTop: uis(20),
      paddingBottom: insets.bottom + uis(24),
      justifyContent: 'center', flexGrow: 1,
    },
    // Reading phase: fill the height (top-aligned) so the passage area can flex
    // and use the available space, rather than centering to content height.
    bodyFill: {
      flex: 1,
      width: '100%', maxWidth: contentMaxWidth, alignSelf: 'center',
      paddingHorizontal: uis(24),
      paddingTop: uis(20),
      paddingBottom: insets.bottom + uis(24),
    },
    h1: { fontSize: uit(isTablet ? 30 : 24), fontWeight: '700', color: colors.text, marginBottom: uis(16), textAlign: 'center' },
    p: { fontSize: uit(16), lineHeight: uit(24), color: colors.textMuted, marginBottom: uis(16), textAlign: 'center' },
    roundLabel: { fontSize: uit(14), fontWeight: '600', color: colors.textMuted, marginBottom: uis(12), textAlign: 'center' },
    // The passage area flexes to fill the space between the label and the
    // button, so the text uses the available height instead of collapsing.
    passageScroll: { flex: 1 },
    passageBox: { flex: 1, position: 'relative', marginBottom: uis(20) },
    passageWrap: { paddingVertical: uis(8) },
    passage: { fontSize: uit(isTablet ? 24 : 20), lineHeight: uit(isTablet ? 38 : 32), color: colors.text },
    // Faux-gradient fade: three stacked bands of the bg color at rising opacity.
    fade: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.bg },
    fade1: { height: uis(36), opacity: 0.35 },
    fade2: { height: uis(22), opacity: 0.55 },
    fade3: { height: uis(10), opacity: 0.85 },
    moreHint: { position: 'absolute', bottom: uis(2), left: 0, right: 0, alignItems: 'center' },
    moreHintText: { fontSize: uit(22), lineHeight: uit(22), color: colors.textMuted, fontWeight: '700' },
    primaryBtn: {
      backgroundColor: '#15803d', borderRadius: uis(12), paddingVertical: uis(16),
      alignItems: 'center', marginTop: uis(8),
    },
    primaryBtnText: { color: '#fff', fontSize: uit(17), fontWeight: '700' },
    textBtn: { alignItems: 'center', paddingVertical: uis(12), marginTop: uis(4) },
    textBtnText: { color: colors.textMuted, fontSize: uit(15), fontWeight: '500' },
    bigNumber: { fontSize: uit(isTablet ? 80 : 64), fontWeight: '800', color: colors.text, textAlign: 'center', letterSpacing: -1 },
    bigUnit: { fontSize: uit(16), color: colors.textMuted, textAlign: 'center', marginBottom: uis(20) },
    breakdown: { fontSize: uit(15), color: colors.textMuted, textAlign: 'center', marginBottom: uis(24) },
  });
}
