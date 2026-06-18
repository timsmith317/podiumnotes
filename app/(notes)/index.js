import { View, Text, FlatList, TouchableOpacity, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNotes } from '../../lib/useNotes';
import { formatDate } from '../../lib/utils';

export default function NotesListScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { notes, createNote, deleteNote } = useNotes();

  function handleNew() {
    const id = createNote();
    router.push(`/${id}`);
  }

  function handleOpen(id) {
    router.push(`/${id}`);
  }

  function renderNote({ item }) {
    const preview = item.body.trim().slice(0, 80) || 'Empty note';
    return (
      <TouchableOpacity style={styles.row} onPress={() => handleOpen(item.id)} activeOpacity={0.7}>
        <View style={styles.rowInner}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title || 'Untitled'}
          </Text>
          <Text style={styles.rowMeta}>
            {formatDate(item.updatedAt)} · {item.body.length > 0 ? `${item.body.split(/\s+/).filter(Boolean).length} words` : 'Empty'}
          </Text>
          <Text style={styles.rowPreview} numberOfLines={2}>{preview}</Text>
        </View>
        <Text style={styles.rowChevron}>›</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <FlatList
        data={notes}
        keyExtractor={item => item.id}
        renderItem={renderNote}
        contentContainerStyle={notes.length === 0 ? styles.emptyContainer : styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No notes yet</Text>
            <Text style={styles.emptyBody}>Tap + to create your first speech or presentation.</Text>
          </View>
        }
      />
      {/* FAB */}
      <TouchableOpacity style={[styles.fab, { bottom: insets.bottom + 24 }]} onPress={handleNew} activeOpacity={0.85}>
        <Text style={styles.fabLabel}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  listContent: { paddingTop: 8, paddingHorizontal: 0 },
  emptyContainer: { flex: 1 },
  separator: { height: 1, backgroundColor: '#1e293b', marginLeft: 16 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#0f172a',
  },
  rowInner: { flex: 1 },
  rowTitle: { fontSize: 17, fontWeight: '700', color: '#f8fafc', marginBottom: 3 },
  rowMeta: { fontSize: 12, color: '#475569', marginBottom: 4 },
  rowPreview: { fontSize: 14, color: '#64748b', lineHeight: 20 },
  rowChevron: { fontSize: 22, color: '#334155', marginLeft: 8 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#f8fafc', marginBottom: 10 },
  emptyBody: { fontSize: 15, color: '#475569', textAlign: 'center', lineHeight: 22 },

  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#15803d',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#15803d',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  fabLabel: { fontSize: 30, color: '#fff', lineHeight: 34, marginTop: -2 },
});
