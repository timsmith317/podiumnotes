// File: app/(notes)/[id].js → ~/Projects/podiumnotes/app/(notes)/[id].js
//
// ── UNIFIED PRESENTER + EDITOR ──
// One screen, one ScrollView, one text layout, two modes.
//
// The old design kept two separate screens (presenter and editor) with
// different fonts, paddings, and scroll state, and translated reading
// position between them on every Edit. Every transition bug this screen
// ever had — stale scroll, offset remapping drift, caret races, keyboard
// reflow jumps — lived in that translation layer. This rewrite deletes the
// layer instead of patching it:
//
//   • ONE layout: the presenter's font ladder (A−/A+) and padding apply to
//     BOTH modes. The content container's padding is identical in present
//     and edit, so the same scroll offset shows the same words in both.
//     Toggling modes moves nothing — the band/HUD overlays disappear and a
//     caret appears in the text that never moved.
//   • ONE line map: the present-mode Text's onTextLayout feeds voice-follow
//     AND the Edit caret placement. No cross-layout remapping exists.
//   • Edit entry: menu → Edit places the caret at the START of the line
//     sitting in the focus band — exactly where the reader was practicing.
//   • Mode exits only via Back (or the keyboard-dismiss pill collapsing the
//     keyboard WITHOUT leaving edit). Blur no longer flips modes, so
//     tapping the hamburger mid-edit can't yank the screen out from under
//     the user.
//   • No KeyboardAvoidingView: its late padding reflow was the "jumped to
//     the end" culprit. The ScrollView's native automaticallyAdjustKeyboardInsets
//     handles the keyboard instead.
//
// PDF notes never reach this screen (routed to /pdf-present). The spell-check
// review screen is unchanged and keeps its own compact reading size.

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, Pressable,
  StyleSheet, useWindowDimensions, useColorScheme, Keyboard, Alert,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { SymbolView } from 'expo-symbols';
import { useNotes } from '../../lib/useNotes';
import { getScrollSync, setScroll, clearScroll } from '../../lib/scrollMemory';
import { check as spellCheck } from '../../modules/spell-check';
import * as SpeechFollow from '../../modules/speech-follow';
import * as SpeechPlayer from '../../modules/speech-player';
import { useSettings, themeColors, fontFamily } from '../../lib/useSettings';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { readDocumentAsText } from '../../lib/importers';
import * as Print from 'expo-print';
import { ui, IS_TABLET } from '../../lib/scale';

// Font ladder — shared by present AND edit modes (one layout is the whole
// point). iPad gets a taller ceiling for podium-distance reading.
const FONT_SIZES_PHONE  = [18, 22, 26, 30, 36, 42];
const FONT_SIZES_TABLET = [22, 28, 34, 42, 52, 64, 76];

// Editorial serif for titles (system serif; no bundled font needed)
const SERIF_FONT = Platform.OS === 'ios' ? 'Georgia' : 'serif';
// Show the voice-follow control in the HUD
const SHOW_VOICE_PLACEHOLDER = true;

// ── Voice-follow tuning ──
// All five are safe to tweak. If it tracks too loosely / jumps, tighten
// (smaller AHEAD / JUMP, larger MIN_RUN). If it under-tracks, loosen
// (smaller MIN_RUN, larger AHEAD). LEAD_LINES fixes "words land below the band".
const VOICE_RECENT_WORDS   = 4;   // trailing spoken words used to find your place
const VOICE_SEARCH_AHEAD   = 24;  // how far ahead in the script we look (words)
const VOICE_MIN_RUN        = 3;   // contiguous matched words required to move
const VOICE_MAX_JUMP_WORDS = 14;  // refuse to advance further than this in one step
// Voice-tracking lead — how many text lines to place the matched word above
// the band center, on the assumption that the user is already that many lines
// past what iOS just transcribed.
const VOICE_LEAD_LINES_PHONE  = 2;
const VOICE_LEAD_LINES_TABLET = 1;

// Layout constants (heights below the safe-area inset)
const TOP_BAR_H   = ui(38);   // Back / menu bar
const TITLE_BAR_H = ui(36);   // fixed centered title strip

