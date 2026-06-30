// app/(notes)/_layout.js
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';
import { useSettings, themeColors } from '../../lib/useSettings';

export default function NotesLayout() {
  const { settings } = useSettings();
  const colorScheme = useColorScheme();
  const colors = themeColors(settings.themeMode, colorScheme);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.headerBg },
        headerTintColor: colors.headerText,
        headerTitleStyle: { fontWeight: '800' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
    </Stack>
  );
}