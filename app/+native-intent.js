// File: +native-intent.js → ~/Projects/podiumnotes/app/+native-intent.js
import { getShareExtensionKey, ShareIntentModule } from 'expo-share-intent';

export function redirectSystemPath({ path, initial }) {
  try {
    const key = getShareExtensionKey();
    const isShare =
      path.includes('dataUrl') ||
      path.includes('ShareKey') ||
      (key && path.includes(key));

    if (isShare) {
      // DELIVER THE PAYLOAD BEFORE REDIRECTING.
      //
      // useShareIntent watches the URL that Linking reports and calls
      // getShareIntent() itself when it matches `scheme://dataUrl=`. Under
      // expo-router 56 this redirect only affected routing, so the hook
      // still saw the original URL. Under 57 the rewrite reaches Linking
      // too — so returning '/' consumed the share URL and the hook never
      // fired. The extension ran, the URL arrived, and nothing happened.
      //
      // Calling the module here does exactly what the hook would have done,
      // so the payload is delivered regardless of what the router then does
      // with the path.
      try {
        ShareIntentModule?.getShareIntent(path);
      } catch (e) {
        console.warn('[native-intent] getShareIntent failed:', e?.message || e);
      }
      // Still redirect: a `dataUrl=` path is not a route, and letting the
      // router try to navigate to it is what this file was written to stop.
      return '/';
    }
  } catch (e) {
    console.warn('[native-intent] error, redirecting to home:', e?.message || e);
    return '/';
  }
  return path;
}
