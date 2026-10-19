<!-- File: appstore-2.0.1.md → ~/Projects/podiumnotes/store/appstore-2.0.1.md -->

# Podium Notes 2.0.1 — App Store submission copy

A patch release. No new features: six fixes to things 2.0 got wrong once it
met a real twenty-minute talk in a real car on a real podium.

Everything Apple indexes — app name, subtitle, keywords — is unchanged from
2.0.0. Discovery is untouched, so nothing on that front needs re-testing and
the "search Podium Notes" handle still holds.

---

## Version number

`2.0.1`

The build number is assigned by EAS, not by this file: `appVersionSource` is
`remote` and the production profile has `autoIncrement`, so this lands as
build 13 after 2.0.0's 12.

---

## What's New (4000)

```
2.0.1 fixes six problems found in real use since 2.0.

• Sharing from Notes, Mail or Pages now works when Podium Notes is not
  already running. The note arrived only if the app happened to be open in
  the background; from a cold start the app opened to nothing.

• Voice follow keeps tracking for the length of a talk. It followed well
  for eight or nine minutes of a longer message and then stopped, and
  stayed stopped.

• Listening no longer loses your place. When playback stopped it returned
  to the beginning of the note, which on a twenty-minute talk meant
  scrolling and hunting for a half-remembered sentence. It now stays where
  it stopped, and Go To Top is there when you do want the beginning.

• Listening no longer jumps backwards and repeats a passage you have
  already heard.

• Playback recovers after an interruption in the car, and the car's own
  controls now move to the matching point in your text rather than an
  offset one.

• Edit mode behaves again: collapse the keyboard and the page scrolls
  freely, and a single tap puts the cursor where you touched instead of
  throwing the note back to wherever you last typed.
```

---

## Unchanged from 2.0.0 — do not edit

These are live and indexed. Changing any of them resets discovery for no
reason on a bug-fix release.

- **App name** — `Podium Notes`
- **Subtitle** — as shipped in 2.0.0
- **Keywords** — as shipped in 2.0.0
- **Description** — no feature changes, so nothing to describe differently
- **Screenshots** — the UI is unchanged; the 2.0.0 set still represents the app
- **Age rating, export compliance, App Privacy** — nothing in 2.0.1 touches
  data collection, encryption or permissions

## Promotional text (170)

Editable without review, and independent of the version. The 2.0.0 text still
reads correctly; replace it only if there is something to announce.

---

## App Review notes

Carry 2.0.0's notes over unchanged — the app size, the three permissions and
the test instructions for Listen and Voice Follow all still apply. Add one
line so the reviewer knows what to look at:

```
2.0.1 is a bug-fix release. No new features, no new permissions, no change
to data handling. Fixes cover share-sheet delivery on a cold start, voice
follow continuing through a long talk, and playback keeping its position.
```

---

## What changed, by commit

For the next release's diff point.

| Commit | Fix |
|---|---|
| `4106a47`, `22a7094` | Share from another app on a cold start |
| `50d8cf9` | Voice follow stopping after eight or nine minutes |
| `229eb10` | Progress ticks walking backwards and repeating text |
| `e7ac846` | Audio session and car controls after an interruption |
| `1e28ae6` | Position kept wherever playback stopped |
| `5a3882c`, `bcb7f69`, `6da17d7`, `69977c1` | Edit mode: scroll with the keyboard down, one-tap caret |
