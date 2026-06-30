// app/+native-intent.js
import { getShareExtensionKey } from 'expo-share-intent';

export function redirectSystemPath({ path, initial }) {
  try {
    console.log('[native-intent] incoming path:', path);
    const key = getShareExtensionKey();
    if (
      path.includes('dataUrl') ||
      path.includes('ShareKey') ||
      (key && path.includes(key))
    ) {
      console.log('[native-intent] share link → redirecting to home');
      return '/';
    }
  } catch (e) {
    console.log('[native-intent] error, redirecting to home:', e);
    return '/';
  }
  return path;
}
