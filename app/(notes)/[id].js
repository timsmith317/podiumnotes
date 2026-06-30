// app/(notes)/[id].js
import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, Pressable,
  StyleSheet, useWindowDimensions, useColorScheme, Keyboard, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { SymbolView } from 'expo-symbols';
import { useNotes } from '../../lib/useNotes';
import { getScroll, getScrollSync, setScroll, clearScroll } from '../../lib/scrollMemory';
import { check as spellCheck } from '../../modules/spell-check';
import * as SpeechFollow from '../../modules/speech-follow';
import { useSettings, themeColors, fontFamily } from '../../lib/useSettings';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { ui, IS_TABLET } from '../../lib/scale';

// Presenter font ladders — iPad gets a much taller ceiling for podium-distance reading
const FONT_SIZES_PHONE  = [18, 22, 26, 30, 36, 42];
const FONT_SIZES_TABLET = [22, 28, 34, 42, 52, 64, 76];
// Cap the presenter/editor text column so lines stay readable on wide screens
const MAX_TEXT_WIDTH = 760;

// Editorial serif for titles (system serif; no bundled font needed)
const SERIF_FONT = Platform.OS === 'ios' ? 'Georgia' : 'serif';
// Show the voice-follow control in the presenter HUD
const SHOW_VOICE_PLACEHOLDER = true;

// ── Voice-follow tuning ──
// All five are safe to tweak. If it tracks too loosely / jumps, tighten
// (smaller AHEAD / JUMP, larger MIN_RUN). If it under-tracks, loosen
// (smaller MIN_RUN, larger AHEAD). LEAD_LINES fixes "words land below the band".
const VOICE_RECENT_WORDS   = 4;   // trailing spoken words used to find your place
const VOICE_SEARCH_AHEAD   = 24;  // how far ahead in the script we look (words)
const VOICE_MIN_RUN        = 3;   // contiguous matched words required to move
const VOICE_MAX_JUMP_WORDS = 14;  // refuse to advance further than this in one step
const VOICE_LEAD_LINES     = 2;   // keep your live spot this many lines above the matched word

// Layout constants (heights below the safe-area inset)
const TOP_BAR_H   = ui(38);   // Back / Present bar
const TITLE_BAR_H = ui(36);   // fixed centered title strip

