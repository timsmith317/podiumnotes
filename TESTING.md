<!-- File: TESTING.md → ~/Projects/podiumnotes/TESTING.md -->

# Testing a build

A regression checklist, written from bugs that actually shipped rather than
from a template. The top section changes each release; everything below it is
the standing sweep.

Every item says what failure looked like, because a test you cannot fail is not
a test.

---

## Before you start

- **Install over the top, don't delete first.** Every real user upgrades in
  place, and an upgrade exercises migration that a clean install never touches.
  Do a clean install afterwards if you want both.
- **TestFlight uses the production CloudKit environment**, so your real notes
  are here — the same records the App Store build uses.
- **One warning that is new in 2.0.1:** deleting a note now also deletes its
  rendered audio, and the delete still syncs to your other devices. Use a
  throwaway note for anything in the delete tests. This is not reversible.
- Know which build you are on: Settings → the version line should read
  **2.0.1 (13)**.

---

## This release: the six fixes

### 1. Share from a cold start

The one that matters most. In 2.0.0 the note arrived only if the app was
already running in the background; from a cold start the app opened to nothing.

1. Force-quit Podium Notes (swipe it away from the app switcher).
2. Open Apple Notes, pick any note, Share → Podium Notes.
3. The app launches and the note is there.
4. Delete it, force-quit again, repeat.

Run it **four times on the iPhone and four on the iPad**. It failed
intermittently before, so one pass proves nothing. Also try it from Mail and
Pages at least once each — different source apps hand over the text
differently.

**The Mac is known broken** — "Send a Copy" shows a white overlay and hangs.
Not fixed in this release. Don't spend time on it.

### 2. Voice follow through a long talk

In 2.0.0 it tracked for eight or nine minutes of a twenty-minute message, then
stopped silently and stayed stopped.

1. Open a long note, tap the microphone, and read aloud.
2. Get past the ten-minute mark. Reading at normal pace is the test; skimming
   is not.
3. Watch for the text continuing to follow you.

If it does stop, note roughly when, and **whether the microphone button turns
red**. Red means it detected the failure and gave up; still-grey means
something else went wrong and the watchdog did not catch it. The two point at
different code.

### 3. Listening keeps its place when it stops

In 2.0.0, playback ending early rewound to the opening of the note.

1. Start Listen on a long note, let it run a few minutes.
2. Stop it however you like — pause, lock the screen, leave the app.
3. Come back. It resumes where it stopped, not at the top.
4. Also confirm **Go To Top still works**, since that is now the only way back
   to the beginning.

### 4. No jumping backwards

In 2.0.0 the text occasionally jumped back and repeated a passage, roughly
every couple of minutes.

Listen to a long note for ten minutes or more and watch for repeats. This is
passive — there is nothing to do but notice.

### 5. The car

In 2.0.0 an interruption killed playback outright, and the car's controls moved
to the wrong point in the text.

1. Start Listen, connect to CarPlay or Bluetooth.
2. Trigger an interruption — take a call, or let a navigation prompt fire.
3. Playback resumes after it.
4. Use the car's own skip-forward and scrubbing. The text should land where the
   audio is, not offset from it.

### 6. Edit mode

Several rounds of fixes went into this. The failure was: collapse the keyboard,
touch to scroll, and the note snapped back to wherever you last typed.

1. Open a note, enter edit mode, change something near the end.
2. Collapse the keyboard.
3. Scroll freely with a finger. The page must not jump.
4. Tap a word somewhere else. The cursor lands **on that word**, first tap —
   not at the start of the line, and not requiring a second tap.
5. Repeat with the keyboard left up, which always worked and must still.

### 7. Deleting a note releases its audio

New in 2.0.1. Use a throwaway note.

1. Settings → note the audio cache size.
2. Create a note, play it in Listen long enough to render a chunk.
3. Settings → the cache has grown.
4. Delete the note. Settings → the cache has dropped back.

---

## Standing sweep

Quick passes on things that were not touched but share code with what was.

- **Import** — a .txt and a .pdf through the document picker.
- **Sync** — edit a note on one device, confirm it arrives on the other.
- **Presenter view** — the highlight band tracks, band size setting applies,
  pace and running time look right.
- **Themes** — light and dark, including the progress bar in dark mode.
- **Listen from a scrub** — drag the progress bar to the middle of a long note
  and confirm playback starts from that point in the text rather than waiting
  for a full render.
- **Lock screen controls** — play, pause, skip, and the artwork showing.

---

## Still open: why Listen stops mid-note

Not fixed in 2.0.1 — only made survivable. If playback stops during testing,
this is the chance to find out why.

Connect the device to the Mac, open **Console.app**, select the device, and
filter on `[SpeechPlayer]`. The messages that name the cause:

| message | meaning |
|---|---|
| `UNDERRUN` | playback outran the renderer |
| `FINISHED` | the composition genuinely ended |
| `swap at` | an item swap, with its timing |
| `rejected backward tick` | a progress report that went backwards |

Capture the lines around the stop, not just the stop itself.
