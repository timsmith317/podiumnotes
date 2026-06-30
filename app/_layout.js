// app/_layout.js
import 'react-native-gesture-handler';
import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ShareIntentProvider, useShareIntent } from 'expo-share-intent';
import { useColorScheme } from 'react-native';
import { useSettings, themeColors } from '../lib/useSettings';
import { useNotes } from '../lib/useNotes';

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
    const text = shareIntent?.text || shareIntent?.webUrl || '';
    if (text) {
      // First non-empty line becomes the title, full text the body
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      const title = (lines[0] || 'Shared Note').slice(0, 60);
      const newId = createNote({ title, body: text });
      // Open the new note. Delay lets any share-URL redirect settle first
      // so this push lands cleanly on top.
      if (typeof newId === 'string') {
        setTimeout(() => router.push(`/${newId}`), 350);
      }
    }
    resetShareIntent();
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