export default function EditorScreen() {
  const { id } = useLocalSearchParams();
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { getNote, updateNote, deleteNote, createNote } = useNotes();
  const { settings } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);
  const ff = fontFamily(settings.displayFont);

  // iPad adaptation: bigger font ladder + a centered, width-capped text column.
  const FONT_SIZES = IS_TABLET ? FONT_SIZES_TABLET : FONT_SIZES_PHONE;
  const bodyFont = IS_TABLET ? 30 : 26;
  const bodyLH = bodyFont * 1.55;
  const presPadX = IS_TABLET ? Math.max(22, (width - MAX_TEXT_WIDTH) / 2) : 22;
  const editPadX = IS_TABLET ? Math.max(18, (width - MAX_TEXT_WIDTH) / 2) : 18;

  const note = getNote(id);
  const [body, setBody] = useState(note?.body ?? '');
  const [title, setTitle] = useState(note?.title ?? '');
  const [presenting, setPresenting] = useState(!!note?.body);
  const [reviewing, setReviewing] = useState(false);
  const [misspellings, setMisspellings] = useState([]);
  const [fontIndex, setFontIndex] = useState(2);
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [progress, setProgress] = useState(0);
  const [voiceOn, setVoiceOn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Captured ONCE at mount and never updated. The presenter ScrollView's
  // contentOffset prop must be reference-stable: getScrollSync(id) reads a
  // cache that lags real scroll position by ~400ms (the onScroll debounce),
  // so if we passed `{y: getScrollSync(id)}` inline it would change between
  // renders and RN would re-apply it — snapping a fresh jumpToTop/jumpToBottom
  // back to the stale cached position on the next progress-tick re-render.
  const [initialContentOffset] = useState(() => ({ x: 0, y: getScrollSync(id) }));
  const bodyInputRef = useRef(null);
  const scrollRef = useRef(null);
  const scrollYRef = useRef(0);
  const linesRef = useRef([]);
  const startedEmptyRef = useRef(!note?.body && !note?.title);
  const latestRef = useRef({ title, body });
  const presScrollRef = useRef(null);
  const presScrollYRef = useRef(0);
  const restoredScrollRef = useRef(false);
  const saveScrollTimer = useRef(null);
  const presViewportH = useRef(0);
  const presContentH = useRef(0);
  const progressPctRef = useRef(0);
  const presLinesRef = useRef([]);
  const lineStartsRef = useRef([]);
  const scriptWordsRef = useRef([]);
  const cursorWordRef = useRef(0);
  const lastScrollLineRef = useRef(-1);
  const voiceSubsRef = useRef([]);

  useKeepAwake();

  useEffect(() => {
    console.log('PODIUM_NOTES_EDITOR build-30 mounted');
    navigation.setOptions({ headerShown: false });
  }, []);

  useEffect(() => {
    getScroll(id).then(y => {
      if (y > 0 && !restoredScrollRef.current) {
        restoredScrollRef.current = true;
        requestAnimationFrame(() => presScrollRef.current?.scrollTo({ y, animated: false }));
      }
    });
  }, []);

  useEffect(() => {
    return () => { try { SpeechFollow.stop(); } catch (e) {} };
  }, []);

  useEffect(() => {
    if (!presenting && voiceOn) stopVoice();
  }, [presenting]);

  useFocusEffect(
    useCallback(() => {
      if (!note) {
        router.replace('/');
      }
    }, [note])
  );

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => updateNote(id, { title, body }), 400);
    return () => clearTimeout(t);
  }, [title, body]);

  useEffect(() => {
    latestRef.current = { title, body };
  }, [title, body]);

  // Discard a brand-new note if the user leaves without entering anything
  useEffect(() => {
    return () => {
      const { title: t, body: b } = latestRef.current;
      if (startedEmptyRef.current && !t.trim() && !b.trim()) {
        deleteNote(id);
        clearScroll(id);
      } else {
        setScroll(id, presScrollYRef.current);
      }
    };
  }, []);

  function handleDismissKeyboard() {
    bodyInputRef.current?.blur();
    Keyboard.dismiss();
    setEditing(false);
  }

  // On entering edit mode, hold the scroll where the user was reading —
  // focusing a tall input otherwise jumps the view to the end. The caret
  // itself is placed via the controlled `selection` prop below.
  useEffect(() => {
    if (!editing) return;
    const y = scrollYRef.current;
    const restore = () => scrollRef.current?.scrollTo({ y, animated: false });
    const t1 = setTimeout(restore, 50);
    const t2 = setTimeout(restore, 180);
    const t3 = setTimeout(restore, 380);
    const tc = setTimeout(() => setSel(null), 350);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(tc); };
  }, [editing]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', e => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, []);

  function handleImport(text) {
    setBody(prev => (prev ? prev + '\n\n' + text : text));
  }

  // Map a tap on the read-mode text to a character offset, using the line
  // layout from onTextLayout (horizontal position is proportional/approx).
  function offsetFromTap(locationX, locationY) {
    const lines = linesRef.current;
    if (!lines || !lines.length) return body.length;
    let li = lines.findIndex(l => locationY >= l.y && locationY <= l.y + l.height);
    if (li === -1) li = locationY < lines[0].y ? 0 : lines.length - 1;
    const line = lines[li];
    const lt = line.text || '';
    const frac = line.width > 0
      ? Math.min(Math.max((locationX - line.x) / line.width, 0), 1)
      : 0;
    const charInLine = Math.round(frac * lt.length);
    let pos = 0;
    for (let i = 0; i < li; i++) {
      const t = lines[i].text || '';
      const found = body.indexOf(t, pos);
      pos = found === -1 ? pos + t.length : found + t.length;
      if (body[pos] === '\n') pos += 1;
    }
    const foundLine = body.indexOf(lt, pos);
    const lineStart = foundLine === -1 ? pos : foundLine;
    return Math.min(lineStart + charInLine, body.length);
  }

  function handleBodyTap(e) {
    const { locationX, locationY } = e.nativeEvent;
    const off = offsetFromTap(locationX, locationY);
    setSel({ start: off, end: off });
    setEditing(true);
  }

  async function handlePickImport() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'text/plain',
          'text/markdown',
          'application/rtf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/pdf',
          'com.adobe.pdf',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      // PDFs open in the present-only viewer (rendered, with the band overlay)
      // rather than being read as text. Everything else imports as text.
      const isPdf = (asset.mimeType && asset.mimeType.includes('pdf')) ||
        /\.pdf$/i.test(asset.name || '');
      if (isPdf) {
        // Persist into app storage so the PDF survives app close / reboot.
        const dir = FileSystem.documentDirectory + 'pdfs/';
        try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch (e) {}
        const dest = dir + 'pdf-' + Date.now() + '.pdf';
        await FileSystem.copyAsync({ from: asset.uri, to: dest });
        const pdfTitle = (asset.name || 'PDF').replace(/\.pdf$/i, '');
        const newId = createNote({ kind: 'pdf', title: pdfTitle, fileUri: dest });
        router.replace({ pathname: '/pdf-present', params: { uri: dest, name: pdfTitle, id: newId } });
        return;
      }
      const text = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      handleImport(text);
    } catch (e) {
      Alert.alert('Import failed', 'Could not read that file. Try plain text or markdown.');
    }
  }

  // Clearance the floating HUD needs at the bottom of the scroll + band area.
  const hudClear = insets.bottom + ui(76);
  const pillW = Math.min(width - ui(120), 340);
  const progressColor = (settings.bandColor && settings.bandColor !== 'clear')
    ? settings.bandColor : colors.accent;

  // Band geometry (presenter) — content begins below top bar + title strip
  const lineHeight = FONT_SIZES[fontIndex] * 1.55;
  const bandHeight = settings.bandLines * lineHeight;
  const presenterContentTop = insets.top + TOP_BAR_H + TITLE_BAR_H;
  const bandTop = height * (settings.bandPositionPct / 100) - bandHeight / 2;
  const clampedBandTop = Math.max(
    presenterContentTop + 8,
    Math.min(bandTop, height - bandHeight - hudClear - 8)
  );

  function bandFillColor(hex) {
    if (hex === 'clear') return 'transparent';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},0.15)`;
  }
  function bandBorderColor(hex) {
    if (hex === 'clear') return '#94a3b8';
    return hex + 'BF';
  }

  // ── Voice follow ──
  // Build a normalized word list of the script (word -> char offset).
  function buildScriptWords() {
    const re = /\S+/g; const out = []; let m;
    while ((m = re.exec(body)) !== null) {
      const norm = m[0].toLowerCase().replace(/[^a-z0-9']/g, '');
      if (norm) out.push({ w: norm, offset: m.index });
    }
    scriptWordsRef.current = out;
    cursorWordRef.current = 0;
  }

  // Map each laid-out visual line to its character range + y position.
  function computeLineStarts() {
    const lines = presLinesRef.current || [];
    const ls = []; let pos = 0;
    for (const ln of lines) {
      const t = ln.text || '';
      const found = body.indexOf(t, pos);
      const start = found === -1 ? pos : found;
      ls.push({ start, end: start + t.length, y: ln.y, h: ln.height });
      pos = start + t.length;
    }
    lineStartsRef.current = ls;
  }

  // Find the script-word index that matches wherever the reader is currently
  // scrolled, so voice-follow starts from the band — not the top of the note.
  // We anchor to the *top* of the focus band: the reader is always at or below
  // that, so the forward matcher can catch them. A line sits at the band's top
  // when its text-relative y equals the scroll offset (the presenter's padding
  // and the band's screen position cancel out, same as in scrollToOffset).
  function cursorFromScroll() {
    const ls = lineStartsRef.current;
    const words = scriptWordsRef.current;
    if (!ls.length || !words.length) return 0;
    const targetY = presScrollYRef.current;
    let line = ls.find(l => targetY >= l.y && targetY <= l.y + l.h);
    if (!line) {
      line = ls.reduce((a, b) => (Math.abs(b.y - targetY) < Math.abs(a.y - targetY) ? b : a), ls[0]);
    }
    let idx = words.findIndex(w => w.offset >= line.start);
    if (idx === -1) idx = words.length - 1;
    return Math.max(0, idx);
  }

  // Scroll so the matched line sits in the focus band.
  //
  // The centering term (line.y + h/2 - bandHeight/2) is correct on its own:
  // the content padding the presenter adds and the band's screen position
  // cancel out, so a plain center lands the matched word in the band's middle.
  // But the matched word is the one you *just* spoke — by the time iOS
  // transcribes it and we scroll, you're already a beat further on. Centering
  // that already-spoken word leaves what you're saying *now* below the band.
  // VOICE_LEAD_LINES lifts the matched word above center so your live spot
  // rides inside the band instead of trailing under it.
  function scrollToOffset(offset) {
    const ls = lineStartsRef.current;
    if (!ls.length) return;
    const line = ls.find(l => offset >= l.start && offset <= l.end) || ls[ls.length - 1];
    if (line.y === lastScrollLineRef.current) return;
    lastScrollLineRef.current = line.y;
    const lead = VOICE_LEAD_LINES * (line.h || 0);
    const target = Math.max(0, line.y + line.h / 2 - bandHeight / 2 + lead);
    presScrollRef.current?.scrollTo({ y: target, animated: true });
  }

  // Matcher. Aligns the *latest* spoken words to a nearby forward spot in the
  // script. Three changes from the first pass, each targeting the "jumps way
  // down the page" failure:
  //   • contiguous run only — scattered single-word hits no longer count, so a
  //     stray "of" / "the" can't anchor a match far ahead;
  //   • short forward window + nearest-wins tie-break — favours the spot just
  //     ahead of you over an identical phrase deeper in the script;
  //   • hard jump cap — if the only confident match is too far ahead, we HOLD
  //     rather than lurch. Losing a beat beats losing your place.
  // The inner loop counts how many trailing recent words match ending at j, so
  // leading mis-hears ("um", dropped words) don't break an otherwise good tail.
  function handleTranscript(text) {
    const tw = (text.toLowerCase().match(/[a-z0-9']+/g)) || [];
    if (tw.length === 0) return;
    const recent = tw.slice(-VOICE_RECENT_WORDS);
    const words = scriptWordsRef.current;
    const startI = cursorWordRef.current;
    const endI = Math.min(words.length, startI + VOICE_SEARCH_AHEAD);

    let bestEnd = -1, bestRun = 0, bestDist = Infinity;
    for (let j = startI; j < endI; j++) {
      let run = 0;
      for (let k = 0; k < recent.length && j - k >= 0; k++) {
        if (words[j - k].w !== recent[recent.length - 1 - k]) break;
        run++;
      }
      if (run === 0) continue;
      const dist = j - startI;
      if (run > bestRun || (run === bestRun && dist < bestDist)) {
        bestRun = run; bestDist = dist; bestEnd = j;
      }
    }

    if (bestRun < VOICE_MIN_RUN) return;                  // not confident → hold
    if (bestEnd - startI > VOICE_MAX_JUMP_WORDS) return;  // too far → hold, don't lurch
    cursorWordRef.current = bestEnd;
    scrollToOffset(words[bestEnd].offset);
  }

  async function startVoice() {
    try {
      const granted = await SpeechFollow.requestPermissions();
      if (!granted) {
        Alert.alert('Microphone & speech access needed',
          'Enable Microphone and Speech Recognition for Podium Notes in Settings to use voice follow.');
        return;
      }
      buildScriptWords();
      computeLineStarts();
      cursorWordRef.current = cursorFromScroll(); // start where the reader is, not at the top
      lastScrollLineRef.current = -1;
      voiceSubsRef.current = [
        SpeechFollow.addTranscriptListener(handleTranscript),
        SpeechFollow.addErrorListener(() => {}),
      ];
      const ok = await SpeechFollow.start('en-US');
      if (ok) setVoiceOn(true);
      else { stopVoice(); Alert.alert('Voice follow', 'Could not start listening on this device.'); }
    } catch (e) {
      Alert.alert('Voice follow', 'Could not start listening.');
    }
  }

  function stopVoice() {
    try { SpeechFollow.stop(); } catch (e) {}
    voiceSubsRef.current.forEach(s => { try { s.remove(); } catch (e) {} });
    voiceSubsRef.current = [];
    setVoiceOn(false);
  }

  function toggleVoice() {
    if (voiceOn) stopVoice(); else startVoice();
  }

  // Top / bottom jumps used by the menu arrows in both presenter and editor.
  // Both use animated:false — an animated scrollTo over a long note stutters
  // and tapping again mid-animation feels like the scroll is moving "a page
  // at a time". Instant jumps are crisp and unambiguous.
  //
  // Presenter and editor each have their own ScrollView ref, so the helpers
  // route by mode: presenting -> presScrollRef, otherwise -> scrollRef.
  // jumpToBottom in present mode lands the last line in the focus band (the
  // contentContainer has tall paddingBottom so scrollToEnd would leave the
  // line floating high above the band in whitespace); the editor has no band,
  // so scrollToEnd is correct there.
  function jumpToTop() {
    lastScrollLineRef.current = -1;
    const ref = presenting ? presScrollRef : scrollRef;
    ref.current?.scrollTo({ y: 0, animated: false });
  }
  function jumpToBottom() {
    lastScrollLineRef.current = -1;
    if (presenting) {
      const ls = lineStartsRef.current;
      if (!ls.length) {
        presScrollRef.current?.scrollToEnd({ animated: false });
        return;
      }
      const last = ls[ls.length - 1];
      const target = Math.max(0, last.y + last.h / 2 - bandHeight / 2);
      presScrollRef.current?.scrollTo({ y: target, animated: false });
    } else {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }

  // Popover menu — shared between presenter and editor. Each caller passes
  // an items array; ordering in the array is ordering on screen. Each item:
  // { label: string, icon: SF Symbol name, onPress: () => void }.
  // The wrapping Pressable (no-op onPress) on the positioner stops taps on
  // separators or card padding from bubbling up to the dismiss backdrop.
  function renderMenu(items) {
    if (!menuOpen) return null;
    return (
      <>
        <Pressable
          style={[styles.menuBackdrop, { top: insets.top + TOP_BAR_H }]}
          onPress={() => setMenuOpen(false)}
        />
        <Pressable
          onPress={() => {}}
          style={[styles.menuPositioner, { top: insets.top + TOP_BAR_H + ui(4) }]}
        >
          <View style={styles.menuShadow}>
            <View style={[styles.menuCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              {items.map((it, i) => (
                <View key={it.label}>
                  {i > 0 && <View style={[styles.menuSeparator, { backgroundColor: colors.border }]} />}
                  <Pressable
                    style={styles.menuRow}
                    onPress={() => { setMenuOpen(false); it.onPress(); }}
                  >
                    <Text style={[styles.menuLabel, { color: colors.text }]}>{it.label}</Text>
                    <SymbolView name={it.icon} size={ui(22)} tintColor={colors.textMuted} type="monochrome" />
                  </Pressable>
                </View>
              ))}
            </View>
          </View>
        </Pressable>
      </>
    );
  }

  if (!note) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Text style={{ color: colors.textMuted }}>Opening…</Text>
      </View>
    );
  }

  function handleCheck() {
    handleDismissKeyboard();
    let found = [];
    try { found = Platform.OS === 'ios' ? spellCheck(body) : []; } catch (e) { found = []; }
    if (!found.length) { Alert.alert('Spell check', 'No misspelled words found.'); return; }
    setMisspellings(found);
    setReviewing(true);
  }

  function handleFixMisspelling(m) {
    const opts = (m.suggestions || []).slice(0, 4).map(s => ({
      text: s,
      onPress: () => {
        const next = body.slice(0, m.start) + s + body.slice(m.start + m.length);
        setBody(next);
        let refound = [];
        try { refound = Platform.OS === 'ios' ? spellCheck(next) : []; } catch (e) { refound = []; }
        setMisspellings(refound);
        if (!refound.length) setReviewing(false);
      },
    }));
    Alert.alert(
      m.word,
      opts.length ? 'Choose a correction:' : 'No suggestions available.',
      [...opts, { text: 'Ignore', style: 'cancel' }]
    );
  }

  function renderReviewSegments() {
    const segs = [];
    let cursor = 0;
    misspellings.forEach((m, i) => {
      if (m.start > cursor) segs.push(<Text key={'n' + i}>{body.slice(cursor, m.start)}</Text>);
      segs.push(
        <Text key={'m' + i} style={styles.misspell} onPress={() => handleFixMisspelling(m)}>
          {body.slice(m.start, m.start + m.length)}
        </Text>
      );
      cursor = m.start + m.length;
    });
    if (cursor < body.length) segs.push(<Text key="tail">{body.slice(cursor)}</Text>);
    return segs;
  }

  // ── PRESENT MODE ──
  if (presenting) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>

        {/* Top bar — Back | ▲ Settings ▼ | Edit ›
            Side slots are flex:1 spacers; only the inner buttons receive
            touches. Just Back on the left and a hamburger on the right —
            Settings, Edit, and the top/bottom jumps live in the popover. */}
        <View style={[styles.topBar, { paddingTop: insets.top, backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
          <View style={styles.topBarSideStart}>
            <TouchableOpacity
              style={styles.topBarBackInner}
              onPress={() => router.back()}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.topBarChevron, { color: colors.text }]}>‹</Text>
              <Text style={[styles.topBarText, { color: colors.text }]}> Back</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.topBarSideEnd}>
            <TouchableOpacity
              style={styles.hamburgerBtn}
              onPress={() => setMenuOpen(prev => !prev)}
              activeOpacity={1}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <View style={styles.hamburgerIcon}>
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* Fixed centered title strip */}
        <View style={[styles.titleBar, { borderBottomColor: colors.border }]}>
          <Text style={[styles.titleText, { color: colors.text, fontFamily: ff }]} numberOfLines={1}>
            {title || 'Untitled'}
          </Text>
        </View>

        {/* Band overlay */}
        <View pointerEvents="none" style={[styles.band, {
          top: clampedBandTop, height: bandHeight,
          backgroundColor: bandFillColor(settings.bandColor),
          borderColor: bandBorderColor(settings.bandColor),
        }]} />
        {settings.bandFades && (
          <>
            <View pointerEvents="none" style={[styles.fade, { top: clampedBandTop - 48, height: 48, backgroundColor: colors.bg + 'CC' }]} />
            <View pointerEvents="none" style={[styles.fade, { top: clampedBandTop + bandHeight, height: 48, backgroundColor: colors.bg + 'CC' }]} />
          </>
        )}

        <ScrollView
          ref={presScrollRef}
          style={styles.flex}
          contentContainerStyle={{
            paddingTop: clampedBandTop - presenterContentTop,
            paddingBottom: height - clampedBandTop - bandHeight + hudClear + 8,
            paddingHorizontal: presPadX,
          }}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          contentOffset={initialContentOffset}
          onLayout={e => { presViewportH.current = e.nativeEvent.layout.height; }}
          onContentSizeChange={(w, h) => {
            presContentH.current = h;
            if (!restoredScrollRef.current) {
              restoredScrollRef.current = true;
              const y = getScrollSync(id);
              if (y > 0) presScrollRef.current?.scrollTo({ y: Math.min(y, Math.max(0, h)), animated: false });
            }
          }}
          onScroll={e => {
            const y = e.nativeEvent.contentOffset.y;
            presScrollYRef.current = y;
            const denom = Math.max(1, presContentH.current - presViewportH.current);
            const pct = Math.min(100, Math.max(0, Math.round((y / denom) * 100)));
            if (pct !== progressPctRef.current) { progressPctRef.current = pct; setProgress(pct); }
            if (saveScrollTimer.current) clearTimeout(saveScrollTimer.current);
            saveScrollTimer.current = setTimeout(() => setScroll(id, y), 400);
          }}
        >
          <Text
            onTextLayout={e => { presLinesRef.current = e.nativeEvent.lines; computeLineStarts(); }}
            style={[styles.presenterText, {
              fontSize: FONT_SIZES[fontIndex], lineHeight,
              color: colors.text, fontFamily: ff,
            }]}>
            {body}
          </Text>
        </ScrollView>

        {/* Floating control HUD — A− · progress · A+, with voice-follow alongside */}
        <View pointerEvents="box-none" style={[styles.hudWrap, { bottom: insets.bottom + ui(12) }]}>
          <View style={[styles.hudPill, { width: pillW, backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TouchableOpacity
              onPress={() => setFontIndex(i => Math.max(0, i - 1))}
              disabled={fontIndex === 0}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={{ opacity: fontIndex === 0 ? 0.3 : 1 }}
            >
              <Text style={[styles.hudAa, { color: colors.text }]}>A−</Text>
            </TouchableOpacity>
            <View style={[styles.hudTrack, { backgroundColor: colors.border }]}>
              <View style={[styles.hudFill, { width: `${progress}%`, backgroundColor: progressColor }]} />
            </View>
            <TouchableOpacity
              onPress={() => setFontIndex(i => Math.min(FONT_SIZES.length - 1, i + 1))}
              disabled={fontIndex === FONT_SIZES.length - 1}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={{ opacity: fontIndex === FONT_SIZES.length - 1 ? 0.3 : 1 }}
            >
              <Text style={[styles.hudAa, { color: colors.text }]}>A+</Text>
            </TouchableOpacity>
          </View>
          {SHOW_VOICE_PLACEHOLDER && (
            <TouchableOpacity
              style={[styles.hudMic, {
                backgroundColor: voiceOn ? colors.accent : colors.surface,
                borderColor: voiceOn ? colors.accentBorder : colors.border,
              }]}
              onPress={toggleVoice}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <SymbolView
                name={voiceOn ? 'mic.fill' : 'mic'}
                size={ui(22)}
                tintColor={voiceOn ? colors.accentText : colors.textMuted}
                type="monochrome"
              />
            </TouchableOpacity>
          )}
        </View>

        {/* Popover menu — anchored under the hamburger. */}
        {renderMenu([
          { label: 'Go to top',    icon: 'arrow.up',           onPress: jumpToTop },
          { label: 'Go to bottom', icon: 'arrow.down',         onPress: jumpToBottom },
          { label: 'Edit',         icon: 'square.and.pencil',  onPress: () => setPresenting(false) },
          { label: 'Settings',     icon: 'gearshape',          onPress: () => router.push('/settings') },
        ])}
      </View>
    );
  }

  // ── REVIEW (spell check) MODE ──
  if (reviewing) {
    return (
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        <View style={[styles.topBar, { paddingTop: insets.top, backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            style={styles.topBarBack}
            onPress={() => setReviewing(false)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.topBarChevron, { color: colors.text }]}>‹</Text>
            <Text style={[styles.topBarText, { color: colors.text }]}> Edit</Text>
          </TouchableOpacity>
          <View style={styles.topBarCenter}>
            <Text style={[styles.topBarBtnText, { color: colors.textMuted }]}>
              {misspellings.length} flagged
            </Text>
          </View>
          <View style={styles.topBarRight} />
        </View>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.bodyContent, { paddingHorizontal: editPadX, paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator={true}
        >
          <Text style={{ color: colors.text, fontFamily: ff, fontSize: bodyFont, lineHeight: bodyLH }}>
            {renderReviewSegments()}
          </Text>
        </ScrollView>
      </View>
    );
  }

  // ── EDIT MODE ──
  const bodyTextStyle = {
    color: colors.text,
    fontFamily: ff,
    fontSize: bodyFont,
    lineHeight: bodyLH,
  };
  const isEmpty = !body;

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >

      {/* Top bar — Back | Import (when empty) | Hamburger
          Check spelling moved into the menu so the bar stays clean.
          Import stays as a primary CTA only on brand-new empty notes —
          it's the single most important action on a fresh note. */}
      <View style={[styles.topBar, { paddingTop: insets.top, backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
        <View style={styles.topBarSideStart}>
          <TouchableOpacity
            style={styles.topBarBackInner}
            onPress={() => {
              handleDismissKeyboard();
              if (body.trim()) { setPresenting(true); } else { router.back(); }
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.topBarChevron, { color: colors.text }]}>‹</Text>
            <Text style={[styles.topBarText, { color: colors.text }]}> Back</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.topBarCenter}>
          {isEmpty && (
            <TouchableOpacity
              style={[styles.topBarBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={handlePickImport}
              hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            >
              <Text style={[styles.topBarBtnText, { color: colors.text }]}>Import</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.topBarSideEnd}>
          <TouchableOpacity
            style={styles.hamburgerBtn}
            onPress={() => setMenuOpen(prev => !prev)}
            activeOpacity={1}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <View style={styles.hamburgerIcon}>
              <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
              <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
              <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Fixed centered title strip — editable */}
      <View style={[styles.titleBar, { borderBottomColor: colors.border }]}>
        <TextInput
          style={[styles.titleText, { color: colors.text, fontFamily: ff }]}
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={colors.placeholder}
          textAlign="center"
          returnKeyType="done"
          multiline={false}
          spellCheck={false}
          autoCorrect={false}
        />
      </View>

      {/* Body — read mode (Text) scrolls full-screen, no keyboard. Tap to edit:
          the tap is hit-tested to place the caret at the character you touched. */}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={[styles.bodyContent, { paddingHorizontal: editPadX, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        scrollEventThrottle={16}
        onScroll={e => { scrollYRef.current = e.nativeEvent.contentOffset.y; }}
        showsVerticalScrollIndicator={true}
      >
        {editing ? (
          <TextInput
            ref={bodyInputRef}
            autoFocus
            selection={sel ?? undefined}
            style={[bodyTextStyle, styles.bodyInput]}
            value={body}
            onChangeText={(t) => { if (sel) setSel(null); setBody(t); }}
            placeholder="Tap to start typing…"
            placeholderTextColor={colors.placeholder}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
            spellCheck={true}
            autoCorrect={true}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <Pressable onPress={handleBodyTap} style={styles.bodyPress}>
            <Text
              style={bodyTextStyle}
              onTextLayout={e => { linesRef.current = e.nativeEvent.lines; }}
            >
              {body
                ? body
                : <Text style={{ color: colors.placeholder }}>Tap to start typing…</Text>}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>

    {editing && keyboardVisible && (
      <TouchableOpacity
        style={[styles.kbDismiss, {
          bottom: keyboardHeight + 8,
          backgroundColor: colors.surface,
          borderColor: colors.border,
        }]}
        onPress={handleDismissKeyboard}
        activeOpacity={0.8}
      >
        <SymbolView
          name="keyboard.chevron.compact.down"
          size={ui(26)}
          tintColor={colors.textMuted}
          type="monochrome"
        />
      </TouchableOpacity>
    )}

    {/* Popover menu — Check spelling appears only when there's something to check. */}
    {renderMenu([
      { label: 'Go to top',    icon: 'arrow.up',          onPress: jumpToTop },
      { label: 'Go to bottom', icon: 'arrow.down',        onPress: jumpToBottom },
      ...(isEmpty ? [] : [
        { label: 'Check spelling', icon: 'checkmark.circle', onPress: handleCheck },
      ]),
      { label: 'Settings',     icon: 'gearshape',         onPress: () => router.push('/settings') },
    ])}
    </View>
  );
}

const styles = StyleSheet.create({
  flex:   { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Top bar (no bottom border — the title strip carries the divider)
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: ui(16),
    paddingBottom: ui(6),
    minHeight: TOP_BAR_H,
    borderBottomWidth: 1,
  },
  topBarBack:    { flex: 1, flexDirection: 'row', alignItems: 'center' },
  // Present-mode side slots — flex:1 spacers; only the inner button is tappable
  topBarSideStart: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start' },
  topBarSideEnd:   { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  topBarBackInner: { flexDirection: 'row', alignItems: 'center' },
  topBarChevron: { fontSize: ui(20), lineHeight: ui(22), marginRight: 1 },
  topBarText:    { fontSize: ui(16), lineHeight: ui(22) },
  topBarCenter:  { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  hamburgerBtn:  { padding: ui(4), borderRadius: ui(7) },
  // Manual hamburger icon — explicit gap > line ratio so it doesn't look
  // cramped the way SF Symbols' line.3.horizontal does at small sizes.
  // justify-content: space-between distributes the three lines evenly.
  hamburgerIcon: { width: ui(22), height: ui(16), justifyContent: 'space-between' },
  hamburgerLine: { height: ui(2), width: '100%', borderRadius: ui(1) },
  topBarRight:   { flex: 1, alignItems: 'flex-end' },
  topBarBtn:     { paddingHorizontal: ui(14), paddingVertical: ui(4), borderRadius: ui(8), borderWidth: 1 },
  topBarBtnText: { fontSize: ui(14), fontWeight: '600' },

  // Fixed centered title strip — snug, one line of text
  titleBar: {
    height: TITLE_BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: ui(16),
    borderBottomWidth: 1,
  },
  titleText: {
    flex: 1,
    textAlign: 'center',
    fontSize: ui(18),
    fontWeight: '700',
    padding: 0,
  },

  // Edit content
  bodyContent:  { flexGrow: 1, paddingHorizontal: 18, paddingTop: ui(14) },
  bodyPress:    { flexGrow: 1, minHeight: 320 },
  bodyInput:    { padding: 0 },
  kbDismiss: {
    position: 'absolute',
    right: 12,
    width: ui(44), height: ui(36),
    borderRadius: ui(9),
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18, shadowRadius: 4, elevation: 5,
  },


  // Presenter
  presenterText: { fontWeight: '400' },
  band: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    borderTopWidth: 1.5, borderBottomWidth: 1.5,
  },
  fade: { position: 'absolute', left: 0, right: 0, zIndex: 9 },
  misspell: { color: '#dc2626', textDecorationLine: 'underline', textDecorationColor: '#dc2626' },

  // Floating presenter HUD
  hudWrap: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: ui(10),
  },
  hudPill: {
    flexDirection: 'row', alignItems: 'center', height: ui(48), borderRadius: ui(24),
    borderWidth: 1, paddingHorizontal: ui(16),
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 5,
  },
  hudAa:    { fontSize: ui(15), fontWeight: '700' },
  hudTrack: { flex: 1, height: ui(6), borderRadius: ui(3), marginHorizontal: ui(14), overflow: 'hidden' },
  hudFill:  { height: '100%', borderRadius: ui(3) },
  hudMic: {
    width: ui(48), height: ui(48), borderRadius: ui(24), borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12, shadowRadius: 8, elevation: 5,
  },

  // Popover menu under the hamburger — single card, anchored to the
  // right edge of the screen, drops down from the top bar.
  // zIndex > band's 10 so the green band overlay doesn't draw over it.
  // Backdrop is transparent — it still catches outside taps to dismiss
  // the menu, just without dimming the screen behind.
  menuBackdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
  },
  menuPositioner: {
    position: 'absolute',
    right: ui(12),
    width: ui(220),
    zIndex: 21,
  },
  // Drop shadow lives on a wrapper View, not on menuCard. menuCard uses
  // overflow:'hidden' to clip its rows to the rounded corners, and on iOS
  // overflow:hidden also clips the layer's shadow — so the shadow gets
  // its own ancestor that doesn't clip.
  menuShadow: {
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
    elevation: 10,
  },
  menuCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: ui(16),
    height: ui(48),
  },
  menuLabel: { fontSize: ui(15) },
  menuSeparator: { height: StyleSheet.hairlineWidth, marginLeft: ui(16) },
});
