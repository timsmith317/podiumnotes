<!-- File: DEFERRED.md → ~/Projects/podiumnotes/DEFERRED.md -->

# Deferred items

Work consciously left undone, with the reason and enough context to pick it up
cold months later. Each entry says what to do and how to know it worked.

Delete an entry when it is done. This file is only worth reading if it is
accurate.

Last reviewed: 19 October 2026, before the 2.0.1 build.

---

## 1. Expo patch versions are eight behind

`npx expo-doctor` fails one check (20/21 pass). All within SDK 57:

| package | installed | expected |
|---|---|---|
| expo | 57.0.23 | ~57.0.30 |
| expo-build-properties | 57.0.20 | ~57.0.22 |
| expo-constants | 57.0.18 | ~57.0.22 |
| expo-document-picker | 57.0.2 | ~57.0.3 |
| expo-linking | 57.0.10 | ~57.0.13 |
| expo-router | 57.0.21 | ~57.0.28 |
| expo-sharing | 57.0.20 | ~57.0.23 |
| expo-splash-screen | 57.0.9 | ~57.0.10 |

**Why deferred.** 2.0.1 was verified on exactly these versions, and the most
tempting upgrade is the riskiest: expo-router owns `redirectSystemPath`, which
the cold-start share fix threads directly through. EAS installs from the
lockfile, so a build matches what was tested. App Review never sees any of this.

**To do.** `npx expo install --check`, accept, `npx expo prebuild --clean -p ios`.

**To verify.** Force-quit the app, share a note from Apple Notes on both iPhone
and iPad, and confirm the note appears. That is the path these packages can
break. Do it as its own change, not bundled with anything else.

---

## 2. `cleanupOrphanAudio` is still unwired

`lib/listen.js` exports it with a comment saying to call it opportunistically
from the notes list. Nothing calls it.

**Why it matters.** `deleteNote` in `lib/useNotes.js` now releases audio and the
saved listen position for a note deleted *on this device*. A note deleted on
another device arrives as a sync tombstone through `onRemoteChange`, never goes
through `deleteNote`, and leaves its audio behind — tens of megabytes for a long
talk.

**The hazard, and why this was not just done.** It deletes any audio file whose
note id is not in the set handed to it. `useNotes` has no hydration flag:
`_notes` is a module-level array filled asynchronously. Call it on mount before
notes have loaded and it receives an empty set and deletes everything.

**To do.** Add an explicit "notes have hydrated" signal to `useNotes` and gate
the call on that. Do **not** gate on `notes.length` — a user with zero notes is
legitimate and would be indistinguishable from a pending load.

**To verify.** With several notes present and audio rendered for more than one,
delete one note on another device, let it sync, and confirm only that note's
audio disappeared.

---

## 3. Two Swift warnings in the speech player

`modules/speech-player/ios/SpeechPlayerModule.swift:345` and `:412` — the
`onSegment` and `completion` closures passed to `synthesizeSegments`. Note the
asymmetry between them: `onSegment` unwraps `self` *outside*
`DispatchQueue.main.async`, `completion` unwraps it *inside*.

**Why deferred.** Only the line numbers were captured, not the warning text.
This is also the module with the open question in item 4, so a speculative
concurrency change here could shift playback timing in a way a field test would
not obviously reveal.

**To do.** Capture both warnings verbatim from a build log first, then fix what
they actually say.

---

## 4. Listen still stops mid-note, cause unknown

Two runs on the same twenty-minute note gave:

- a hiccup at ~0:35 on the word "inspiration", in both runs — a sentence
  boundary, so most likely the preload-to-resumed-render handoff
- "Endure" skipped at ~7:00, run 1 only
- playback stopping at ~10:00, run 1 only

Commit `1e28ae6` made stopping *survivable* — the position is kept instead of
rewinding to the top — but did not explain it.

