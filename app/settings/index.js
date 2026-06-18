import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBandSettings } from '../../lib/useBandSettings';

const LINE_OPTIONS = [2, 3, 4];
const POS_OPTIONS = [
  { label: 'Top third', value: 30 },
  { label: 'Centre', value: 45 },
  { label: 'Lower centre', value: 55 },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { settings, update } = useBandSettings();

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 20 }]}>

      <Text style={styles.sectionLabel}>Band height</Text>
      <View style={styles.seg}>
        {LINE_OPTIONS.map(n => (
          <TouchableOpacity
            key={n}
            style={[styles.segBtn, settings.lines === n && styles.segBtnOn]}
            onPress={() => update({ lines: n })}
          >
            <Text style={[styles.segBtnText, settings.lines === n && styles.segBtnTextOn]}>
              {n} lines
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionLabel}>Band position</Text>
      <View style={styles.seg}>
        {POS_OPTIONS.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segBtn, settings.positionPct === opt.value && styles.segBtnOn]}
            onPress={() => update({ positionPct: opt.value })}
          >
            <Text style={[styles.segBtnText, settings.positionPct === opt.value && styles.segBtnTextOn]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.hint}>
        These settings apply in Presenter mode. You can also adjust font size
        live with the A− / A+ buttons during your presentation.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', padding: 20 },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#475569',
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginTop: 24, marginBottom: 10,
  },
  seg: { flexDirection: 'row', gap: 8 },
  segBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 10,
    backgroundColor: '#1e293b',
    alignItems: 'center',
    borderWidth: 1, borderColor: '#1e293b',
  },
  segBtnOn: { backgroundColor: '#15803d', borderColor: '#15803d' },
  segBtnText: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
  segBtnTextOn: { color: '#fff' },
  hint: {
    marginTop: 32, fontSize: 13, color: '#475569',
    lineHeight: 20, textAlign: 'center',
  },
});
