// app/(notes)/index.js
import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Pressable, StyleSheet, RefreshControl,
  useColorScheme, Image, Alert,
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import { SymbolView } from 'expo-symbols';
import { useNotes } from '../../lib/useNotes';
import { useSettings, themeColors } from '../../lib/useSettings';
import { ui, uic, uit } from '../../lib/scale';
import { formatDate } from '../../lib/utils';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { clearScroll } from '../../lib/scrollMemory';

// Custom header height — match the editor's TOP_BAR_H idea so the popover
// menu anchors at a predictable offset below the bar.
const HEADER_H = ui(44);

export default function NotesListScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { notes, createNote, deleteNote, refresh, reorderNotes } = useNotes();
  const [reorderMode, setReorderMode] = useState(false);
  const { settings } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);
  // Is the active theme a dark-background one? Mirrors themeColors' own logic.
  // Drives the wordmark: light theme (incl. sepia/ice) → DARK mark tile so it
  // contrasts with the light header and reads distinct from the hamburger;
  // dark theme → LIGHT mark tile. The mark is always the opposite lightness of
  // the header, so it always reads as a badge, never blends in.
  const isDarkTheme = settings.themeMode === 'dark'
    || (settings.themeMode === 'system' && colorScheme === 'dark');
  // Track each row's Swipeable by note id, and which row is currently open, so
  // opening one closes the previously-open one — while an open row STAYS open
  // until you tap Delete, tap the row, swipe it back, or open another row.
  const swipeableRefs = useRef({});
  const openRowId = useRef(null);
  const listRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Pull-to-refresh: manually trigger a cloud reconcile (pull notes + honor
  // deletions). Sync otherwise runs only on app launch; this lets the user
  // fetch changes on demand — e.g. after adding or deleting a note on another
  // device — without restarting the app. refresh() (from useNotes) updates the
  // sync layer's snapshot to the current notes, then reconciles, so the list
  // updates itself via the remote-change path.
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();     // refreshes the sync snapshot, then reconciles
    } catch (e) {
      // reconcile errors surface in the diagnostics panel; nothing to do here
    } finally {
      // brief floor so the spinner doesn't flicker out instantly on a fast sync
      setTimeout(() => setRefreshing(false), 400);
    }
  }, [refresh]);

  // Hide the native header entirely — we draw our own below
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, []);

  function handleNew() {
    const id = createNote();
    router.push(`/${id}`);
  }

  // Reorder (arrows): move a note one position up (dir -1) or down (dir +1).
  // Local-only order via reorderNotes; end-caps are guarded so the first note
  // can't move up and the last can't move down.
  function moveNote(index, dir) {
    const to = index + dir;
    if (to < 0 || to >= notes.length) return;
    const next = [...notes];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    reorderNotes(next);
  }

  // Import: same DocumentPicker flow as the editor, but the result lands in
  // a brand-new note (or PDF viewer) and we navigate into it. The editor's
  // version appends to the current body; here we always create.
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
      const isPdf = (asset.mimeType && asset.mimeType.includes('pdf')) ||
        /\.pdf$/i.test(asset.name || '');
      if (isPdf) {
        const dir = FileSystem.documentDirectory + 'pdfs/';
        try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch (e) {}
        const dest = dir + 'pdf-' + Date.now() + '.pdf';
        await FileSystem.copyAsync({ from: asset.uri, to: dest });
        const pdfTitle = (asset.name || 'PDF').replace(/\.pdf$/i, '');
        const newId = createNote({ kind: 'pdf', title: pdfTitle, fileUri: dest });
        router.push({ pathname: '/pdf-present', params: { uri: dest, name: pdfTitle, id: newId } });
        return;
      }
      const text = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const title = (asset.name || 'Imported').replace(/\.\w+$/i, '').slice(0, 60);
      const newId = createNote({ title, body: text });
      router.push(`/${newId}`);
    } catch (e) {
      Alert.alert('Import failed', 'Could not read that file. Try plain text or markdown.');
    }
  }

  // FlatList jumps. scrollToOffset(0) -> top; scrollToEnd -> bottom.
  // Both animated:false so a long list jump is crisp.
  function jumpToTop() {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }
  function jumpToBottom() {
    if (notes.length === 0) return;
    listRef.current?.scrollToEnd({ animated: false });
  }

  // Popover menu — same look, feel, and behavior as the editor's. Items
  // passed in; each item: { label, icon, onPress }.
  function renderMenu(items) {
    if (!menuOpen) return null;
    return (
      <>
        <Pressable
          style={[styles.menuBackdrop, { top: insets.top + HEADER_H }]}
          onPress={() => setMenuOpen(false)}
        />
        <Pressable
          onPress={() => {}}
          style={[styles.menuPositioner, {
            top: insets.top + HEADER_H + ui(4),
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

  function handleDelete(item) {
    // Close the swipe row when acting on it — on Cancel it tidies back shut;
    // on Delete the row is removed anyway.
    swipeableRefs.current[item.id]?.close();
    Alert.alert(
      'Delete Note',
      `Delete "${item.title || 'Untitled'}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => {
          if (item.kind === 'pdf' && item.fileUri) {
            FileSystem.deleteAsync(item.fileUri, { idempotent: true }).catch(() => {});
          }
          clearScroll(item.id);
          deleteNote(item.id);
        } },
      ]
    );
  }

  function renderRightActions(item) {
    return (
      <TouchableOpacity
        style={styles.deleteAction}
        onPress={() => handleDelete(item)}
        activeOpacity={0.85}
      >
        <Text style={styles.deleteActionText}>Delete</Text>
      </TouchableOpacity>
    );
  }

  function handleEdit(item) {
    swipeableRefs.current[item.id]?.close();
    if (item.kind === 'pdf') return;         // PDFs can't be text-edited (button is greyed)
    router.push(`/${item.id}?edit=1`);       // open the note directly in edit mode
  }

  // Left-swipe (swipe right) reveals a green Edit action — a shortcut straight
  // into the editor, skipping presenter → menu → Edit. Greyed + inert for PDFs.
  function renderLeftActions(item) {
    const isPdf = item.kind === 'pdf';
    return (
      <TouchableOpacity
        style={[styles.editAction, isPdf && styles.editActionDisabled]}
        onPress={() => handleEdit(item)}
        activeOpacity={isPdf ? 1 : 0.85}
        disabled={isPdf}
      >
        <Text style={[styles.editActionText, isPdf && styles.editActionTextDisabled]}>Edit</Text>
      </TouchableOpacity>
    );
  }

  const renderItem = useCallback(({ item }) => {
    const isPdf = item.kind === 'pdf';
    // Slice at 300 (not 80): enough for 2 lines of preview at Text's
    // numberOfLines={2} on the widest iPad without wasteful measurement of
    // the entire body. RN handles the final truncation with an ellipsis.
    const preview = isPdf ? 'PDF document — opens in presenter'
      : (item.body?.trim().slice(0, 300) || 'Empty note');
    const wordCount = isPdf ? 0 : item.body.split(/\s+/).filter(Boolean).length;
    // Per-user pace from settings; ?? 130 covers the upgrade window where
    // a stored settings blob predates the new field.
    const wpm = settings.wordsPerMinute ?? 130;
    const speakMins = wordCount / wpm;
    const timeStr = speakMins < 1 ? '<1 min' : `~${Math.round(speakMins)} min`;
    const metaRight = isPdf
      ? 'PDF'
      : (wordCount > 0 ? `${wordCount} words · ${timeStr}` : 'Empty');

    return (
      <Swipeable
        renderRightActions={() => renderRightActions(item)}
        renderLeftActions={() => renderLeftActions(item)}
        rightThreshold={40}
        leftThreshold={40}
        ref={ref => { swipeableRefs.current[item.id] = ref; }}
        onSwipeableWillOpen={() => {
          // Close the previously-open row (if it's a different one) so only one
          // is open at a time. This row then stays open on its own.
          const prev = openRowId.current;
          if (prev && prev !== item.id) {
            swipeableRefs.current[prev]?.close();
          }
          openRowId.current = item.id;
        }}
        onSwipeableClose={() => {
          if (openRowId.current === item.id) openRowId.current = null;
        }}
        overshootLeft={false}
        overshootRight={false}
        useNativeAnimations={false}
      >
        <Pressable
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? colors.surface : colors.bg },
          ]}
          delayPressIn={80}
          onPress={() => {
            // If this row is swiped open, a tap just closes it (don't navigate).
            if (openRowId.current === item.id) {
              swipeableRefs.current[item.id]?.close();
              return;
            }
            isPdf
              ? router.push({ pathname: '/pdf-present', params: { uri: item.fileUri, name: item.title || 'PDF', id: item.id } })
              : router.push(`/${item.id}`);
          }}
        >
          <View style={styles.rowInner}>
            <View style={styles.rowTitleLine}>
              {isPdf && (
                <View style={[styles.pdfBadge, { borderColor: colors.border }]}>
                  <SymbolView name="doc.text" size={ui(13)} tintColor={colors.textMuted} type="monochrome" />
                </View>
              )}
              <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                {item.title || (isPdf ? 'PDF' : 'Untitled')}
              </Text>
            </View>
            <Text style={[styles.rowMeta, { color: colors.textMuted }]}>
              {formatDate(item.updatedAt)} · {metaRight}
            </Text>
            <Text style={[styles.rowPreview, { color: colors.textMuted }]} numberOfLines={2}>
              {preview}
            </Text>
          </View>
          <Text style={[styles.rowChevron, { color: colors.textFaint }]}>›</Text>
        </Pressable>
      </Swipeable>
    );
  }, [colors, notes, settings.wordsPerMinute]);

  // Style A reorder row: the SAME full note row (title, meta, preview) but with
  // a compact up/down arrow stack on the right instead of the chevron. No
  // Swipeable, non-tappable — arrows are the only interaction. First row's up
  // and last row's down are disabled (greyed), since they can't move further.
  const renderReorderItem = useCallback(({ item, index }) => {
    const isPdf = item.kind === 'pdf';
    const preview = isPdf ? 'PDF document — opens in presenter'
      : (item.body?.trim().slice(0, 300) || 'Empty note');
    const wordCount = isPdf ? 0 : item.body.split(/\s+/).filter(Boolean).length;
    const wpm = settings.wordsPerMinute ?? 130;
    const speakMins = wordCount / wpm;
    const timeStr = speakMins < 1 ? '<1 min' : `~${Math.round(speakMins)} min`;
    const metaRight = isPdf ? 'PDF' : (wordCount > 0 ? `${wordCount} words · ${timeStr}` : 'Empty');
    const isFirst = index === 0;
    const isLast = index === notes.length - 1;
    return (
      <View style={[styles.row, styles.reorderRowRelative, { backgroundColor: colors.bg }]}>
        <View style={styles.rowInner}>
          <View style={styles.rowTitleLine}>
            {isPdf && (
              <View style={[styles.pdfBadge, { borderColor: colors.border }]}>
                <SymbolView name="doc.text" size={ui(13)} tintColor={colors.textMuted} type="monochrome" />
              </View>
            )}
            <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
              {item.title || (isPdf ? 'PDF' : 'Untitled')}
            </Text>
          </View>
          <Text style={[styles.rowMeta, { color: colors.textMuted }]}>
            {formatDate(item.updatedAt)} · {metaRight}
          </Text>
          <Text style={[styles.rowPreview, { color: colors.textMuted }]} numberOfLines={2}>
            {preview}
          </Text>
        </View>
        {/* Invisible spacer matching the normal row's chevron footprint, so the
            text column (rowInner, flex:1) computes the SAME width as in normal
            mode — no reflow when entering reorder. The arrows overlay on top. */}
        <Text style={[styles.rowChevron, { color: 'transparent' }]}>›</Text>
        <View style={styles.reorderArrows} pointerEvents="box-none">
          <TouchableOpacity
            onPress={() => moveNote(index, -1)}
            disabled={isFirst}
            style={[styles.reorderArrowBtn, { backgroundColor: colors.surface, borderColor: colors.border }, isFirst && styles.reorderArrowDisabled]}
            hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }}
          >
            <SymbolView name="chevron.up" size={ui(22)} tintColor={isFirst ? colors.textFaint : colors.text} type="monochrome" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => moveNote(index, 1)}
            disabled={isLast}
            style={[styles.reorderArrowBtn, { backgroundColor: colors.surface, borderColor: colors.border }, isLast && styles.reorderArrowDisabled]}
            hitSlop={{ top: 4, bottom: 4, left: 6, right: 6 }}
          >
            <SymbolView name="chevron.down" size={ui(22)} tintColor={isLast ? colors.textFaint : colors.text} type="monochrome" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }, [colors, notes, settings.wordsPerMinute]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>

      {/* Custom header — plain View, no native nav bar, no Liquid Glass */}
      <View style={[styles.customHeader, {
        paddingTop: Math.max(insets.top, ui(8)),
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: colors.headerBg,
        borderBottomColor: colors.border,
      }]}>
        <View style={styles.customHeaderInner}>
          {/* Brand — left-aligned, matching the landing nav */}
          <View style={styles.brand}>
            <View style={[styles.mark, isDarkTheme ? styles.markLight : styles.markDark]}>
              <View style={[styles.markBarOuter, isDarkTheme ? styles.markBarOuterLight : styles.markBarOuterDark]} />
              <View style={styles.markBarMid} />
              <View style={[styles.markBarOuter, isDarkTheme ? styles.markBarOuterLight : styles.markBarOuterDark]} />
            </View>
            <Text style={[styles.headerTitleText, { color: colors.text }]}>Podium Notes</Text>
          </View>

          <View style={styles.flexSpacer} />

          {reorderMode ? (
            <TouchableOpacity
              onPress={() => setReorderMode(false)}
              hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
            >
              <Text style={[styles.reorderDoneText, { color: colors.text }]}>Done</Text>
            </TouchableOpacity>
          ) : (
            /* Single hamburger button — actions live in the popover so the
                header stays clean and the pattern matches the editor screens. */
            <TouchableOpacity
              style={styles.hamburgerBtn}
              onPress={() => setMenuOpen(prev => !prev)}
              activeOpacity={1}
              hitSlop={{ top: 12, bottom: 12, left: 10, right: 10 }}
            >
              <View style={styles.hamburgerIcon}>
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
                <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
              </View>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={notes}
        keyExtractor={item => item.id}
        renderItem={reorderMode ? renderReorderItem : renderItem}
        removeClippedSubviews={false}
        refreshControl={
          reorderMode ? undefined : (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textMuted}
            />
          )
        }
        contentContainerStyle={[
          notes.length === 0 ? styles.emptyContainer : styles.listContent,
          { paddingBottom: insets.bottom + ui(80), paddingLeft: insets.left, paddingRight: insets.right },
        ]}
        ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: colors.border }]} />}
        ListFooterComponent={notes.length > 0 ? () => <View style={[styles.separator, { backgroundColor: colors.border }]} /> : null}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No notes yet</Text>
            <Text style={[styles.emptyBody, { color: colors.textMuted }]}>
              Tap the menu and choose New note to create your first speech or presentation.
            </Text>
          </View>
        }
      />

      {/* Popover menu — same shape as the editor. Home is included here as
          a no-op so the menu reads the same on every screen; tapping it
          just closes the menu (you're already home). */}
      {renderMenu([
        { label: 'Go to top',    icon: 'arrow.up',   onPress: jumpToTop },
        { label: 'Go to bottom', icon: 'arrow.down', onPress: jumpToBottom },
        { label: 'New note',     icon: 'plus',       onPress: handleNew },
        { label: 'Import',       icon: 'square.and.arrow.down', onPress: handlePickImport },
        ...(notes.length > 1
          ? [{ label: 'Reorder notes', icon: 'arrow.up.arrow.down', onPress: () => { setMenuOpen(false); setReorderMode(true); } }]
          : []),
        { label: 'Home',         icon: 'house',      onPress: () => {} },
        { label: 'Settings',     icon: 'gearshape',  onPress: () => router.push('/settings') },
      ])}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Custom header
  customHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  customHeaderInner: {
    height: ui(44),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: ui(16),
  },
  brand:        { flexDirection: 'row', alignItems: 'center', gap: uic(9) },
  flexSpacer: { flex: 1 },

  // Hamburger button — manual three-line icon for consistent spacing.
  hamburgerBtn:  { padding: ui(4), borderRadius: ui(7) },
  reorderDoneText: { fontSize: uit(17), fontWeight: '700' },
  reorderRowRelative: { position: 'relative' },
  reorderArrows: {
    position: 'absolute', right: ui(12), top: 0, bottom: 0,
    flexDirection: 'column', gap: ui(6),
    alignItems: 'center', justifyContent: 'center',
  },
  reorderArrowBtn: {
    width: ui(48), height: ui(38), borderRadius: ui(10),
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  reorderArrowDisabled: { opacity: 0.35 },
  hamburgerIcon: { width: ui(22), height: ui(16), justifyContent: 'space-between' },
  hamburgerLine: { height: ui(2), width: '100%', borderRadius: ui(1) },
  mark: {
    width: uic(28), height: uic(28), borderRadius: uic(7),
    alignItems: 'center', justifyContent: 'center',
  },
  // Dark-tile mark — shown in LIGHT themes (contrasts with light header).
  markDark:  { backgroundColor: '#14213a' },
  // Light-tile mark — shown in DARK theme (contrasts with dark header).
  markLight: { backgroundColor: '#ffffff', borderWidth: uic(1), borderColor: '#e2e8f0' },
  markBarOuter:      { width: uic(15), height: uic(3), borderRadius: uic(1.5), marginVertical: uic(1.2) },
  markBarOuterDark:  { backgroundColor: '#e2e8f0' },   // light-grey bars on the navy tile
  markBarOuterLight: { backgroundColor: '#0f172a' },   // near-black bars on the white tile
  markBarMid:   { width: uic(15), height: uic(4.6), borderRadius: uic(2),   backgroundColor: '#34d399', marginVertical: uic(1.2) },
  headerTitleText: { fontSize: uit(18), fontWeight: '700', letterSpacing: -0.2 },
  rowTitleLine:    { flexDirection: 'row', alignItems: 'center', gap: ui(6) },
  pdfBadge:        { width: ui(18), height: ui(18), borderRadius: ui(4), borderWidth: 1, alignItems: 'center', justifyContent: 'center' },

  // List
  listContent:    { paddingTop: 0 },
  emptyContainer: { flex: 1 },
  separator:      { height: 1, marginLeft: ui(16) },

  row:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: ui(16), paddingVertical: ui(14) },
  rowInner:   { flex: 1, minWidth: 0, alignSelf: 'stretch' },
  rowTitle:   { fontSize: uit(17), fontWeight: '700', marginBottom: ui(3) },
  rowMeta:    { fontSize: uit(12), marginBottom: ui(4) },
  rowPreview: { fontSize: uit(14), lineHeight: uit(20), width: '100%' },
  rowChevron: { fontSize: ui(22), marginLeft: ui(8) },

  deleteAction:     { backgroundColor: '#dc2626', justifyContent: 'center', alignItems: 'center', width: ui(80) },
  deleteActionText: { color: '#fff', fontWeight: '700', fontSize: ui(15) },
  editAction:         { backgroundColor: '#15803d', justifyContent: 'center', alignItems: 'center', width: ui(80) },
  editActionText:     { color: '#fff', fontWeight: '700', fontSize: ui(15) },
  editActionDisabled: { backgroundColor: '#9ca3af' },
  editActionTextDisabled: { color: '#e5e7eb' },

  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: ui(40) },
  emptyTitle: { fontSize: ui(20), fontWeight: '700', marginBottom: ui(10) },
  emptyBody:  { fontSize: ui(15), textAlign: 'center', lineHeight: ui(22) },

  fab: {
    position: 'absolute', right: ui(20),
    width: uic(52), height: uic(52), borderRadius: uic(26),
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2, shadowRadius: 4, elevation: 6,
  },
  fabLabel: { fontSize: uic(28), lineHeight: uic(32), marginTop: -2 },

  // Popover menu — mirror of the editor's design so the pattern feels
  // uniform across screens. Backdrop starts below the header so the
  // hamburger button stays tappable (toggle on second tap).
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