**To do.** Reproduce and capture Console output filtered to `[SpeechPlayer]`.
The diagnostics added in `229eb10` name which of the three endings it was:
`UNDERRUN`, `FINISHED`, `swap at`, and `rejected backward tick`.

---

## 5. Mac share extension hangs on "Send a Copy"

Sharing from the Mac shows a white overlay box that never closes; the note
never arrives. iPhone and iPad are unaffected and working.

**What is established.** The extension's view controller is never created.
`awakeFromNib`, `loadView` and `viewDidLoad` all log, and none of them fire.
The host agrees from its side: `SendActions: Found no existing scene`, and `No
windows open yet` thirty times in one capture.

**Ruled out, each with evidence rather than reasoning:**

| Suspect | How it was eliminated |
|---|---|
| A crash | No report in `~/Library/Logs/DiagnosticReports`, across several runs |
| A stale build | The binary in DerivedData was checked for the log strings and carried them, built minutes before each test |
| The completion gate added 20 Sep | Gate now has a 1.5s timeout; hang is unchanged, and it hangs before the gate is reached |
| A malformed bundle | `MainInterface.storyboardc` present, `NSExtensionMainStoryboard` names it, point identifier is `com.apple.share-services` |
| Storyboard wiring | Initial view controller carries `customClass="ShareViewController"` |
| Missing scene manifest | Added one to the extension's Info.plist, verified present in the built bundle. No change. Change reverted |
| Mac not supporting this | Apple documents share extensions as supported for iPhone/iPad apps on Apple silicon |

**Two things to check before building anything else**, both free:

1. Share a note from Mac Notes to a *different* third-party app's share
   extension. If those hang too, this is the Mac or Notes, not our code, and
   everything above has been debugging the wrong process.
2. System Settings → Privacy & Security → Extensions → Sharing — confirm
   Podium Notes is enabled. The system launches the extension, so it should
   be, but it costs nothing.

**The next build-based test.** Only two possibilities remain: our code never
runs, or it runs and its `NSLog` output never reaches the unified log. Those
look identical from outside. Distinguish them by writing a marker *file* from
`awakeFromNib` instead of logging — if the file appears, the instrument is at
fault and not the code.

**Why deferred.** iPhone and iPad are the priority and work. This has consumed
several build cycles and is a platform question rather than an app one.

---

## 6. `[scene]` NSLogs are still in

Four of them in `plugins/withUISceneLifecycle.js`, two firing on every launch.

Kept deliberately: they are the only visibility into URL delivery under the
UIScene lifecycle, which has no JS-side signal at all, and item 5 is still open.
Remove them once the Mac case is closed.

---

## 7. Xcode is pinned to 27.0 for local builds

Xcode 27.1 ships Swift 6.4. Expo 57 ships `ExpoModulesCore` and
`ExpoModulesJSI` as XCFrameworks built with Swift 6.3.1, so 27.1 cannot build
this project locally.

Setting `usePrecompiledModules: false` does **not** solve it: it gets
`ExpoModulesCore` compiling from source, but `ExpoModulesJSI` is built by its
own script phase regardless, and the module interface Swift 6.4 generates for it
fails to parse under Swift 6.4 (`cannot find type '__ObjC::expo' in scope`).

**Current state.** Both versions installed; `xcode-select` points at
`/Applications/Xcode-27.0.app/Contents/Developer`. EAS builds are unaffected
either way, since they run Expo's own image.

**Revisit** when Expo ships prebuilts built with Swift 6.4. Then point
`xcode-select` back at `/Applications/Xcode.app` and delete 27.0.

---

## 8. Git LFS hooks, local only

`.git/hooks` contains `post-checkout`, `post-commit`, `post-merge` and
`pre-push` from Git LFS, but there is no `.gitattributes`, so nothing is
LFS-tracked. On a machine without `git-lfs` installed they print a warning on
every commit.

`.git/hooks` is not version controlled, so this is per-machine and there is
nothing to commit: delete those four files to silence it.
