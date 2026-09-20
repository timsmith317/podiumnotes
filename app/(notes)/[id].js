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
  Platform, PanResponder, Animated, Easing,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { SymbolView } from 'expo-symbols';
import { useNotes } from '../../lib/useNotes';
import { getScrollSync, setScroll, clearScroll } from '../../lib/scrollMemory';
import { check as spellCheck } from '../../modules/spell-check';
import * as SpeechFollow from '../../modules/speech-follow';
import { useSettings, themeColors, fontFamily } from '../../lib/useSettings';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { readDocumentAsText } from '../../lib/importers';
import { prepareHeadStart } from '../../lib/listen';
import { useListen, fmt } from '../../lib/useListen';
import * as Print from 'expo-print';
import { ui, IS_TABLET } from '../../lib/scale';
import { bandAlphaColor, bandFillColor, bandBorderColor, lightenHex } from '../../lib/bandColor';

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

// Where a spoken paragraph's first line lands, as a fraction down the scroll
// viewport. Low enough to read from comfortably, high enough that a long
// paragraph can play out below it without reaching the HUD.
const FOLLOW_TOP_FRAC = 0.18;

// Opacity of the progress bar's fill, between the band's 15% fill and its
// 75% border. Nudge toward 0.75 for more punch, toward 0.15 to match the
// band's fill literally.
const BAR_ALPHA = 0.40;


// Audio-mode indicator for the top bar. Lives in the gap between Back and
// the hamburger — space that was already empty — so listening mode gets a
// positive cue without taking a single point from the text.
//
// Bars animate only while audio is actually playing; paused leaves them
// static, so the graphic distinguishes "listening" from "listening and
// currently speaking" the same way the transport icon does.
// Geometry for the wave: a strip TWO periods wide is drawn and slid left by
// exactly one period, so the loop is seamless — the shape at the end of the
// cycle is identical to the shape at the start.
// Audio-mode indicator for the top bar. Lives in the gap between Back and
// the hamburger — space that was already empty — so listening mode gets a
// cue without taking a point from the text.
//
// A sine wave was tried here and read as decoration rather than audio: it's
// smooth and periodic, and speech is neither. What makes a meter look like
// sound is IRREGULARITY — each bar moving to its own target on its own
// clock. So every bar runs an independent loop with a randomised height and
// a randomised duration, which is why it never settles into a pattern.
//
// It is not driven by the actual signal. True levels would mean attaching an
// MTAudioProcessingTap to the player item and streaming RMS to JS — real
// work for something purely decorative. Worth doing only if this doesn't
// convince.
const BAR_COUNT = 13;
const BAR_W = ui(5);
const BAR_GAP = ui(4);
const BAR_H = ui(22);
const BAR_IDLE = 0.28;          // resting scale when paused

