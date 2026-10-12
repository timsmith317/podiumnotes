// File: pendingShare.js → ~/Projects/podiumnotes/lib/pendingShare.js
//
// A one-slot handoff between +native-intent.js and the React tree, for share
// payloads that arrive before anything is listening.
//
// THE PROBLEM THIS SOLVES
//
// The share extension writes its payload to the App Group and reopens the app
// on its URL scheme. expo-share-intent's useShareIntent hook normally notices
// that URL via useLinkingURL() and calls getShareIntent() itself — but under
// expo-router 57 our redirectSystemPath rewrites what Linking reports, so the
// hook never sees it. +native-intent.js therefore calls getShareIntent()
// directly.
//
// getShareIntent() delivers by EMITTING an event. On a warm launch the hook is
// already mounted and subscribed, so it catches it. On a COLD launch —
// which is what actually happens when someone shares from Notes, because the
// app is not running — redirectSystemPath runs during router initialisation,
// before ShareIntentProvider has mounted and registered its "onChange"
// listener. The event fires into nothing, the app opens, and no note appears.
//
// So the path is parked here instead, and the layout drains it once the hook
// reports isReady. `ready` makes the two cases mutually exclusive: before the
// listener exists we park, after it exists we deliver directly. Exactly one
// delivery either way, which matters because a second delivery of the same
// payload would import the note twice.

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
