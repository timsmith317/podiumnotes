// File: pendingShare.js → ~/Projects/podiumnotes/lib/pendingShare.js
//
// A one-slot handoff between +native-intent.js and the React tree, for share
// payloads that arrive before anything is listening.
//
// WHAT THIS IS NOT
//
// This did not fix the cold-start share bug, although it was written for it.
// Sharing from Apple Notes with the app not running produced no note, and the
// cause was in plugins/withUISceneLifecycle.js: under the iOS 27 UIScene
// lifecycle, scene(_:willConnectTo:) left the launch URL in launchOptions and
// never forwarded it through AppDelegate, so nothing downstream — this module
// included — was ever handed a path to park. That plugin forwards it now, and
// that is the fix. Read it first if sharing breaks again.
//
// WHY IT STAYS ANYWAY
//
// The race it guards is real, even though it was not the fault.
// getShareIntent() delivers by EMITTING an event. On a warm launch the hook is
// mounted and subscribed, so it catches it. On a cold launch
// redirectSystemPath runs during router initialisation, which can precede
// ShareIntentProvider mounting and registering its "onChange" listener, and an
// event fired before then goes nowhere. So the path is parked here and the
// layout drains it once the hook reports isReady.
//
// `ready` keeps the two cases mutually exclusive: before the listener exists we
// park, after it exists we deliver directly. Exactly one delivery either way,
// which matters because delivering the same payload twice imports the note
// twice.
//
// One piece of context worth keeping: expo-share-intent's useShareIntent hook
// would normally notice the URL itself via useLinkingURL(), but under
// expo-router 57 our redirectSystemPath rewrites what Linking reports, so the
// hook never sees it. That is why +native-intent.js calls getShareIntent()
// directly at all.

let ready = false;
let pending = null;

/** The share listener is mounted; deliver directly from here on. */
export function markShareReady() {
  ready = true;
}

export function isShareReady() {
  return ready;
}

/** Park a share path that arrived before anything could receive it. */
export function setPendingSharePath(path) {
  pending = path;
}

/** Take the parked path, if any, and clear the slot. */
export function takePendingSharePath() {
  const p = pending;
  pending = null;
  return p;
}
