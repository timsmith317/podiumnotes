// app/settings/index.js
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useSettings, themeColors } from '../../lib/useSettings';
import { uis } from '../../lib/scale';

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

      {/* Custom header — matches the list; title scales with the rest of the screen */}
      <View style={[styles.header, {
        paddingTop: uis(8),
        backgroundColor: colors.headerBg,
        borderBottomColor: colors.border,
      }]}>
        <View style={styles.headerInner}>
          <View style={styles.headerSide} />
          <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
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
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
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
                  { backgroundColor: isClear ? 'transparent' : c.value },
                  isClear && styles.colorSwatchClear,
                  on && styles.colorSwatchOn,
                ]}
              >
                {on && <Text style={isClear ? styles.colorCheckDark : styles.colorCheck}>✓</Text>}
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex:      { flex: 1 },

  // Custom header (mirrors the notes list)
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerInner: {
    height: uis(40),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: uis(16),
  },
  headerSide:      { flex: 1 },
  headerSideRight: { alignItems: 'flex-end' },
  headerTitle:     { flex: 2, textAlign: 'center', fontSize: uis(20), fontWeight: '800' },
  headerDone:      { fontSize: uis(17), fontWeight: '600' },

  content:   { paddingHorizontal: uis(20), paddingTop: uis(8) },

  sectionLabel: {
    fontSize: uis(12), fontWeight: '700',
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
  segBtnText: { fontWeight: '600', fontSize: uis(14) },

  // Stepper — matches segBtn's visual vocabulary (surface bg, hairline border,
  // matching radius) so it sits inside the same design system as the chips.
  stepperRow:        { flexDirection: 'row', alignItems: 'center', gap: uis(12) },
  stepperBtn: {
    width: uis(44), height: uis(44),
    borderRadius: uis(10), borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stepperBtnText:    { fontSize: uis(22), fontWeight: '600', lineHeight: uis(24) },
  stepperValueWrap:  { flex: 1, alignItems: 'center' },
  stepperValue:      { fontSize: uis(26), fontWeight: '700', lineHeight: uis(30) },
  stepperUnit:       { fontSize: uis(12), marginTop: uis(2) },

  colorScroll:   { paddingVertical: uis(4), gap: uis(10), paddingRight: uis(8) },
  colorSwatch:   { width: uis(40), height: uis(40), borderRadius: uis(20), alignItems: 'center', justifyContent: 'center' },
  colorSwatchOn:    { borderWidth: 3, borderColor: '#fff' },
  colorSwatchClear: { borderWidth: 1.5, borderColor: '#94a3b8', borderStyle: 'dashed' },
  colorCheck:       { color: '#fff', fontWeight: '800', fontSize: uis(16) },
  colorCheckDark:   { color: '#475569', fontWeight: '800', fontSize: uis(16) },
  colorLabel:    { fontSize: uis(13), marginTop: uis(8) },

  fadeDesc: { fontSize: uis(13), lineHeight: uis(18), marginBottom: uis(10) },
  hint:     { marginTop: uis(32), fontSize: uis(13), lineHeight: uis(20), textAlign: 'center' },
});