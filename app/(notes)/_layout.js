import { Stack } from 'expo-router';

export default function NotesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: '800' },
        contentStyle: { backgroundColor: '#0f172a' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Podium Notes' }} />
      <Stack.Screen name="[id]" options={{ title: '', headerBackTitle: 'Notes' }} />
    </Stack>
  );
}