export default function EditorScreen() {
  const { id, edit } = useLocalSearchParams();
  const startInEdit = edit === '1';
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { getNote, updateNote, deleteNote, createNote, flushSync } = useNotes();
  const { settings } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);
  const ff = fontFamily(settings.displayFont);

  const FONT_SIZES = IS_TABLET ? FONT_SIZES_TABLET : FONT_SIZES_PHONE;
  // Review screen keeps its own compact reading size (it's a proofing view,
  // not the podium view).
  const reviewFont = IS_TABLET ? 30 : 26;
  const reviewLH = reviewFont * 1.55;
  const padX = 22;   // one horizontal padding for both modes

  const note = getNote(id);
  const [body, setBody] = useState(note?.body ?? '');
  const [title, setTitle] = useState(note?.title ?? '');
  const [ignoredWords, setIgnoredWords] = useState(note?.ignoredWords ?? []);
  // ONE mode switch. Empty notes and ?edit=1 open in edit; notes with content
  // open presenting.
  const [editing, setEditing] = useState(startInEdit || !note?.body);
  const [reviewing, setReviewing] = useState(false);
  const [misspellings, setMisspellings] = useState([]);
  const [reviewIndex, setReviewIndex] = useState(0);   // current finding in the carousel
  const reviewScrollRef = useRef(null);
  const findingYRef = useRef({});                       // measured y-offset of each finding
  const bodyLinesRef = useRef([]);                      // review screen: per-line layout
  const bodyOffsetYRef = useRef(0);                     // review screen: body Text's y offset
  const [fontIndex, setFontIndex] = useState(2);
  // Caret control. When opening straight into edit (swipe-to-edit / empty
  // note), start the caret at the very top; entering from the presenter sets
  // it to the band line. Without an explicit selection a focused multiline
  // TextInput defaults to caret-at-end, which is never what we want.
  const [sel, setSel] = useState(editing ? { start: 0, end: 0 } : null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [progress, setProgress] = useState(0);
  const [voiceOn, setVoiceOn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyInputRef = useRef(null);

  // ── The single scroll world ──
  const scrollRef = useRef(null);        // the one ScrollView
  const scrollYRef = useRef(0);          // its current offset
  const linesRef = useRef([]);           // raw onTextLayout lines (present-mode Text)
  const lineStartsRef = useRef([]);      // per-line char ranges + y (the one line map)
  const viewportHRef = useRef(0);
  const contentHRef = useRef(0);
  const restoredScrollRef = useRef(false);
  const saveScrollTimer = useRef(null);
  const progressPctRef = useRef(0);
  // Pin insurance across the Text ↔ TextInput swap. Content geometry is
  // identical across the swap (same style, same padding), so this should be
  // a no-op — it exists to absorb any residual native offset churn. Cancelled
  // instantly by user drag.
  const editPinYRef = useRef(null);

  const startedEmptyRef = useRef(!note?.body && !note?.title);
  const latestRef = useRef({ title, body });
  const scriptWordsRef = useRef([]);
  const cursorWordRef = useRef(0);
  const lastScrollLineRef = useRef(-1);
  const voiceSubsRef = useRef([]);

  useKeepAwake();

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, []);

  useEffect(() => {
    return () => { try { SpeechFollow.stop(); } catch (e) {} };
  }, []);

  // Voice-follow is a present-mode feature; entering edit stops it.
  useEffect(() => {
    if (editing && voiceOn) stopVoice();
  }, [editing]);

  // Defensive: when the menu opens, iOS's UIScrollView can snap to y=0 as a
  // side effect of the absolute-positioned menu overlays being added to the
  // ScrollView's parent. Restore the scroll position on the next frame.
  useEffect(() => {
    if (!menuOpen) return;
    const y = scrollYRef.current;
    if (y <= 0) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y, animated: false }));
  }, [menuOpen]);

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
        setScroll(id, scrollYRef.current);
        // Commit the LATEST content to local first, THEN flush to cloud. The
        // autosave effect's cleanup cancels its pending 400ms save on unmount,
        // so the final keystrokes may not be in the store yet — write them now
        // from latestRef (always current) before flushing, or the flush would
        // push stale content and a later pull would overwrite the lost edits.
        // sync:false so this local commit doesn't schedule a debounced push
        // that would duplicate the immediate flush below.
        updateNote(id, { title: t, body: b }, { sync: false });
        flushSync(id);
      }
    };
  }, []);

  // Collapse the keyboard WITHOUT leaving edit mode. Exiting edit is Back's
  // job only — blur must never flip modes (that was the source of the
  // "hamburger tap yanked me out of edit" class of bugs).
  function collapseKeyboard() {
    bodyInputRef.current?.blur();
    Keyboard.dismiss();
  }

  // On entering edit mode, release the controlled selection after a short
  // delay so the user can move the caret freely. iOS places the caret from
  // the `selection` prop on focus; after that the native input owns it.
  useEffect(() => {
    if (!editing) return;
    const tc = setTimeout(() => setSel(null), 350);
    return () => clearTimeout(tc);
  }, [editing]);

  // Pin insurance across the mode swap (see editPinYRef).
  useEffect(() => {
    if (editPinYRef.current == null) return;
    const y = editPinYRef.current;
    const pin = () => {
      if (editPinYRef.current == null) return;
      scrollRef.current?.scrollTo({ y, animated: false });
    };
    const raf = requestAnimationFrame(pin);
    const timers = [80, 200].map(ms => setTimeout(pin, ms));
    const done = setTimeout(() => { editPinYRef.current = null; }, 260);
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); clearTimeout(done); };
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
      // Format-aware reader: docx (unzip + extract), rtf (strip markup),
      // else plain UTF-8. See lib/importers.js.
      const text = await readDocumentAsText(asset);
      handleImport(text);
    } catch (e) {
      console.warn('Import failed:', e);
      Alert.alert('Import failed', 'Could not read that file. Try plain text or markdown.');
    }
  }

  // ── Shared geometry (both modes) ──
  const hudClear = insets.bottom + ui(76);
  const pillW = Math.min(width - ui(120), 340);
  const progressColor = (settings.bandColor && settings.bandColor !== 'clear')
    ? settings.bandColor : colors.accent;

  const lineHeight = FONT_SIZES[fontIndex] * 1.55;
  const bandHeight = settings.bandLines * lineHeight;
  const contentTop = insets.top + TOP_BAR_H + TITLE_BAR_H;
  const bandTop = height * (settings.bandPositionPct / 100) - bandHeight / 2;
  const clampedBandTop = Math.max(
    contentTop + 8,
    Math.min(bandTop, height - bandHeight - hudClear - 8)
  );

  // The content container padding — IDENTICAL in both modes, keyed to the
  // band geometry. This is the invariant that makes mode toggling free: the
  // same scroll offset shows the same words whether the band is visible or
  // the caret is.
  const contentPadding = {
    paddingTop: clampedBandTop - contentTop,
    paddingBottom: height - clampedBandTop - bandHeight + hudClear + 8,
    paddingLeft: insets.left + padX,
    paddingRight: insets.right + padX,
  };

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
  // This is THE line map — voice-follow and Edit-entry both read it.
  function computeLineStarts() {
    const lines = linesRef.current || [];
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

  // The line currently sitting at the top of the focus band. A line sits at
  // the band's top when its text-relative y equals the scroll offset (the
  // content padding and the band's screen position cancel out).
  function bandLine() {
    const ls = lineStartsRef.current;
    if (!ls.length) return null;
    const targetY = scrollYRef.current;
    let line = ls.find(l => targetY >= l.y && targetY <= l.y + l.h);
    if (!line) {
      line = ls.reduce((a, b) => (Math.abs(b.y - targetY) < Math.abs(a.y - targetY) ? b : a), ls[0]);
    }
    return line;
  }

  // Find the script-word index that matches wherever the reader is currently
  // scrolled, so voice-follow starts from the band — not the top of the note.
  function cursorFromScroll() {
    const line = bandLine();
    const words = scriptWordsRef.current;
    if (!line || !words.length) return 0;
    let idx = words.findIndex(w => w.offset >= line.start);
    if (idx === -1) idx = words.length - 1;
    return Math.max(0, idx);
  }

  // Scroll so the matched line sits in the focus band.
  //
  // The centering term (line.y + h/2 - bandHeight/2) is correct on its own:
  // the content padding and the band's screen position cancel out. But the
  // matched word is the one you *just* spoke — VOICE_LEAD_LINES_* lifts the
  // matched word above center so your live spot rides inside the band
  // instead of trailing under it.
  function scrollToOffset(offset) {
    const ls = lineStartsRef.current;
    if (!ls.length) return;
    const line = ls.find(l => offset >= l.start && offset <= l.end) || ls[ls.length - 1];
    if (line.y === lastScrollLineRef.current) return;
    lastScrollLineRef.current = line.y;
    const leadLines = IS_TABLET ? VOICE_LEAD_LINES_TABLET : VOICE_LEAD_LINES_PHONE;
    const lead = leadLines * (line.h || 0);
    const target = Math.max(0, line.y + line.h / 2 - bandHeight / 2 + lead);
    scrollRef.current?.scrollTo({ y: target, animated: true });
  }

  // Matcher. Aligns the *latest* spoken words to a nearby forward spot in the
  // script:
  //   • contiguous run only — scattered single-word hits don't count;
  //   • short forward window + nearest-wins tie-break;
  //   • hard jump cap — if the only confident match is too far ahead, HOLD.
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

  // ── Mode transitions ──
  // Enter edit with the caret at the START of the line in the focus band.
  // No scroll change: the text doesn't move between modes, so the band line
  // is already exactly where the user is looking.
  function enterEdit() {
    const line = bandLine();
    const start = line ? line.start : 0;
    if (__DEV__) console.log('[unified] enterEdit: scrollY', Math.round(scrollYRef.current), '→ caret', start);
    editPinYRef.current = scrollYRef.current;
    setSel({ start, end: start });
    setEditing(true);
  }

  // Back to presenting — same position, band reappears over the caret line.
  function exitEdit() {
    collapseKeyboard();
    editPinYRef.current = scrollYRef.current;
    setEditing(false);
  }

  // Top / bottom jumps used by the menu arrows. animated:false — an animated
  // scrollTo over a long note stutters. jumpToBottom lands the last line in
  // the band region (the contentContainer's tall paddingBottom means
  // scrollToEnd would leave the last line floating high in whitespace).
  function jumpToTop() {
    lastScrollLineRef.current = -1;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }
  function jumpToBottom() {
    lastScrollLineRef.current = -1;
    const ls = lineStartsRef.current;
    if (!ls.length) {
      scrollRef.current?.scrollToEnd({ animated: false });
      return;
    }
    const last = ls[ls.length - 1];
    const target = Math.max(0, last.y + last.h / 2 - bandHeight / 2);
    scrollRef.current?.scrollTo({ y: target, animated: false });
  }

  // Home — pop everything back to the note list.
  function jumpHome() {
    navigation.popToTop();
  }

  // Popover menu — items array; ordering in the array is ordering on screen.
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
          style={[styles.menuPositioner, {
            top: insets.top + TOP_BAR_H + ui(4),
            right: insets.right + ui(12),
          }]}
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

  // ── TEMPORARY (feature/listen-mode): dev-only smoke test for the
  // SpeechPlayer native module. v2: logs the installed voice inventory and
  // auto-selects the best available (premium > enhanced > default) — the
  // stock default voice is the compact robotic one and unusable for real
  // listening. Enhanced/Premium voices are downloaded per-device in
  // Settings → Accessibility → Spoken Content → Voices.
  async function devSmokeTest() {
    try {
      const voices = await SpeechPlayer.getVoices();
      console.log('[listen-smoke] installed voices:',
        voices.map(v => `${v.name} (q${v.quality})`).join(', '));
      const best = voices.find(v => v.name.startsWith('Lee')) || voices[0]; // audition Lee; fall back to best quality
      console.log('[listen-smoke] using voice:', best?.name, 'quality', best?.quality);
      if (!best || best.quality === 1) {
        Alert.alert('Only the basic voice is installed',
          'For a natural voice, download a Premium voice in Settings → Accessibility → Spoken Content → Voices → English (e.g. Ava Premium), then try again.');
      }
      console.log('[listen-smoke] synthesizing…');
      const t0 = Date.now();
      const { uri, duration } = await SpeechPlayer.synthesizeToFile(
        body || 'This is a test of listen mode.',
        FileSystem.documentDirectory + 'audio/smoke-test.m4a',
        best ? { voiceId: best.id } : {}
      );
      console.log('[listen-smoke] synthesized', Math.round(duration), 'sec of audio in',
        ((Date.now() - t0) / 1000).toFixed(1), 'sec →', uri);
      await SpeechPlayer.load(uri, title || 'Smoke Test');
      SpeechPlayer.play();
    } catch (e) {
      console.warn('[listen-smoke] failed:', e);
      Alert.alert('Smoke test failed', String(e?.message || e));
    }
  }

  // Print via the native iOS print sheet (AirPrint, Save to PDF, etc.).
  async function handlePrint() {
    setMenuOpen(false);
    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = (latestRef.current.title || title || 'Untitled').trim();
    const b = latestRef.current.body || body || '';
    const paras = esc(b).split(/\n{2,}/).map(
      p => `<p>${p.replace(/\n/g, '<br>')}</p>`
    ).join('');
    const words = b.trim() ? b.trim().split(/\s+/).length : 0;
    const wpm = settings.wpm || 130;
    const mins = Math.max(1, Math.round(words / wpm));
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>
        @page { margin: 1in; }
        body { font-family: Georgia, 'Times New Roman', serif; color: #111;
               font-size: 13pt; line-height: 1.7; }
        h1 { font-size: 20pt; margin: 0 0 4pt; }
        .meta { color: #666; font-size: 10pt; margin: 0 0 24pt;
                border-bottom: 1px solid #ddd; padding-bottom: 12pt; }
        p { margin: 0 0 12pt; }
      </style></head><body>
      <h1>${esc(t)}</h1>
      <div class="meta">${words} words &middot; ~${mins} min at ${wpm} wpm</div>
      ${paras}
      </body></html>`;
    try {
      await Print.printAsync({ html });
    } catch (e) {
      // User cancelling the print sheet throws; ignore.
    }
  }

  // ── Spell check ──
  function isIgnored(word, ignoreList) {
    const list = ignoreList ?? ignoredWords;
    const w = (word || '').toLowerCase();
    return list.some(x => x.toLowerCase() === w);
  }

  function handleCheck() {
    collapseKeyboard();
    let found = [];
    try {
      if (Platform.OS === 'ios') {
        const titleHits = (spellCheck(title) || []).map(m => ({ ...m, field: 'title' }));
        const bodyHits = (spellCheck(body) || []).map(m => ({ ...m, field: 'body' }));
        found = [...titleHits, ...bodyHits];   // title findings first, then body
      }
    } catch (e) { found = []; }
    found = found.filter(m => !isIgnored(m.word));
    if (!found.length) { Alert.alert('Spell check', 'No misspelled words found.'); return; }
    setMisspellings(found);
    setReviewIndex(0);
    setReviewing(true);
  }

  function rescanBoth(nextTitle, nextBody, ignoreList) {
    try {
      if (Platform.OS !== 'ios') return [];
      const t = (spellCheck(nextTitle) || []).map(m => ({ ...m, field: 'title' }));
      const b = (spellCheck(nextBody) || []).map(m => ({ ...m, field: 'body' }));
      return [...t, ...b].filter(m => !isIgnored(m.word, ignoreList));
    } catch (e) { return []; }
  }

  function advanceReview(fromIndex, list) {
    const remaining = list ?? misspellings;
    if (fromIndex + 1 >= remaining.length) {
      setReviewing(false);
      Alert.alert('Spell check', 'All done.');
    } else {
      setReviewIndex(fromIndex + 1);
    }
  }

  function applySuggestion(suggestion) {
    const m = misspellings[reviewIndex];
    if (!m) return;
    let nextTitle = title, nextBody = body;
    if (m.field === 'title') {
      nextTitle = title.slice(0, m.start) + suggestion + title.slice(m.start + m.length);
      setTitle(nextTitle);
    } else {
      nextBody = body.slice(0, m.start) + suggestion + body.slice(m.start + m.length);
      setBody(nextBody);
    }
    const refound = rescanBoth(nextTitle, nextBody);
    setMisspellings(refound);
    findingYRef.current = {};
    if (!refound.length) {
      setReviewing(false);
      Alert.alert('Spell check', 'All done.');
      return;
    }
    setReviewIndex(Math.min(reviewIndex, refound.length - 1));
  }

  function skipCurrent() {
    advanceReview(reviewIndex);
  }

  function ignoreCurrent() {
    const m = misspellings[reviewIndex];
    if (!m) { advanceReview(reviewIndex); return; }
    const word = m.word;
    const nextIgnore = isIgnored(word) ? ignoredWords : [...ignoredWords, word];
    setIgnoredWords(nextIgnore);
    updateNote(id, { ignoredWords: nextIgnore }, { sync: true });
    const remaining = misspellings.filter(x => !isIgnored(x.word, nextIgnore));
    setMisspellings(remaining);
    findingYRef.current = {};
    if (!remaining.length) {
      setReviewing(false);
      Alert.alert('Spell check', 'All done.');
      return;
    }
    setReviewIndex(Math.min(reviewIndex, remaining.length - 1));
  }

  // Auto-scroll the review body to the current finding when it changes.
  useEffect(() => {
    if (!reviewing) return;
    const m = misspellings[reviewIndex];
    if (!m || m.field !== 'body') return;
    const lines = bodyLinesRef.current;
    if (!lines || !lines.length) return;
    let acc = 0, targetY = 0;
    for (const ln of lines) {
      const len = ln.text ? ln.text.length : 0;
      if (m.start <= acc + len) { targetY = ln.y; break; }
      acc += len;
    }
    const y = Math.max(0, targetY + bodyOffsetYRef.current - ui(160));
    const t = setTimeout(() => reviewScrollRef.current?.scrollTo({ y, animated: true }), 60);
    return () => clearTimeout(t);
  }, [reviewIndex, reviewing, misspellings]);

  function renderReviewTitleSegments() {
    const titleHits = misspellings.filter(m => m.field === 'title');
    if (!titleHits.length) return title;
    const segs = [];
    let cursor = 0;
    titleHits.forEach((m, i) => {
      const globalIdx = misspellings.indexOf(m);
      if (m.start > cursor) segs.push(<Text key={'tn' + i}>{title.slice(cursor, m.start)}</Text>);
      const isCurrent = globalIdx === reviewIndex;
      segs.push(
        <Text key={'tm' + i} style={isCurrent ? styles.misspellCurrent : styles.misspell} onPress={() => setReviewIndex(globalIdx)}>
          {title.slice(m.start, m.start + m.length)}
        </Text>
      );
      cursor = m.start + m.length;
    });
    if (cursor < title.length) segs.push(<Text key="tt">{title.slice(cursor)}</Text>);
    return segs;
  }

  function renderReviewSegments() {
    const segs = [];
    let cursor = 0;
    misspellings.forEach((m, i) => {
      if (m.field !== 'body') return;
      if (m.start > cursor) segs.push(<Text key={'n' + i}>{body.slice(cursor, m.start)}</Text>);
      const isCurrent = i === reviewIndex;
      segs.push(
        <Text
          key={'m' + i}
          style={isCurrent ? styles.misspellCurrent : styles.misspell}
          onPress={() => setReviewIndex(i)}
        >
          {body.slice(m.start, m.start + m.length)}
        </Text>
      );
      cursor = m.start + m.length;
    });
    if (cursor < body.length) segs.push(<Text key="tail">{body.slice(cursor)}</Text>);
    return segs;
  }

  // ── REVIEW (spell check) MODE — unchanged proofing screen ──
  if (reviewing) {
    const current = misspellings[reviewIndex];
    const suggestions = (current?.suggestions || []).slice(0, 3);
    const currentWord = current
      ? (current.field === 'title' ? title : body).slice(current.start, current.start + current.length)
      : '';

    return (
      <View style={[styles.flex, { backgroundColor: colors.bg }]}>
        <View style={[styles.topBar, { paddingTop: Math.max(insets.top, ui(8)), paddingLeft: insets.left + ui(16), paddingRight: insets.right + ui(16), backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
          <View style={styles.topBarBack} />
          <View style={styles.topBarCenter}>
            <Text style={[styles.topBarBtnText, { color: colors.text, fontWeight: '700' }]}>Spell check</Text>
          </View>
          <TouchableOpacity
            style={styles.topBarRight}
            onPress={() => setReviewing(false)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.topBarBtnText, { color: colors.text, fontWeight: '700' }]}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          ref={reviewScrollRef}
          style={styles.flex}
          contentContainerStyle={[styles.reviewContent, { paddingLeft: insets.left + 18, paddingRight: insets.right + 18, paddingBottom: ui(24) }]}
          showsVerticalScrollIndicator={true}
        >
          {!!title && (
            <Text style={{ color: colors.text, fontFamily: ff, fontSize: reviewFont * 1.3, fontWeight: '700', marginBottom: ui(12) }}>
              {renderReviewTitleSegments()}
            </Text>
          )}
          <Text
            style={{ color: colors.text, fontFamily: ff, fontSize: reviewFont, lineHeight: reviewLH }}
            onTextLayout={(e) => {
              const raw = e.nativeEvent.lines || [];
              bodyLinesRef.current = raw.map(l => ({ y: l.y, text: l.text }));
              const m = misspellings[reviewIndex];
              if (m && m.field === 'body') {
                let acc = 0, targetY = 0;
                for (const ln of bodyLinesRef.current) {
                  const len = ln.text ? ln.text.length : 0;
                  if (m.start <= acc + len) { targetY = ln.y; break; }
                  acc += len;
                }
                const y = Math.max(0, targetY + bodyOffsetYRef.current - ui(160));
                setTimeout(() => reviewScrollRef.current?.scrollTo({ y, animated: false }), 30);
              }
            }}
            onLayout={(e) => { bodyOffsetYRef.current = e.nativeEvent.layout.y; }}
          >
            {renderReviewSegments()}
          </Text>
        </ScrollView>

        {/* Docked review bar — walks through findings one at a time. */}
        <View style={[styles.reviewBar, { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: insets.bottom + ui(12) }]}>
          <View style={styles.reviewBarHead}>
            <View style={styles.reviewBarWord}>
              <Text style={[styles.reviewBarWordText, { color: colors.text }]} numberOfLines={1}>
                {currentWord}{current?.field === 'title' ? '  (title)' : ''}
              </Text>
            </View>
            <Text style={[styles.reviewBarProgress, { color: colors.textMuted }]}>
              {reviewIndex + 1} of {misspellings.length}
            </Text>
          </View>

          {suggestions.length > 0 ? (
            <>
              <Text style={[styles.reviewReplaceLabel, { color: colors.textMuted }]}>Replace with:</Text>
              <View style={styles.reviewChips}>
                {suggestions.map((s, i) => (
                  <TouchableOpacity
                    key={s + i}
                    style={[
                      styles.reviewChip,
                      i === 0
                        ? { backgroundColor: '#15803d', borderColor: '#15803d' }
                        : { backgroundColor: colors.bg, borderColor: colors.border },
                    ]}
                    onPress={() => applySuggestion(s)}
                  >
                    <Text style={[styles.reviewChipText, { color: i === 0 ? '#fff' : colors.text }]} numberOfLines={1}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : (
            <Text style={[styles.reviewNoSuggest, { color: colors.textMuted }]}>No suggestions</Text>
          )}

          <View style={styles.reviewActions}>
            <TouchableOpacity style={[styles.reviewActionBtn, { borderColor: colors.border }]} onPress={skipCurrent}>
              <Text style={[styles.reviewActionText, { color: colors.textMuted }]}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.reviewActionBtn, { borderColor: colors.border }]} onPress={ignoreCurrent}>
              <Text style={[styles.reviewActionText, { color: colors.textMuted }]}>Ignore</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // ── THE UNIFIED SCREEN ──
  const isEmpty = !body;
  const bodyStyle = {
    color: colors.text,
    fontFamily: ff,
    fontSize: FONT_SIZES[fontIndex],
    lineHeight,
    fontWeight: '400',
  };

  const menuItems = editing
    ? [
        { label: 'Go to top',    icon: 'arrow.up',          onPress: jumpToTop },
        { label: 'Go to bottom', icon: 'arrow.down',        onPress: jumpToBottom },
        ...(isEmpty
          ? [{ label: 'Import',         icon: 'square.and.arrow.down', onPress: handlePickImport }]
          : [{ label: 'Check spelling', icon: 'checkmark.circle',      onPress: handleCheck }]
        ),
        ...(isEmpty ? [] : [{ label: 'Print', icon: 'printer', onPress: handlePrint }]),
        { label: 'Home',     icon: 'house',     onPress: jumpHome },
        { label: 'Settings', icon: 'gearshape', onPress: () => router.push('/settings') },
      ]
    : [
        { label: 'Go to top',    icon: 'arrow.up',           onPress: jumpToTop },
        { label: 'Go to bottom', icon: 'arrow.down',         onPress: jumpToBottom },
        { label: 'Edit',         icon: 'square.and.pencil',  onPress: enterEdit },
        ...(__DEV__ ? [{ label: 'Listen (dev)', icon: 'play.circle', onPress: devSmokeTest }] : []),
        { label: 'Print',        icon: 'printer',            onPress: handlePrint },
        { label: 'Home',         icon: 'house',              onPress: jumpHome },
        { label: 'Settings',     icon: 'gearshape',          onPress: () => router.push('/settings') },
      ];

  return (
    <View style={[styles.flex, { backgroundColor: colors.bg }]}>

      {/* Top bar — Back | (spacer) | Hamburger. Back's meaning is modal:
          editing → return to presenting (or leave, if the note is empty);
          presenting → leave the note. */}
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, ui(8)), paddingLeft: insets.left + ui(16), paddingRight: insets.right + ui(16), backgroundColor: colors.bg, borderBottomColor: colors.border }]}>
        <View style={styles.topBarSideStart}>
          <TouchableOpacity
            style={styles.topBarBackInner}
            onPress={() => {
              if (editing) {
                if (body.trim()) exitEdit();
                else { collapseKeyboard(); router.back(); }
              } else {
                router.back();
              }
            }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={[styles.topBarChevron, { color: colors.text }]}>‹</Text>
            <Text style={[styles.topBarText, { color: colors.text }]}> Back</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.topBarCenter} />
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

      {/* Fixed centered title strip — Text presenting, TextInput editing.
          Same bar height in both, so nothing below it moves. */}
      <View style={[styles.titleBar, { borderBottomColor: colors.border }]}>
        {editing ? (
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
        ) : (
          <Text style={[styles.titleText, { color: colors.text, fontFamily: ff }]} numberOfLines={1}>
            {title || 'Untitled'}
          </Text>
        )}
      </View>

      {/* Band overlay + fades — present mode only. Absolute overlays: their
          presence/absence never affects the text layout underneath. */}
      {!editing && (
        <>
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
        </>
      )}

      {/* THE ScrollView — same content padding in both modes. */}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={contentPadding}
        showsVerticalScrollIndicator={editing}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={editing}
        scrollEventThrottle={16}
        scrollsToTop={false}
        onLayout={e => { viewportHRef.current = e.nativeEvent.layout.height; }}
        onContentSizeChange={(w, h) => {
          contentHRef.current = h;
          if (!restoredScrollRef.current) {
            restoredScrollRef.current = true;
            const y = getScrollSync(id);
            if (y > 0) scrollRef.current?.scrollTo({ y: Math.min(y, Math.max(0, h)), animated: false });
          }
        }}
        onScrollBeginDrag={() => { editPinYRef.current = null; }}
        onScroll={e => {
          const y = e.nativeEvent.contentOffset.y;
          scrollYRef.current = y;
          const denom = Math.max(1, contentHRef.current - viewportHRef.current);
          const pct = Math.min(100, Math.max(0, Math.round((y / denom) * 100)));
          if (pct !== progressPctRef.current) { progressPctRef.current = pct; setProgress(pct); }
          if (saveScrollTimer.current) clearTimeout(saveScrollTimer.current);
          saveScrollTimer.current = setTimeout(() => setScroll(id, y), 400);
        }}
      >
        {editing ? (
          <TextInput
            ref={bodyInputRef}
            autoFocus
            selection={sel ?? undefined}
            style={[bodyStyle, styles.bodyInput]}
            value={body}
            onChangeText={(t) => { if (sel) setSel(null); setBody(t); }}
            placeholder="Tap to start typing…"
            placeholderTextColor={colors.placeholder}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
            spellCheck={true}
            autoCorrect={true}
          />
        ) : (
          <Text
            onTextLayout={e => { linesRef.current = e.nativeEvent.lines; computeLineStarts(); }}
            style={bodyStyle}
          >
            {body}
          </Text>
        )}
      </ScrollView>

      {/* Floating HUD — A− · progress · A+ and voice-follow. Present only. */}
      {!editing && (
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
      )}

      {/* Keyboard-dismiss pill — collapses the keyboard, STAYS in edit mode. */}
      {editing && keyboardVisible && (
        <TouchableOpacity
          style={[styles.kbDismiss, {
            bottom: keyboardHeight + 8,
            backgroundColor: colors.surface,
            borderColor: colors.border,
          }]}
          onPress={collapseKeyboard}
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

      {/* Popover menu — items depend on mode. */}
      {renderMenu(menuItems)}
    </View>
  );
}

const styles = StyleSheet.create({
  flex:   { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: ui(16),
    paddingBottom: ui(6),
    minHeight: TOP_BAR_H,
    borderBottomWidth: 1,
  },
  topBarBack:    { flex: 1, flexDirection: 'row', alignItems: 'center' },
  topBarSideStart: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start' },
  topBarSideEnd:   { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  topBarBackInner: { flexDirection: 'row', alignItems: 'center' },
  topBarChevron: { fontSize: ui(20), lineHeight: ui(22), marginRight: 1 },
  topBarText:    { fontSize: ui(16), lineHeight: ui(22) },
  topBarCenter:  { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  hamburgerBtn:  { padding: ui(4), borderRadius: ui(7) },
  hamburgerIcon: { width: ui(22), height: ui(16), justifyContent: 'space-between' },
  hamburgerLine: { height: ui(2), width: '100%', borderRadius: ui(1) },
  topBarRight:   { flex: 1, alignItems: 'flex-end' },
  topBarBtn:     { paddingHorizontal: ui(14), paddingVertical: ui(4), borderRadius: ui(8), borderWidth: 1 },
  topBarBtnText: { fontSize: ui(14), fontWeight: '600' },

  // Fixed centered title strip
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

  // Body input (shares bodyStyle with the present-mode Text; padding must be
  // 0 so the two render at identical positions)
  bodyInput: { padding: 0 },
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

  // Band + fades
  band: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    borderTopWidth: 1.5, borderBottomWidth: 1.5,
  },
  fade: { position: 'absolute', left: 0, right: 0, zIndex: 9 },

  // Spell-check review
  reviewContent: { flexGrow: 1, paddingHorizontal: 18, paddingTop: ui(14) },
  misspell: { color: '#dc2626', textDecorationLine: 'underline', textDecorationColor: '#dc2626' },
  misspellCurrent: { color: '#dc2626', textDecorationLine: 'underline', textDecorationColor: '#dc2626', backgroundColor: 'rgba(220,38,38,0.14)', fontWeight: '700' },
  reviewBar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: ui(16), paddingTop: ui(12) },
  reviewBarHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: ui(10) },
  reviewBarWord: { flex: 1, marginRight: ui(10) },
  reviewBarWordText: { fontSize: ui(16), fontWeight: '700' },
  reviewBarProgress: { fontSize: ui(13) },
  reviewChips: { flexDirection: 'row', flexWrap: 'wrap', gap: ui(8), marginBottom: ui(12) },
  reviewReplaceLabel: { fontSize: ui(13), marginBottom: ui(8) },
  reviewChip: { paddingHorizontal: ui(14), paddingVertical: ui(8), borderRadius: ui(9), borderWidth: 1 },
  reviewChipText: { fontSize: ui(15), fontWeight: '600' },
  reviewNoSuggest: { fontSize: ui(14), fontStyle: 'italic', marginBottom: ui(12) },
  reviewActions: { flexDirection: 'row', gap: ui(8) },
  reviewActionBtn: { flex: 1, alignItems: 'center', paddingVertical: ui(10), borderRadius: ui(9), borderWidth: 1 },
  reviewActionText: { fontSize: ui(15), fontWeight: '600' },

  // Floating HUD
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

  // Popover menu
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
