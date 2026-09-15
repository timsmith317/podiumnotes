// app/settings/index.js
import { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Pressable, useColorScheme,
  Linking, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useSettings, themeColors } from '../../lib/useSettings';
import { uis, uit } from '../../lib/scale';
import { bandFillColor, bandBorderColor } from '../../lib/bandColor';
import { getDiagnostics, SYNC_STATUS } from '../../lib/sync';
import { audioCacheBytes, clearAudioCache } from '../../lib/listen';
import PaceTrainer from '../../lib/PaceTrainer';

// Sizes are shown in whole units: nobody reading a storage row wants three
// decimal places, and "Zero KB" reads better than "0 B" for an empty cache.
function formatBytes(n) {
  if (!n || n < 1024) return 'Zero KB';
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${Math.round(n / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// Human-readable relative time for "last sync". Kept tiny — this only ever
// formats a recent-ish timestamp for the diagnostics panel.
function relTime(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// Status → dot color. The three signal colors are fixed so they read the same
// across every theme; idle / no-account fall back to the theme's muted tone.
function statusColor(status, colors) {
  switch (status) {
    case SYNC_STATUS.SYNCING: return '#15803d';   // green
    case SYNC_STATUS.ERROR:   return '#b91c1c';   // red
    case SYNC_STATUS.OFFLINE: return '#b45309';   // amber
    default:                  return colors.textMuted;  // idle / no-account
  }
}

const THEME_OPTIONS = [
  { label: 'System', value: 'system' },
  { label: 'Light',  value: 'light'  },
  { label: 'Dark',   value: 'dark'   },
  { label: 'Sepia',  value: 'sepia'  },
  { label: 'Ice',    value: 'ice'    },
];

// Band color applied when a theme is selected. The user can change the band
// afterward; switching theme again re-applies that theme's default.
const THEME_BAND_DEFAULT = {
  system: '#15803d',  // Green
  light:  '#15803d',  // Green
  dark:   '#94a3b8',  // Subtle
  sepia:  '#b45309',  // Amber
  ice:    '#0284c7',  // Sky
};

const FONT_OPTIONS = [
  { label: 'System', value: 'system' },
  { label: 'Serif',  value: 'serif'  },
  { label: 'Mono',   value: 'mono'   },
];

const LINE_OPTIONS = [
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
];

const POS_OPTIONS = [
  { label: 'Top',    value: 30 },
  { label: 'Center', value: 45 },
  { label: 'Bottom', value: 60 },
];

// Speaking pace stepper. Range is intentionally wide — most presenters land
// between 130 and 160, but slower deliberate speakers and faster auctioneer-
// adjacent ones both happen. Step of 5 is precise enough to tune by feel
// without being twitchy on the buttons.
const WPM_MIN  = 80;
const WPM_MAX  = 220;
const WPM_STEP = 5;

const BAND_COLORS = [
  { label: 'Clear',    value: 'clear' },
  { label: 'Subtle',   value: '#94a3b8' },
  { label: 'Slate',    value: '#475569' },
  { label: 'Green',    value: '#15803d' },
  { label: 'Emerald',  value: '#059669' },
  { label: 'Teal',     value: '#0d9488' },
  { label: 'Sky',      value: '#0284c7' },
  { label: 'Blue',     value: '#1d4ed8' },
  { label: 'Indigo',   value: '#4338ca' },
  { label: 'Purple',   value: '#7c3aed' },
  { label: 'Fuchsia',  value: '#a21caf' },
  { label: 'Rose',     value: '#be123c' },
  { label: 'Red',      value: '#b91c1c' },
  { label: 'Orange',   value: '#c2410c' },
  { label: 'Amber',    value: '#b45309' },
  { label: 'Yellow',   value: '#a16207' },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, update } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);

  const [trainerOpen, setTrainerOpen] = useState(false);
  // Hidden sync diagnostics — revealed by long-pressing the "Settings" title.
  // Status and pending count change over time, so while the panel is open we
  // re-read getDiagnostics() once a second. getDiagnostics() is a cheap
  // module-state snapshot and is valid even before CloudKit is wired, so this
  // is safe to ship ahead of the sync call sites being finalized.
  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState(null);
  // null until measured, so the row shows a placeholder rather than briefly
  // claiming the cache is empty.
  const [cacheBytes, setCacheBytes] = useState(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    audioCacheBytes()
      .then(n => { if (alive) setCacheBytes(n); })
      .catch(() => { if (alive) setCacheBytes(0); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!diagOpen) return;
    const refresh = () => { try { setDiag(getDiagnostics()); } catch (e) { setDiag(null); } };
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [diagOpen]);

  function SectionLabel({ label }) {
    return <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{label}</Text>;
  }

  function SegRow({ options, current, onSelect, wrap }) {
    return (
      <View style={[styles.seg, wrap && styles.segWrap]}>
        {options.map(opt => {
          const on = current === opt.value;
          return (
            <TouchableOpacity
              key={String(opt.value)}
              style={[
                styles.segBtn,
                wrap ? styles.segBtnWrap : styles.segBtnFlex,
                { backgroundColor: colors.surface, borderColor: colors.border },
                on && { backgroundColor: colors.accent, borderColor: colors.accentBorder },
              ]}
              onPress={() => onSelect(opt.value)}
            >
              <Text style={[styles.segBtnText, { color: colors.textMuted }, on && { color: colors.accentText }]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }

  const selectedColorLabel = BAND_COLORS.find(c => c.value === settings.bandColor)?.label ?? '';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>

      {/* Custom header. paddingTop is a small fixed value (uis(6)) rather
          than insets.top — the modal presentation on iPad reports a small
          nonzero insets.top from formSheet/pageSheet chrome that we don't
          want to also pad against. On iPhone in full-screen modal this
          would put content under the status bar, but that presentation
          isn't in use here. */}
      <View style={[styles.header, {
        paddingTop: uis(12),
        paddingBottom: uis(10),
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: colors.headerBg,
        borderBottomColor: colors.border,
      }]}>
        <View style={styles.headerInner}>
          <View style={styles.headerSide} />
          <Text
            style={[styles.headerTitle, { color: colors.text }]}
            onLongPress={() => setDiagOpen(true)}
            delayLongPress={600}
            suppressHighlighting
          >
            Settings
          </Text>
          <View style={[styles.headerSide, styles.headerSideRight]}>
            <TouchableOpacity
              onPress={() => router.back()}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              activeOpacity={0.5}
            >
              <Text style={[styles.headerDone, { color: colors.text }]}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, {
          paddingBottom: insets.bottom + 32,
          paddingLeft: insets.left + uis(20),
          paddingRight: insets.right + uis(20),
        }]}
      >
        <SectionLabel label="Theme" />
        <SegRow
          wrap
          options={THEME_OPTIONS}
          current={settings.themeMode}
          onSelect={v => update({ themeMode: v, bandColor: THEME_BAND_DEFAULT[v] ?? settings.bandColor })}
        />

        <SectionLabel label="Display Font" />
        <SegRow
          options={FONT_OPTIONS}
          current={settings.displayFont}
          onSelect={v => update({ displayFont: v })}
        />

        <SectionLabel label="Speaking Pace" />
        {(() => {
          const wpm = settings.wordsPerMinute ?? 130;
          const dec = () => update({ wordsPerMinute: Math.max(WPM_MIN, wpm - WPM_STEP) });
          const inc = () => update({ wordsPerMinute: Math.min(WPM_MAX, wpm + WPM_STEP) });
          const atMin = wpm <= WPM_MIN;
          const atMax = wpm >= WPM_MAX;
          return (
            <View style={styles.stepperRow}>
              <TouchableOpacity
                onPress={dec}
                disabled={atMin}
                style={[
                  styles.stepperBtn,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  atMin && { opacity: 0.4 },
                ]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
              </TouchableOpacity>
              <View style={styles.stepperValueWrap}>
                <Text style={[styles.stepperValue, { color: colors.text }]}>{wpm}</Text>
                <Text style={[styles.stepperUnit, { color: colors.textMuted }]}>words per minute</Text>
              </View>
              <TouchableOpacity
                onPress={inc}
                disabled={atMax}
                style={[
                  styles.stepperBtn,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  atMax && { opacity: 0.4 },
                ]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
              </TouchableOpacity>
            </View>
          );
        })()}
        <Text style={[styles.fadeDesc, { color: colors.textMuted, marginTop: uis(10) }]}>
          Used to estimate how long each note will take to present. Most presenters land between 130 and 160.
        </Text>
        <TouchableOpacity
          style={[styles.measureBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => setTrainerOpen(true)}
        >
          <Text style={[styles.measureBtnText, { color: colors.text }]}>Measure My Pace</Text>
          <Text style={[styles.measureBtnSub, { color: colors.textMuted }]}>
            Not sure? Read three short passages aloud and we'll calculate it for you.
          </Text>
        </TouchableOpacity>

        <SectionLabel label="Band Height" />
        <SegRow
          options={LINE_OPTIONS}
          current={settings.bandLines}
          onSelect={v => update({ bandLines: v })}
        />

        <SectionLabel label="Band Position" />
        <SegRow
          options={POS_OPTIONS}
          current={settings.bandPositionPct}
          onSelect={v => update({ bandPositionPct: v })}
        />

        <SectionLabel label="Band Color" />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.colorScroll}
        >
          {BAND_COLORS.map(c => {
            const on = settings.bandColor === c.value;
            const isClear = c.value === 'clear';
            return (
              <TouchableOpacity
                key={c.value}
                onPress={() => update({ bandColor: c.value })}
                style={[
                  styles.colorSwatch,
                  // Drawn exactly as the band will be — a pale fill inside a
                  // stronger outline — rather than as a solid block of the
                  // raw colour. A solid swatch promised a confident colour
                  // and produced a faint band, so picking the band you
                  // wanted meant picking a swatch you didn't.
                  {
                    backgroundColor: bandFillColor(c.value),
                    borderColor: bandBorderColor(c.value),
                    borderWidth: on ? 3 : 2,
                  },
                  isClear && styles.colorSwatchClear,
                ]}
              >
                {/* The tick is the colour itself: white would vanish on a
                    15% fill, and a fixed dark grey would read as a different
                    swatch from the one you chose. */}
                {on && (
                  <Text style={[
                    styles.colorCheck,
                    { color: isClear ? '#475569' : c.value },
                  ]}>✓</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <Text style={[styles.colorLabel, { color: colors.textMuted }]}>{selectedColorLabel}</Text>

        <SectionLabel label="Band Fades" />
        <Text style={[styles.fadeDesc, { color: colors.textMuted }]}>
          Dims the text just above and below the band to draw focus to it.
        </Text>
        <SegRow
          options={[{ label: 'Off', value: false }, { label: 'On', value: true }]}
          current={settings.bandFades ?? false}
          onSelect={v => update({ bandFades: v })}
        />

        <Text style={[styles.hint, { color: colors.textFaint }]}>
          Font size and spellcheck can be adjusted per note using the controls in the editor and presenter.
        </Text>

        {/* Rendered audio is derived data — the notes are the source of
            truth — so clearing it is always safe. It's worth surfacing
            because the app is already large, and unexplained storage with no
            control is what turns a big download into a complaint. */}
        <SectionLabel label="Storage" />
        <View style={[styles.storageRow, { borderColor: colors.border }]}>
          <Text style={[styles.storageLabel, { color: colors.text }]}>Audio Cache</Text>
          <Text style={[styles.storageValue, { color: colors.textMuted }]}>
            {cacheBytes == null ? '…' : formatBytes(cacheBytes)}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.storageRow, { borderColor: colors.border, opacity: clearing || !cacheBytes ? 0.4 : 1 }]}
          disabled={clearing || !cacheBytes}
          onPress={() => {
            Alert.alert(
              'Clear audio cache?',
              'Spoken audio will be created again the next time you listen to a note, and each note will start from the beginning. Your notes are not affected.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear', style: 'destructive',
                  onPress: async () => {
                    setClearing(true);
                    await clearAudioCache();
                    setCacheBytes(await audioCacheBytes());
                    setClearing(false);
                  },
                },
              ]
            );
          }}
        >
          <Text style={[styles.storageLabel, { color: '#b91c1c' }]}>
            {clearing ? 'Clearing…' : 'Clear Cache'}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.hint, { color: colors.textFaint }]}>
          Audio is generated on your device as you listen and stored so replaying a note is instant.
        </Text>

        {/* Attribution for the bundled speech model.
            The OpenRAIL-M licence the weights ship under requires that
            recipients are told what they're getting and are passed the
            licence terms, so this is a requirement rather than a courtesy.
            The "on your device" line is also worth saying plainly: people
            reasonably assume a natural-sounding voice means their sermon
            was uploaded somewhere. */}
        <SectionLabel label="Voice" />
        <Text style={[styles.fadeDesc, { color: colors.textMuted }]}>
          Listen mode reads your notes aloud with {'\u201C'}James{'\u201D'}, a neural voice
          generated entirely on your device. Nothing you write is sent anywhere.
        </Text>
        <Text style={[styles.hint, { color: colors.textFaint }]}>
          Speech synthesis by Supertonic (Supertone Inc.), used under the
          BigScience OpenRAIL-M licence. Runs on ONNX Runtime.
        </Text>
        <TouchableOpacity
          onPress={() => Linking.openURL('https://huggingface.co/Supertone/supertonic-3').catch(() => {})}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[styles.hint, { color: colors.accent, textDecorationLine: 'underline' }]}>
            View the model and its licence
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Hidden sync diagnostics panel. Absolute overlay (not a nested Modal —
          the app avoids modal-in-modal; matches the editor's menu pattern).
          Tap the backdrop or Close to dismiss. */}
      {diagOpen && (
        <View style={styles.diagBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDiagOpen(false)} />
          <View style={[styles.diagCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.diagHeaderRow}>
              <Text style={[styles.diagTitle, { color: colors.text }]}>Sync Diagnostics</Text>
              <TouchableOpacity onPress={() => setDiagOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={[styles.diagClose, { color: colors.textMuted }]}>Close</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.diagRow}>
              <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Status</Text>
              <View style={styles.diagStatusWrap}>
                <View style={[styles.diagDot, { backgroundColor: statusColor(diag?.status, colors) }]} />
                <Text style={[styles.diagValue, { color: colors.text }]}>{diag?.status ?? '—'}</Text>
              </View>
            </View>

            <View style={styles.diagRow}>
              <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Last sync</Text>
              <Text style={[styles.diagValue, { color: colors.text }]}>{relTime(diag?.lastSyncAt)}</Text>
            </View>

            <View style={styles.diagRow}>
              <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Pending pushes</Text>
              <Text style={[styles.diagValue, { color: colors.text }]}>{diag?.pendingCount ?? 0}</Text>
            </View>

            <View style={styles.diagRow}>
              <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Tombstones</Text>
              <Text style={[styles.diagValue, { color: colors.text }]}>{diag?.tombstones ?? 0}</Text>
            </View>

            <View style={styles.diagRow}>
              <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Engine started</Text>
              <Text style={[styles.diagValue, { color: colors.text }]}>{diag?.started ? 'yes' : 'no'}</Text>
            </View>

            {diag?.lastError ? (
              <View style={styles.diagErrorWrap}>
                <Text style={[styles.diagLabel, { color: colors.textMuted }]}>Last error</Text>
                <Text style={[styles.diagError, { color: '#b91c1c' }]} numberOfLines={4}>
                  {diag.lastError}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      )}

      <PaceTrainer
        visible={trainerOpen}
        colors={colors}
        uis={uis}
        uit={uit}
        onApply={(wpm) => { if (wpm > 0) update({ wordsPerMinute: wpm }); }}
        onClose={() => setTrainerOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex:      { flex: 1 },

  // Custom header (mirrors the notes list)
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerInner: {
    height: uis(32),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: uis(16),
  },
  headerSide:      { flex: 1 },
  headerSideRight: { alignItems: 'flex-end' },
  headerTitle:     { flex: 2, textAlign: 'center', fontSize: uit(18), fontWeight: '700', letterSpacing: -0.2 },
  headerDone:      { fontSize: uit(17), fontWeight: '600' },

  content:   { paddingHorizontal: uis(20), paddingTop: uis(8) },

  sectionLabel: {
    fontSize: uit(12), fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginTop: uis(28), marginBottom: uis(10),
  },

  seg:      { flexDirection: 'row', gap: uis(8) },
  segWrap:  { flexWrap: 'wrap' },
  segBtn: {
    paddingVertical: uis(11), paddingHorizontal: uis(10),
    borderRadius: uis(10), alignItems: 'center', borderWidth: 1,
  },
  segBtnFlex: { flex: 1 },
  segBtnWrap: { paddingHorizontal: uis(18) },
  segBtnText: { fontWeight: '600', fontSize: uit(14) },

  // Stepper — matches segBtn's visual vocabulary (surface bg, hairline border,
  // matching radius) so it sits inside the same design system as the chips.
  // Row is center-justified rather than stretching the value column with
  // flex:1: on iPad that stretch pushes the minus/plus to screen edges. A
  // minWidth on the value column keeps positioning stable as the number
  // grows/shrinks (80 → 220).
  stepperRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: uis(12) },
  stepperBtn: {
    width: uis(44), height: uis(44),
    borderRadius: uis(10), borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stepperBtnText:    { fontSize: uit(22), fontWeight: '600', lineHeight: uit(24) },
  stepperValueWrap:  { minWidth: uit(160), alignItems: 'center' },
  stepperValue:      { fontSize: uit(26), fontWeight: '700', lineHeight: uit(30) },
  stepperUnit:       { fontSize: uit(12), marginTop: uis(2) },
  measureBtn:        { marginTop: uis(14), borderWidth: 1, borderRadius: uis(12), paddingVertical: uis(14), paddingHorizontal: uis(16), alignItems: 'center' },
  measureBtnText:    { fontSize: uit(16), fontWeight: '700', textAlign: 'center' },
  measureBtnSub:     { fontSize: uit(13), marginTop: uis(4), lineHeight: uit(18), textAlign: 'center' },

  storageRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: uis(12),
  },
  storageLabel: { fontSize: uit(16) },
  storageValue: { fontSize: uit(16) },
  colorScroll:   { paddingVertical: uis(4), gap: uis(10), paddingRight: uis(8) },
  colorSwatch:   { width: uis(40), height: uis(40), borderRadius: uis(20), alignItems: 'center', justifyContent: 'center' },
  // Selection now reads as a thicker ring in the colour itself; a white ring
  // disappeared against a pale fill.
  colorSwatchClear: { borderStyle: 'dashed' },
  colorCheck:       { fontWeight: '800', fontSize: uit(16) },
  colorLabel:    { fontSize: uit(13), marginTop: uis(8) },

  fadeDesc: { fontSize: uit(13), lineHeight: uit(18), marginBottom: uis(10) },
  hint:     { marginTop: uis(32), fontSize: uit(13), lineHeight: uit(20), textAlign: 'center' },

  // Sync diagnostics overlay
  diagBackdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: uis(24),
  },
  diagCard: {
    width: '100%', maxWidth: uis(420),
    borderRadius: uis(16), borderWidth: 1,
    padding: uis(18),
    // subtle lift off the backdrop
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  diagHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: uis(14),
  },
  diagTitle: { fontSize: uit(17), fontWeight: '700', letterSpacing: -0.2 },
  diagClose: { fontSize: uit(15), fontWeight: '600' },
  diagRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: uis(7),
  },
  diagLabel: { fontSize: uit(13) },
  diagValue: { fontSize: uit(14), fontWeight: '600' },
  diagStatusWrap: { flexDirection: 'row', alignItems: 'center', gap: uis(7) },
  diagDot: { width: uis(9), height: uis(9), borderRadius: uis(5) },
  diagErrorWrap: { marginTop: uis(10) },
  diagError: { fontSize: uit(12), lineHeight: uit(17), marginTop: uis(4) },
});