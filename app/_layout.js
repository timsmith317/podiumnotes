// File: app/_layout.js → ~/Projects/podiumnotes/app/_layout.js
import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ShareIntentProvider, useShareIntent } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useSettings, themeColors } from '../lib/useSettings';
import { useNotes } from '../lib/useNotes';
import { readDocumentAsText } from '../lib/importers';
import { prepareHeadStart } from '../lib/listen';

function RootNav() {
  const router = useRouter();
  const { settings } = useSettings();
  const { createNote } = useNotes();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);

  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({
    debug: false,
    resetOnBackground: true,
  });

  useEffect(() => {
    if (!hasShareIntent) return;
    (async () => {
      try {
        const text = shareIntent?.text || shareIntent?.webUrl || '';
        const files = shareIntent?.files || [];

        if (text) {
          // ── Shared text (Apple Notes, Simplenote, Keep, ...) ──
          // The first non-empty line becomes the title. When that line fits
          // the title field in full, STRIP it from the body — the title strip
          // at the top of the screen already shows it, and leaving it
          // duplicated meant hand-editing every imported note. If the line is
          // longer than the title field (title would be a truncation), keep
          // the body whole so no text is ever lost.
          const rawLines = text.split('\n');
          const firstIdx = rawLines.findIndex(l => l.trim().length > 0);
          const firstLine = firstIdx === -1 ? '' : rawLines[firstIdx].trim();
          const title = (firstLine || 'Shared Note').slice(0, 60);
          let bodyText = text;
          if (firstLine && firstLine.length <= 60) {
            const rest = rawLines.slice(firstIdx + 1);
            // Also drop blank lines directly after the title so the body
            // starts at the real content.
            while (rest.length && rest[0].trim() === '') rest.shift();
            bodyText = rest.join('\n');
          }
          const newId = createNote({ title, body: bodyText });
          // Open the new note. Delay lets any share-URL redirect settle first
          // so this push lands cleanly on top.
          if (typeof newId === 'string') {
            setTimeout(() => router.push(`/${newId}`), 350);
            // Render the opening while the reader is still looking at the
            // note for the first time. The share sheet is how most notes
            // arrive, and they land straight in the presenter without
            // passing through edit mode — so without this they would always
            // pay the full cold-start wait on first listen.
            prepareHeadStart({ id: newId, title, body: bodyText }).catch(() => {});
          }
        } else if (files.length) {
          // ── Shared file (Files app → Share → Podium Notes) ──
          // Enabled by the widened share-extension activation rules; without
          // this branch, file shares arrived here and were silently dropped.
          const f = files[0];
          const name = f.fileName || (f.path || '').split('/').pop() || 'Imported';
          const isPdf = (f.mimeType && f.mimeType.includes('pdf')) || /\.pdf$/i.test(name);
          if (isPdf) {
            // Same persist-and-present flow as the in-app PDF import.
            const dir = FileSystem.documentDirectory + 'pdfs/';
            try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch (e) {}
            const dest = dir + 'pdf-' + Date.now() + '.pdf';
            await FileSystem.copyAsync({ from: f.path, to: dest });
            const pdfTitle = name.replace(/\.pdf$/i, '');
            const newId = createNote({ kind: 'pdf', title: pdfTitle, fileUri: dest });
            setTimeout(() => router.push({ pathname: '/pdf-present', params: { uri: dest, name: pdfTitle, id: newId } }), 350);
          } else {
            // txt / md / rtf / docx — the shared format-aware reader.
            const bodyText = await readDocumentAsText({ uri: f.path, name, mimeType: f.mimeType });
            const title = name.replace(/\.\w+$/i, '').slice(0, 60);
            const newId = createNote({ title, body: bodyText });
            if (typeof newId === 'string') {
              setTimeout(() => router.push(`/${newId}`), 350);
              prepareHeadStart({ id: newId, title, body: bodyText }).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.warn('Share import failed:', e);
      } finally {
        resetShareIntent();
      }
    })();
  }, [hasShareIntent]);

  const isDark = settings.themeMode === 'dark' ||
    (settings.themeMode === 'system' && colorScheme === 'dark');

  return (
    <SafeAreaProvider>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.headerBg },
          headerTintColor: colors.headerText,
          headerTitleStyle: { fontWeight: '800' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(notes)" options={{ headerShown: false }} />
        <Stack.Screen
          name="settings/index"
          options={{
            presentation: 'modal',
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="pdf-present"
          options={{ headerShown: false }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ShareIntentProvider>
        <RootNav />
      </ShareIntentProvider>
    </GestureHandlerRootView>
  );
}
