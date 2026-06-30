// components/ImportButton.js
import { TouchableOpacity, Text, StyleSheet, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

export default function ImportButton({ onImport, colors }) {
  async function handleImport() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'text/plain',
          'text/markdown',
          'application/rtf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled) return;
      const asset = result.assets[0];
      const text = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      onImport(text);
    } catch (e) {
      Alert.alert('Import failed', 'Could not read that file. Try saving as plain text or markdown first.');
    }
  }

  return (
    <TouchableOpacity
      style={[styles.btn, { borderColor: colors?.border ?? '#e2e2e8' }]}
      onPress={handleImport}
      activeOpacity={0.7}
    >
      <Text style={[styles.label, { color: colors?.textMuted ?? '#94a3b8' }]}>Import</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  label: { fontWeight: '600', fontSize: 15 },
});