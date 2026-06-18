import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  StyleSheet, Dimensions, useWindowDimensions, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import { useNotes } from '../../lib/useNotes';
import { useBandSettings } from '../../lib/useBandSettings';
import ImportButton from '../../components/ImportButton';

const FONT_SIZES = [18, 22, 26, 30, 36, 42];

export default function EditorScreen() {
  const { id } = useLocalSearchParams();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { getNote, updateNote } = useNotes();
  const { settings } = useBandSettings();

  const note = getNote(id);
  const [body, setBody] = useState(note?.body ?? '');
  const [title, setTitle] = useState(note?.title ?? '');
  const [presenting, setPresenting] = useState(false);
  const [fontIndex, setFontIndex] = useState(2); // default 26px
  const [locked, setLocked] = useState(false);

  useKeepAwake();

  // Persist on change
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => updateNote(id, { title, body }), 400);
    return () => clearTimeout(t);
  }, [title, body]);

  // Set header title
  useEffect(() => {
    navigation.setOptions({
      title: title || 'Untitled',
      headerRight: () => (
        <TouchableOpacity onPress={() => setPresenting(p => !p)} style={{ marginRight: 4 }}>
          <Text style={{ color: presenting ? '#4ade80' : '#94a3b8', fontSize: 15, fontWeight: '700' }}>
            {presenting ? 'Edit' : 'Present'}
          </Text>
        </TouchableOpacity>
      ),
    });
  }, [title, presenting]);

  // Band geometry — recalculates on orientation change
  const lineHeight = FONT_SIZES[fontIndex] * 1.55;
  const bandHeight = settings.lines * lineHeight;
  const bandTop = height * (settings.positionPct / 100) - bandHeight / 2;
  const barTop = insets.top + 44; // below header
  const clampedBandTop = Math.max(barTop + 8, Math.min(bandTop, height - bandHeight - insets.bottom - 8));

  function handleImport(text) {
    setBody(prev => (prev ? prev + '\n\n' + text : text));
  }

  if (!note) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Note not found.</Text>
      </View>
    );
  }

  // ── PRESENT MODE ──
  if (presenting) {
    return (
      <View style={styles.presenterContainer}>
        {/* Band overlay */}
        <View
          pointerEvents="none"
          style={[styles.band, { top: clampedBandTop, height: bandHeight }]}
        />
        {/* Fades */}
        <View pointerEvents="none" style={[styles.fadeTop, { top: clampedBandTop - 40, height: 40 }]} />
        <View pointerEvents="none" style={[styles.fadeBottom, { top: clampedBandTop + bandHeight, height: 40 }]} />

        {/* Scrollable text */}
        <ScrollView
          style={styles.presenterScroll}
          contentContainerStyle={{
            paddingTop: clampedBandTop - barTop,
            paddingBottom: height - clampedBandTop - bandHeight + insets.bottom,
            paddingHorizontal: 22,
          }}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.presenterText, { fontSize: FONT_SIZES[fontIndex], lineHeight }]}>
            {body}
          </Text>
        </ScrollView>

        {/* Font size controls */}
        <View style={[styles.presenterToolbar, { bottom: insets.bottom + 8 }]}>
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={() => setFontIndex(i => Math.max(0, i - 1))}
            disabled={fontIndex === 0}
          >
            <Text style={[styles.toolbarBtnText, fontIndex === 0 && styles.toolbarBtnDisabled]}>A−</Text>
          </TouchableOpacity>
          <Text style={styles.toolbarLabel}>{FONT_SIZES[fontIndex]}px</Text>
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={() => setFontIndex(i => Math.min(FONT_SIZES.length - 1, i + 1))}
            disabled={fontIndex === FONT_SIZES.length - 1}
          >
            <Text style={[styles.toolbarBtnText, fontIndex === FONT_SIZES.length - 1 && styles.toolbarBtnDisabled]}>A+</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── EDIT MODE ──
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      <ScrollView
        style={styles.editScroll}
        contentContainerStyle={[styles.editContent, { paddingBottom: insets.bottom + 80 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title */}
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor="#334155"
          returnKeyType="next"
          multiline={false}
        />
        <View style={styles.divider} />
        {/* Body */}
        <TextInput
          style={[styles.bodyInput, { fontSize: FONT_SIZES[2], lineHeight: FONT_SIZES[2] * 1.55 }]}
          value={body}
          onChangeText={setBody}
          placeholder="Start typing your speech or notes here…"
          placeholderTextColor="#334155"
          multiline
          textAlignVertical="top"
          scrollEnabled={false}
        />
      </ScrollView>

      {/* Bottom toolbar */}
      <View style={[styles.editToolbar, { paddingBottom: insets.bottom + 4 }]}>
        <ImportButton onImport={handleImport} />
        <TouchableOpacity style={styles.presentBtn} onPress={() => setPresenting(true)}>
          <Text style={styles.presentBtnText}>▶ Present</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  notFound: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  notFoundText: { color: '#64748b', fontSize: 16 },

  // Edit mode
  editScroll: { flex: 1 },
  editContent: { paddingHorizontal: 18, paddingTop: 16 },
  titleInput: {
    fontSize: 22, fontWeight: '800', color: '#f8fafc',
    paddingVertical: 8, paddingHorizontal: 0,
  },
  divider: { height: 1, backgroundColor: '#1e293b', marginBottom: 14 },
  bodyInput: {
    color: '#e2e8f0', lineHeight: 40,
    minHeight: 400,
  },
  editToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    backgroundColor: '#0f172a',
  },
  presentBtn: {
    backgroundColor: '#15803d',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  presentBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // Present mode
  presenterContainer: { flex: 1, backgroundColor: '#0f172a' },
  presenterScroll: { flex: 1 },
  presenterText: { color: '#f8fafc', fontWeight: '450' },

  band: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    backgroundColor: 'rgba(21,128,61,0.15)',
    borderTopWidth: 1.5,
    borderBottomWidth: 1.5,
    borderColor: 'rgba(21,128,61,0.75)',
  },
  fadeTop: {
    position: 'absolute', left: 0, right: 0, zIndex: 9,
    // gradient via background on a view — approximated with opacity
    backgroundColor: 'rgba(15,23,42,0.6)',
  },
  fadeBottom: {
    position: 'absolute', left: 0, right: 0, zIndex: 9,
    backgroundColor: 'rgba(15,23,42,0.6)',
  },

  presenterToolbar: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 8,
  },
  toolbarBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 10,
  },
  toolbarBtnText: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  toolbarBtnDisabled: { color: '#334155' },
  toolbarLabel: { color: '#64748b', fontSize: 14, minWidth: 48, textAlign: 'center' },
});
