// app/pdf-present.js
//
// Proof-of-concept present-only viewer for a PDF. The PDF renders in a WebView
// (iOS WKWebView shows PDFs natively, with scroll + pinch-zoom), and the
// stationary focus band is drawn on top as an absolute overlay with
// pointerEvents="none" so all touches pass through to the PDF underneath.
//
// No edit mode. Band geometry/colour/fades mirror the text presenter so the
// experience matches. Reached via router.push('/pdf-present', { uri, name }).

import {
  View, Text, TouchableOpacity, StyleSheet,
  useWindowDimensions, useColorScheme,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useKeepAwake } from 'expo-keep-awake';
import { useSettings, themeColors } from '../lib/useSettings';

// --- tweakable constants ---
const BAND_LINE_PX = 34;  // approx vertical space per "line" of band over a PDF
const TOP_BAR_H    = 44;
const FADE_H       = 48;

export default function PdfPresent() {
  useKeepAwake();
  const params = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);
  const { height } = useWindowDimensions();

  const fileUri = Array.isArray(params.uri) ? params.uri[0] : params.uri;
  const name    = Array.isArray(params.name) ? params.name[0] : (params.name || 'Presenting');
  const readDir = fileUri ? fileUri.slice(0, fileUri.lastIndexOf('/')) : undefined;

  // Band geometry — same math as the text presenter, clamped to the content area.
  const contentTop  = insets.top + TOP_BAR_H;
  const bandHeight  = settings.bandLines * BAND_LINE_PX;
  const rawBandTop  = height * (settings.bandPositionPct / 100) - bandHeight / 2;
  const bandTop = Math.max(
    contentTop + 8,
    Math.min(rawBandTop, height - bandHeight - insets.bottom - 8)
  );

  function bandFillColor(hex) {
    if (!hex || hex === 'clear') return 'transparent';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},0.15)`;
  }
  function bandBorderColor(hex) {
    if (!hex || hex === 'clear') return '#94a3b8';
    return hex + 'BF';
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {/* PDF underneath, inset below the top bar */}
      <View style={{ flex: 1, marginTop: contentTop }}>
        {fileUri ? (
          <WebView
            style={styles.web}
            originWhitelist={['*']}
            source={{ uri: fileUri }}
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            allowingReadAccessToURL={readDir}
            showsVerticalScrollIndicator={false}
            automaticallyAdjustContentInsets={false}
            contentInset={{
              top: Math.max(0, bandTop - contentTop),
              bottom: Math.max(0, height - bandTop - bandHeight),
            }}
          />
        ) : (
          <View style={styles.missing}>
            <Text style={{ color: colors.textMuted }}>No PDF to present.</Text>
          </View>
        )}
      </View>

      {/* Fade masks above/below the band */}
      {settings.bandFades && (
        <>
          <View pointerEvents="none" style={[styles.fade, { top: bandTop - FADE_H, height: FADE_H, backgroundColor: colors.bg + 'CC' }]} />
          <View pointerEvents="none" style={[styles.fade, { top: bandTop + bandHeight, height: FADE_H, backgroundColor: colors.bg + 'CC' }]} />
        </>
      )}

      {/* Focus band overlay — never intercepts touches */}
      <View pointerEvents="none" style={[styles.band, {
        top: bandTop, height: bandHeight,
        backgroundColor: bandFillColor(settings.bandColor),
        borderColor: bandBorderColor(settings.bandColor),
      }]} />

      {/* Top bar overlay (sits above everything; this one IS tappable) */}
      <View style={[styles.topBar, {
        paddingTop: insets.top,
        height: insets.top + TOP_BAR_H,
        backgroundColor: colors.headerBg,
        borderBottomColor: colors.border,
      }]}>
        <TouchableOpacity
          onPress={() => { router.canGoBack() ? router.back() : router.replace('/'); }}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          activeOpacity={0.6}
          style={styles.backBtn}
        >
          <Text style={[styles.backChevron, { color: colors.text }]}>‹</Text>
          <Text style={[styles.backText, { color: colors.text }]}>Notes</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.backBtn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  web:  { flex: 1, backgroundColor: 'transparent' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    position: 'absolute', left: 0, right: 0, top: 0, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', minWidth: 80 },
  backChevron: { fontSize: 26, marginRight: 1, marginTop: -2 },
  backText:    { fontSize: 16 },
  title:       { fontSize: 15, fontWeight: '700', flex: 1, textAlign: 'center' },
  band: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    borderTopWidth: 1.5, borderBottomWidth: 1.5,
  },
  fade: { position: 'absolute', left: 0, right: 0, zIndex: 9 },
});