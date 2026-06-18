import { TouchableOpacity, Text, StyleSheet, Alert, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

const SUPPORTED_TYPES = [
  'text/plain',
  'text/markdown',
  'application/rtf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Share sheet from Apple Notes arrives as plain text
  'public.plain-text',
];

export default function ImportButton({ onImport }) {
  async function handleImport() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/markdown', 'application/rtf',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) return;
      const asset = result.assets[0];
      const text = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      onImport(text);
    } catch (e) {
      Alert.alert('Import failed', 'Could not read that file. Try plain text or markdown.');
    }
  }

  return (
    <TouchableOpacity style={styles.btn} onPress={handleImport} activeOpacity={0.7}>
      <Text style={styles.label}>↑ Import</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  label: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
});
