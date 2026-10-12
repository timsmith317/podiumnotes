// File: +native-intent.js → ~/Projects/podiumnotes/app/+native-intent.js
import { getShareExtensionKey, ShareIntentModule } from 'expo-share-intent';
import { isShareReady, setPendingSharePath } from '../lib/pendingShare';

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
      // Calling the module here does what the hook would have done — BUT
      // ONLY ONCE SOMETHING IS LISTENING. getShareIntent delivers by
      // emitting an event, and on a cold launch this function runs during
      // router initialisation, before ShareIntentProvider has mounted and
      // subscribed. That is the real-world case: sharing from Notes opens
      // an app that was not running. The event fired into nothing, the app
      // opened, and the note never appeared — while every warm test passed,
      // because a warm app already has its listener.
      //
      // So: park the path when nothing is listening yet and let the layout
      // drain it on mount; deliver directly when the listener exists.
      try {
        if (isShareReady()) {
          ShareIntentModule?.getShareIntent(path);
        } else {
          setPendingSharePath(path);
        }
      } catch (e) {
        console.warn('[native-intent] share handoff failed:', e?.message || e);
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