function AudioWave({ color, visible, active }) {
  const bars = useRef(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(BAR_IDLE))
  ).current;
  const runningRef = useRef(false);

  useEffect(() => {
    runningRef.current = active;
    if (!active) {
      // Settle gently rather than snapping — an abrupt collapse on pause
      // looks like a glitch.
      bars.forEach(b => {
        Animated.timing(b, {
          toValue: BAR_IDLE, duration: 220, easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      });
      return;
    }

    // Each bar re-targets independently and forever; the recursion is what
    // keeps it from ever looking periodic.
    const step = (b) => {
      if (!runningRef.current) return;
      Animated.timing(b, {
        toValue: 0.22 + Math.random() * 0.78,
        duration: 110 + Math.random() * 190,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => { if (finished) step(b); });
    };
    bars.forEach((b, i) => setTimeout(() => step(b), i * 40));  // stagger the start

    return () => { runningRef.current = false; };
  }, [active, bars]);

  if (!visible) return null;

  return (
    <View style={styles.waveRow} pointerEvents="none">
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={[styles.waveBar, { backgroundColor: color, transform: [{ scaleY: b }] }]}
        />
      ))}
    </View>
  );
}

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
  // Voice follow stopped on its own. Shown on the mic button rather than in
  // a dialog — see the follow error handler.
  const [voiceFailed, setVoiceFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyInputRef = useRef(null);

  // ── Listen mode ──
  //
  // The HUD does double duty. Presenting: A− / scroll progress / A+ and the
  // mic. Listening: back-15 / audio scrubber / forward-15 and the rate.
  // Which one you're in is carried by the transport button's icon and by the
  // band — which is HIDDEN while listening, because "this is the line I'm
  // about to speak" is a claim the app can't make when it's the one
  // speaking.
  const listen = useListen({ id, title, body }, settings.wpm || 130, !!note);
  // Two modes, not three. Pausing used to keep the HUD in its audio layout —
  // band back, but no scroll timer and no text progress bar — which read as a
  // hybrid state rather than as presenting. Pause now returns the screen to
  // presenting completely: band, scroll progress, the time-into-the-talk
  // readout, and the font controls. The audio position is still held, so play
  // resumes exactly unless the reader has scrolled somewhere else.
  const listening = listen.playing || listen.busy;

  // Scrubber drag on the HUD track. Same capture-phase approach as before:
  // a JS PanResponder must claim the touch before the ScrollView behind it.
  const [hudScrubbing, setHudScrubbing] = useState(false);
  const [hudScrubT, setHudScrubT] = useState(0);
  const hudScrubbingRef = useRef(false);
  const hudScrubTRef = useRef(0);
  const hudBarRef = useRef({ x: 0, w: 0 });
  const listenRef = useRef(listen);
  const listeningRef = useRef(false);
  // Set when the reader scrolls while not playing — the signal that the next
  // play should start from the text rather than resume where audio stopped.
  const scrolledSinceStopRef = useRef(false);

  // Leaving the note ends a PAUSED session: the long-press exit is gone, so
  // without this a paused render would keep going and the audio session stay
  // active after the reader walked away. A PLAYING session is deliberately
  // left alone — that is the drive-and-listen case, and stopping it because
  // the screen unmounted is the opposite of what the reader wants.
  useEffect(() => {
    return () => {
      if (!listenRef.current?.playing) {
        try { listenRef.current?.stop(); } catch (e) {}
      }
    };
  }, []);
  useEffect(() => { listenRef.current = listen; });
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  const hudPan = useRef(null);
  if (!hudPan.current) {
    const canScrub = () => listenRef.current.duration > 0 && listeningRef.current;
    const applyX = (pageX) => {
      const { x, w } = hudBarRef.current;
      if (!(w > 0)) return;
      const frac = Math.max(0, Math.min(1, (pageX - x) / w));
      const t = frac * listenRef.current.duration;
      hudScrubTRef.current = t;
      setHudScrubT(t);
    };
    const finish = () => {
      if (!hudScrubbingRef.current) return;
      // NO CLAMP. The drop is absolute: the text is the source, so audio for
      // any point can be made on demand. This used to clamp to the rendered
      // edge, which is why dropping at 10:04 with 1:38 rendered silently
      // landed at 1:38 — the app substituting what it had for what was asked.
      // seek() re-renders from the target when it falls outside the window.
      const t = Math.max(0, hudScrubTRef.current);
      hudScrubbingRef.current = false;
      setHudScrubbing(false);
      listenRef.current.seek(t);
      listenRef.current.savePosition(t);

      // Put the TEXT where the audio is going, at once.
      //
      // A scrub clears the cues and rebuilds them as segments render, so the
      // follower has nothing to follow for a second or two — the text sat
      // where it was and then crawled to catch up, which reads as being lost
      // rather than as waiting. The scroll position for a given time is the
      // same mapping the presenter's timer uses, run backwards, so the text
      // can jump there immediately and let the cues take over when they
      // arrive.
      if (speechSeconds > 0) {
        const denom = Math.max(1, contentHRef.current - viewportHRef.current);
        const y = Math.max(0, Math.min(denom, (t / speechSeconds) * denom));
        autoScrollingRef.current = true;
        scrollRef.current?.scrollTo({ y, animated: false });
        // Cleared on the next frame so the reader's own drags still register.
        requestAnimationFrame(() => { autoScrollingRef.current = false; });
      }
    };
    hudPan.current = PanResponder.create({
      onStartShouldSetPanResponder: canScrub,
      onMoveShouldSetPanResponder: canScrub,
      onStartShouldSetPanResponderCapture: canScrub,
      onMoveShouldSetPanResponderCapture: canScrub,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: (e) => {
        if (!canScrub()) return;
        const { pageX, locationX } = e.nativeEvent;
        hudBarRef.current.x = pageX - locationX;
        hudScrubbingRef.current = true;
        setHudScrubbing(true);
        applyX(pageX);
      },
      onPanResponderMove: (e, g) => { if (hudScrubbingRef.current) applyX(g.moveX); },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }
  // iOS's interactive-pop recognizer listens near the left screen edge, and
  // a native recognizer always beats a JS PanResponder — so dragging the
  // scrubber would swipe the whole screen back instead of seeking. Suspend
  // the stack gesture while listening; it returns when playback stops.
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !listening });
  }, [listening, navigation]);

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
    if (__DEV__) console.log('[listen] menuOpen: scrollY', Math.round(y));
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
  // Each flanking control is a 48pt circle plus a 10pt gap. Without
  // accounting for the second one the pill overflows on narrower phones.
  const pillW = Math.min(width - ui(120) - (listen.stReady ? ui(58) : 0), 340);
  // Estimated speaking time for the whole note, so presentation mode can
  // show the same readout as listening: how far into the talk you are at
  // your own pace. Keeps the HUD's vertical rhythm identical in both modes —
  // the track sits at the same height either way.
  const speechSeconds = (() => {
    const w = body?.trim() ? body.trim().split(/\s+/).length : 0;
    return (w / (settings.wpm || 130)) * 60;
  })();

  // ── One theme colour through the whole HUD ──
  //
  // The band's colour is the app's accent as far as the reader is concerned,
  // so the transport, the mic, the scrubber and the meter all take it. That
  // carries a single splash of colour through the controls instead of two
  // competing accents.
  //
  // The band is drawn as a 15% fill with a 75% border. 15% is right behind
  // text and hopeless on a 6pt bar, so anything small uses the border alpha:
  // same hue, actually visible.
  const themeColor = (settings.bandColor && settings.bandColor !== 'clear')
    ? bandBorderColor(settings.bandColor) : colors.accent;
  // Between the band's two alphas. The band's 15% fill looked too light on
  // the bar and the 75% border looked too strong — which is expected: the
  // band is a large area WITH a border, behind dark text, while the bar is
  // 6pt of unoutlined colour on a grey track. Same value, very different
  // perceived weight. BAR_ALPHA is the dial.
  // Band colours are chosen to sit BEHIND dark text on a light page, so most
  // are dark — and a dark colour at 40% over a dark track is invisible. The
  // measured contrast in dark mode was 1.49 against the track, below the 1.68
  // that reads fine in light mode. Raising alpha alone tops out at 2.92, so
  // the colour is lightened toward white first, then drawn more solidly.
  const isDarkTheme = settings.themeMode === 'dark'
    || (settings.themeMode === 'system' && colorScheme === 'dark');
  const progressColor = (settings.bandColor && settings.bandColor !== 'clear')
    ? (isDarkTheme
        ? bandAlphaColor(lightenHex(settings.bandColor, 0.4), 0.7)
        : bandAlphaColor(settings.bandColor, BAR_ALPHA))
    : colors.accent;
  // The buffered region carries its own opacity: 0.3 in the style. Feeding it
  // themeColor (already 75%) landed near 22% — FAINTER than the 40% played
  // fill and close enough to the track's grey to vanish entirely. The raw
  // colour keeps it at 30%: visibly behind the fill, which is the convention,
  // but still visible.
  const bufferedColor = (settings.bandColor && settings.bandColor !== 'clear')
    ? (isDarkTheme ? lightenHex(settings.bandColor, 0.4) : settings.bandColor)
    : colors.accent;
  // The transport and mic deliberately keep the APP accent rather than the
  // band colour. Tinting them tracked the band well enough at rest but the
  // filled/active state needed per-colour contrast tuning to stay legible,
  // and the progress bar already carries the band colour through the HUD.

  // Start rendering the whole note as soon as it is open.
  //
  // The renderer outruns playback about four to one, so a few minutes with
  // the note on screen leaves the entire thing on disk — after which every
  // scrub is instant and there are no unrendered gaps to fall into. Opening
  // two notes and leaving each a few minutes prepares both.
  //
  // Debounced, so flicking through notes doesn't start a render for each.
  // Skipped while editing, because the text is still changing and every
  // keystroke invalidates the cache key. Not awaited, and errors swallowed:
  // a render that doesn't happen costs a slower first listen, never an error.
  useEffect(() => {
    if (editing || listening || !body?.trim()) return;
    const t = setTimeout(() => {
      prepareHeadStart({ id, title, body }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [id, editing, listening, body]);

  // An empty bar has to look like a bar.
  //
  // colors.border against colors.bg measures 1.22 contrast in dark and 1.23
  // in light — the same number — but low contrast reads far worse at the dark
  // end, and in dark mode the track simply vanished until audio had played.
  // A lighter slate takes it to 2.36 there; light mode is left alone.
  const trackColor = isDarkTheme ? '#475569' : colors.border;

  // Voice-follow failure, shown on the mic button. Literal colours, not
  // palette keys: the four themes have no warning colour and a missing key
  // resolves to undefined, which renders as nothing. A dark red measured
  // 2.76 against the dark theme's near-black surface versus 6.47 in light,
  // so dark gets a lighter one — both land near 6.5.
  const VOICE_FAIL = isDarkTheme ? '#f87171' : '#b91c1c';
  const VOICE_FAIL_FILL = isDarkTheme
    ? 'rgba(248,113,113,0.16)' : 'rgba(185,28,28,0.12)';

  // Smallest width the buffered window is drawn at, so "the engine is
  // working ahead of you" stays visible on a long note even when the buffer
  // is a couple of percent of it.
  const BUFFER_MIN_PCT = 4;

  const lineHeight = FONT_SIZES[fontIndex] * 1.55;
  // Hidden only while the app is speaking. The band means "the line I'm about
  // to speak", which is false exactly then — paused, the reader is back in
  // charge of the text and gets the whole presenting HUD with it.
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

  // ── Text auto-follow ──
  //
  // Scrolls the note so the paragraph being spoken stays on screen. The old
  // start-at-the-band feature ran the opposite direction — scroll position →
  // audio time — and a wrong answer there put playback in the wrong place,
  // which was glaring. This direction is forgiving: a line off is barely
  // noticeable, and every cue re-anchors, so nothing accumulates.
  //
  // Cues carry their opening WORDS rather than a character offset, because
  // offsets index the sanitized text sent to the synthesizer while the line
  // map indexes the body on screen. Matching words sidesteps that entirely.
  const followRef = useRef(true);           // engaged until the reader scrolls
  const [following, setFollowing] = useState(true);
  const lastCueRef = useRef(null);
  const cueYRef = useRef(null);        // content-y of the current cue's first line
  const nextYRef = useRef(null);       // …and of the next cue's, bounding the paragraph
  const autoScrollingRef = useRef(false);

  // Locate a cue's words in the script and return the character offset.
  // Searches forward from the previous match so repeated phrases resolve to
  // the right occurrence.
  function offsetForCueText(text, fromOffset) {
    const words = scriptWordsRef.current;
    if (!words.length) return -1;
    const needle = String(text).toLowerCase().match(/[a-z0-9']+/g);
    if (!needle || !needle.length) return -1;
    const probe = needle.slice(0, 4);      // enough to be unique, short enough to survive normalisation
    let startIdx = words.findIndex(w => w.offset >= fromOffset);
    if (startIdx < 0) startIdx = 0;
    for (let pass = 0; pass < 2; pass++) {
      const from = pass === 0 ? startIdx : 0;   // second pass: wrap and search the whole script
      for (let i = from; i <= words.length - probe.length; i++) {
        let ok = true;
        for (let j = 0; j < probe.length; j++) {
          if (words[i + j].w !== probe[j]) { ok = false; break; }
        }
        if (ok) return words[i].offset;
      }
    }
    return -1;
  }

  function lineYForOffset(offset) {
    const ls = lineStartsRef.current;
    if (!ls.length || offset < 0) return null;
    const line = ls.find(l => offset >= l.start && offset <= l.end)
      || ls.reduce((a, b) => (Math.abs(b.start - offset) < Math.abs(a.start - offset) ? b : a), ls[0]);
    return line ? line.y : null;
  }

  // Where to scroll so content-y `y` sits near the top of the viewport.
  //
  // scrollY === line.y puts that line at clampedBandTop (the content's top
  // padding is clampedBandTop − contentTop, so the two cancel). To place it
  // at screen position D instead, scroll to y + clampedBandTop − D.
  function scrollTargetFor(y) {
    const viewH = viewportHRef.current || height;
    const desiredScreenY = contentTop + viewH * FOLLOW_TOP_FRAC;
    return Math.max(0, y + clampedBandTop - desiredScreenY);
  }

  function scrollFollow(target) {
    if (!scrollRef.current) return;
    autoScrollingRef.current = true;
    scrollRef.current.scrollTo({ y: target, animated: true });
    setTimeout(() => { autoScrollingRef.current = false; }, 600);
  }

  // Runs on every progress tick.
  //
  // FONT SIZE is what makes this more than a jump-per-paragraph. Runway is
  // measured in pixels but a paragraph's height scales with type size: at
  // the smallest size a paragraph fits easily below the start position, at
  // the largest it can be two screens tall — and then the voice walks off
  // the bottom before the next cue arrives. So when a paragraph is taller
  // than the runway, creep through it in proportion to how far into the
  // paragraph the audio is. When it fits, place it once and leave it alone.
  useEffect(() => {
    if (!listen.playing || !followRef.current) return;
    const { cue, next } = listen.cueSpanAt(listen.elapsed);
    if (!cue) return;

    if (!scriptWordsRef.current.length) buildScriptWords();
    if (!lineStartsRef.current.length) computeLineStarts();

    if (cue !== lastCueRef.current) {
      lastCueRef.current = cue;
      cueYRef.current = lineYForOffset(offsetForCueText(cue.text, 0));
      nextYRef.current = null;
    }
    if (nextYRef.current == null && next) {
      nextYRef.current = lineYForOffset(offsetForCueText(next.text, 0));
    }

    const y0 = cueYRef.current;
    if (y0 == null) return;

    const viewH = viewportHRef.current || height;
    // The HUD floats over the bottom of the viewport, so the usable runway is
    // shorter than the viewport by that much. Without subtracting it the
    // creep stopped with the closing lines sitting behind the controls —
    // scrolled into the viewport, but not into view.
    const runway = Math.max(
      lineHeight,
      viewH * (1 - FOLLOW_TOP_FRAC) - hudClear - lineHeight * 1.5
    );

    // Every cue is bounded by the next one — except the last, which has no
    // successor. Left unbounded its span was zero, so the creep never
    // engaged: the final paragraph's first line went to the top and the text
    // below it was never scrolled into view, even though the audio kept
    // reading it. Bound the last cue by the end of the TEXT and the end of
    // the AUDIO instead.
    const ls = lineStartsRef.current;
    const lastLine = ls.length ? ls[ls.length - 1] : null;
    const textEndY = lastLine ? lastLine.y + lastLine.h : y0;

    const t0 = cue.time;
    const y1 = next ? nextYRef.current : textEndY;
    const t1 = next ? next.time : (listen.duration || t0 + 8);
    const span = (y1 != null && y1 > y0) ? y1 - y0 : 0;

    let advance = 0;
    if (span > runway) {
      const frac = t1 > t0
        ? Math.max(0, Math.min(1, (listen.elapsed - t0) / (t1 - t0)))
        : 0;
      advance = frac * (span - runway);
    }

    const target = scrollTargetFor(y0 + advance);
    // Move in line-sized steps: creeping a few pixels every tick would
    // shimmer, and a jump under one line isn't worth the animation.
    if (Math.abs(target - scrollYRef.current) < lineHeight * 0.6) return;
    scrollFollow(target);
  }, [listen.elapsed, listen.playing, listen.cueCount]);

  // Dots, not words. A percentage answered a question nobody asked, and the
  // words that replaced it wrapped over the progress bar and flashed past too
  // fast to read — which reads as an error rather than as work. Three dots
  // cycling say "working", which is all there is to say.
  const [prepDots, setPrepDots] = useState(0);
  useEffect(() => {
    if (!listen.busy) { setPrepDots(0); return; }
    const t = setInterval(() => setPrepDots(d => (d + 1) % 4), 400);
    return () => clearInterval(t);
  }, [listen.busy]);
  // Figure-space padding keeps the width fixed so nothing jitters or wraps.
  const prepLabel = '•••'.slice(0, prepDots) + '\u2007'.repeat(3 - prepDots);

  // Reaching the end returns the note to the top. Wherever the last cue
  // anchored is an arbitrary-looking spot, and what follows finishing a note
  // is almost always playing it again, presenting it, or putting it away —
  // all of which start from the beginning.
  useEffect(() => {
    if (listen.phase !== 'finished') return;
    lastCueRef.current = null;
    cueYRef.current = null;
    nextYRef.current = null;
    autoScrollingRef.current = true;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    const t = setTimeout(() => { autoScrollingRef.current = false; }, 700);
    return () => clearTimeout(t);
  }, [listen.phase]);

  // Starting playback re-anchors AND re-engages. Disengaging is a
  // within-session choice ("let me look elsewhere"), not a standing one —
  // without this, one stray scroll disabled following until the meter was
  // tapped, which is easy to miss and looks like the feature is broken.
  useEffect(() => {
    lastCueRef.current = null;
    cueYRef.current = null;
    nextYRef.current = null;
    if (listen.playing) {
      followRef.current = true;
      setFollowing(true);
    }
  }, [listen.playing]);

  // Editing invalidates both maps — offsets would point into stale text.
  useEffect(() => {
    scriptWordsRef.current = [];
    lastCueRef.current = null;
  }, [body]);

  // Voice-follow errors used to be swallowed entirely, which made the one
  // genuinely actionable failure invisible: on macOS, SFSpeechRecognizer
  // runs through the Dictation service, and with Dictation switched off
  // every recognition task fails instantly. Permissions look granted, the
  // microphone works, and nothing is transcribed — unguessable without
  // being told.
  //
  // The wrapper forwards the whole payload, so branch on `code` rather than
  // on error text Apple may reword. The text match stays as a fallback for
  // any error that reaches here without one.
  function handleVoiceError(payload) {
    let code = '', message = '';
    try {
      if (typeof payload === 'string') message = payload;
      else if (payload) { code = payload.code || ''; message = payload.message || ''; }
    } catch (e) {}

    stopVoice();

    const dictationOff = code === 'dictation-disabled'
      || /dictation/i.test(message);

    if (dictationOff) {
      Alert.alert(
        'Dictation is turned off',
        'Voice follow uses the system dictation service to recognise speech.\n\n' +
        'On Mac: System Settings \u2192 Keyboard \u2192 Dictation\n' +
        'On iPhone or iPad: Settings \u2192 General \u2192 Keyboard \u2192 Enable Dictation\n\n' +
        'Turn it on, then try voice follow again.'
      );
      return;
    }
    // NO ALERT. Everything below this point can only happen while voice
    // follow is running, which means the reader is at a podium in front of
    // people. A modal dialog there is worse than the failure it reports: it
    // covers the script, and it has to be dismissed before the talk can go
    // on. The mic button turning red says the same thing to the one person
    // who needs to know, and says nothing to the room.
    //
    // Dictation-disabled keeps its alert because it can only fire on a Mac,
    // at a desk, where the fix is one toggle and impossible to guess.
    setVoiceFailed(true);
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
        SpeechFollow.addErrorListener(handleVoiceError),
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
    if (voiceOn) stopVoice(); else { setVoiceFailed(false); startVoice(); }
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

    // Render the opening of the note NOW, while the reader is settling back
    // into the text, so Listen starts in a couple of seconds instead of
    // eight or nine. Leaving edit mode is the right moment: the text is
    // final, and the cache key is the text hash — so an unchanged note is a
    // no-op and an edited one renders its new opening.
    //
    // Not awaited and errors swallowed: a missing head start costs a slower
    // start, never a broken one.
    if (!listeningRef.current) {
      prepareHeadStart({ id, title, body }).catch(() => {});
    }
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
        <View style={styles.topBarCenter}>
          {/* The meter doubles as the follow control: dimmed means the text
              has stopped following the audio (you scrolled away), and a tap
              re-engages it. Reuses a graphic that's already there rather
              than adding another button. */}
          <TouchableOpacity
            onPress={() => {
              if (!listening) return;
              followRef.current = true;
              setFollowing(true);
              lastCueRef.current = null;      // force a re-anchor on the next tick
            }}
            disabled={!listening || following}
            hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
            style={{ opacity: following ? 1 : 0.35 }}
          >
            <AudioWave color={colors.accent} visible={listening} active={listen.playing} />
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
          presence/absence never affects the text layout underneath.
          Hidden for the whole LISTENING session, not just while sound is
          coming out. The band means "the line I'm about to say", which is
          false whenever the app owns the reading — and flickering it back on
          every pause made it unclear which mode you were in. It returns on
          long-press, which is the deliberate exit back to presenting. */}
      {!editing && !listening && (
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
        onScrollBeginDrag={() => {
          editPinYRef.current = null;
          // A deliberate drag means the reader wants to look elsewhere —
          // fighting them is the fastest way to make this feel broken.
          // Guarded against our own animated scrollTo, which is not a drag
          // but can overlap one.
          if (!autoScrollingRef.current && followRef.current) {
            followRef.current = false;
            setFollowing(false);
          }
          // A finger on the text while the app is not speaking says "start
          // from here next". onScroll was the wrong signal for this: it also
          // fires for auto-follow's own scrolling, so the flag could be set
          // or cleared without the reader touching anything.
          if (!autoScrollingRef.current && !listenRef.current.playing) {
            scrolledSinceStopRef.current = true;
          }   // auto-follow's own scrolling must not count as an instruction
        }}
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

      {/* Floating HUD — presenting: A− · scroll · A+ · mic.
          Listening: −15 · scrubber · +15 · rate. */}
      {!editing && (
        <View pointerEvents="box-none" style={[styles.hudWrap, { bottom: insets.bottom + ui(12) }]}>
          {/* Audio transport — a floating circle mirroring the mic, so the
              pill sits centred between two matching controls. The icon is
              the state: play means stopped, pause means playing. */}
          {listen.stReady && (
            <TouchableOpacity
              style={[styles.hudRound, {
                backgroundColor: listening ? colors.accent : colors.surface,
                borderColor: listening ? colors.accentBorder : colors.border,
              }]}
              onPress={() => {
                if (listen.playing) { listen.pause(); return; }
                if (voiceOn) stopVoice();     // mic and playback sessions conflict
                // Start where the reader is LOOKING, not where audio last
                // stopped. The presenter already shows this number while
                // scrolling, so pressing play begins at the time on screen —
                // the same instruction the scrubber gives, through the
                // gesture the reader already trusts.
                //
                // Only on a fresh start: once listening, pause and resume
                // keep their place, because that is what pause means.
                // Estimate-derived, so only used when the reader has MOVED
                // the text. Resuming an untouched pause resumes exactly —
                // otherwise every pause would nudge the position by whatever
                // the estimate is off by.
                const fromScroll = (progressPctRef.current / 100) * speechSeconds;
                // Start from the text ONLY if the reader moved it.
                //
                // This used to also require the hook to be in its paused
                // phase, which quietly broke resuming across app launches:
                // after a force quit the phase is idle, so the saved audio
                // position was discarded in favour of wherever the text
                // happened to be — usually the top. Coming back to a talk on
                // the next morning's drive and hearing it start over is the
                // worst failure this feature has, so the rule is now simply:
                // a finger on the text is an instruction, and everything
                // else resumes.
                const useScroll = scrolledSinceStopRef.current;
                scrolledSinceStopRef.current = false;
                listen.play(useScroll ? fromScroll : undefined);
              }}
              // The long-press exit is gone. It existed because the band only
              // returned when the whole session ended, so leaving listening
              // needed its own gesture. Pause brings the band back now, so
              // there is nothing left to exit from.
              delayLongPress={450}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              {listen.busy
                ? <SymbolView name="hourglass" size={ui(20)} tintColor={colors.accentText} type="monochrome" />
                : <SymbolView
                    name={listen.playing ? 'pause.fill' : 'play.fill'}
                    size={ui(20)}
                    tintColor={listening ? colors.accentText : colors.textMuted}
                    type="monochrome"
                  />}
            </TouchableOpacity>
          )}

          <View style={[styles.hudPill, { width: pillW, backgroundColor: colors.surface, borderColor: colors.border }]}>
            {/* Left: font down, or skip back */}
            <TouchableOpacity
              onPress={() => listening ? listen.nudge(-15) : setFontIndex(i => Math.max(0, i - 1))}
              disabled={!listening && fontIndex === 0}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={{ opacity: (!listening && fontIndex === 0) ? 0.3 : 1 }}
            >
              {listening
                ? <SymbolView name="gobackward.15" size={ui(25)} tintColor={colors.text} type="monochrome" />
                : <Text style={[styles.hudAa, { color: colors.text }]}>A−</Text>}
            </TouchableOpacity>

            {/* Centre: scroll progress, or the audio scrubber with elapsed
                time sitting on it — the one readout worth the space. */}
            <View
              style={styles.hudTrackWrap}
              {...(listening ? hudPan.current.panHandlers : {})}
            >
              <View
                style={[styles.hudTrack, { backgroundColor: trackColor }]}
                onLayout={e => { hudBarRef.current.w = e.nativeEvent.layout.width; }}
              >
                {/* The buffered region is a WINDOW, not a span from the
                    origin. A scrub can begin the composition partway into
                    the note, and drawing from zero claimed audio existed
                    before its start — which is why the shading looked wrong
                    after a jump: too full, then apparently shrinking as a
                    later composition started further along. */}
                {listening && listen.rendered > listen.renderedFrom && listen.duration > 0 && (
                  <View style={[styles.hudBuffered, {
                    backgroundColor: bufferedColor,
                    left: `${Math.min(100, (listen.renderedFrom / listen.duration) * 100)}%`,
                    // A real buffer is small against a long note: thirty
                    // seconds of audio on a 33-minute talk is 1.6% of the
                    // bar, about three pixels, most of it behind the thumb.
                    // The old bar looked substantial only because it drew
                    // from the origin, which claimed audio that did not
                    // exist. A floor keeps the true window legible without
                    // overstating it.
                    width: `${Math.max(BUFFER_MIN_PCT, Math.min(100,
                      ((listen.rendered - listen.renderedFrom) / listen.duration) * 100))}%`,
                  }]} />
                )}
                <View style={[styles.hudFill, {
                  width: listening
                    ? `${listen.duration ? Math.min(100, ((hudScrubbing ? hudScrubT : listen.elapsed) / listen.duration) * 100) : 0}%`
                    : `${progress}%`,
                  backgroundColor: progressColor,
                }]} />
              </View>
              {/* A handle, so the track reads as draggable rather than as a
                  readout. Grows while dragging for finger feedback. */}
              {listening && listen.duration > 0 && (
                <View
                  pointerEvents="none"
                  style={[styles.hudThumb, {
                    left: `${Math.min(100, ((hudScrubbing ? hudScrubT : listen.elapsed) / listen.duration) * 100)}%`,
                    backgroundColor: themeColor,
                    borderColor: colors.surface,
                    transform: [{ scale: hudScrubbing ? 1.35 : 1 }],
                  }]}
                />
              )}
              <Text style={[styles.hudTime, {
                color: hudScrubbing ? themeColor : colors.textMuted,
              }]}>
                {listening
                  ? (listen.busy
                      ? prepLabel
                      : fmt(hudScrubbing ? hudScrubT : listen.elapsed))
                  : fmt((progress / 100) * speechSeconds)}
              </Text>
            </View>

            {/* Right: font up, or skip forward */}
            <TouchableOpacity
              onPress={() => listening ? listen.nudge(15) : setFontIndex(i => Math.min(FONT_SIZES.length - 1, i + 1))}
              disabled={!listening && fontIndex === FONT_SIZES.length - 1}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              style={{ opacity: (!listening && fontIndex === FONT_SIZES.length - 1) ? 0.3 : 1 }}
            >
              {listening
                ? <SymbolView name="goforward.15" size={ui(25)} tintColor={colors.text} type="monochrome" />
                : <Text style={[styles.hudAa, { color: colors.text }]}>A+</Text>}
            </TouchableOpacity>
          </View>

          {/* Right circle: mic while presenting, playback rate while
              listening. The mic is unusable during playback anyway — the two
              audio sessions conflict — so this repurposes a dead control
              rather than stealing a live one. */}
          {listening ? (
            <TouchableOpacity
              style={[styles.hudRound, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={listen.cycleRate}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.hudRate, { color: colors.text }]} numberOfLines={1}>
                {listen.playbackRate}×
              </Text>
            </TouchableOpacity>
          ) : SHOW_VOICE_PLACEHOLDER && (
            <TouchableOpacity
              style={[styles.hudRound, {
                backgroundColor: voiceOn ? colors.accent
                  : voiceFailed ? VOICE_FAIL_FILL : colors.surface,
                borderColor: voiceOn ? colors.accentBorder
                  : voiceFailed ? VOICE_FAIL : colors.border,
              }]}
              onPress={toggleVoice}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <SymbolView
                name={voiceOn ? 'mic.fill' : voiceFailed ? 'mic.slash' : 'mic'}
                size={ui(22)}
                tintColor={voiceOn ? colors.accentText
                  : voiceFailed ? VOICE_FAIL : colors.textMuted}
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
  // Clip to one period so the doubled strip underneath is invisible.
  waveRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: BAR_GAP, height: BAR_H, marginBottom: ui(2),
  },
  // scaleY grows about the centre, so bars expand both ways — the symmetric
  // look of a voice meter rather than a bar chart.
  waveBar: { width: BAR_W, height: BAR_H, borderRadius: BAR_W / 2 },
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
  // The track sits in a taller wrapper so a drag has something to grab —
  // 6pt is fine to look at and hopeless to hit.
  // Extra room underneath for the elapsed readout; the track itself stays
  // vertically centred on the pill.
  hudTrackWrap: {
    flex: 1, marginHorizontal: ui(12), justifyContent: 'center',
    paddingTop: ui(4), paddingBottom: ui(22),
  },
  hudTrack: { height: ui(6), borderRadius: ui(3), overflow: 'hidden' },
  hudFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    borderRadius: ui(3), zIndex: 2,
  },
  // Rendered-but-unplayed, behind the played fill — the same convention
  // every video player uses, so it needs no explanation.
  // `left` is set inline: the rendered window can start partway along.
  // 0.45, not 0.3: it sits UNDER the played fill and has to stay legible as
  // a thin sliver, which 0.3 of an already-transparent colour did not.
  // Both bands are absolutely positioned and explicitly stacked. hudFill
  // used to be a normal flow child with height:'100%', so its layout box
  // covered the whole track and painted over the buffered band underneath —
  // which is why the buffered region was invisible no matter how wide or how
  // opaque it was made. The data had been right for some time; the pixels
  // were not.
  hudBuffered: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    borderRadius: ui(3), opacity: 0.45, zIndex: 1,
  },
  // top = track centre (paddingTop + half the 6pt track) minus half the
  // thumb, so it stays centred if the padding above ever changes again.
  hudThumb: {
    position: 'absolute', top: ui(4) + ui(3) - ui(7),
    width: ui(14), height: ui(14), borderRadius: ui(7),
    marginLeft: ui(-7), borderWidth: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2, shadowRadius: 2, elevation: 3,
  },
  // Sits BELOW the track rather than across it, so the bar stays a clean
  // line and the reading has its own space.
  // Anchored by `bottom`, so a larger size grows UPWARD into the gap under
  // the track rather than pushing the pill taller. Tablets (and the Mac,
  // which runs as an iPad app) get a bigger step: the pill is capped at 340
  // wide, so on a large screen the readout otherwise looks lost in it.
  hudTime: {
    position: 'absolute', left: 0, right: 0, bottom: ui(-3),
    textAlign: 'center', fontSize: ui(IS_TABLET ? 16 : 12), fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  hudRate: { fontSize: ui(15), fontWeight: '700' },

  // Shared by the audio transport (left) and the mic (right) so the pair
  // reads as a matched set on either side of the pill.
  hudRound: {
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
