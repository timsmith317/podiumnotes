// File: withSpeechModel.js → ~/Projects/podiumnotes/plugins/withSpeechModel.js
//
// Copies the Supertonic model into the built .app at compile time.
//
// ── Why a build phase rather than Xcode folder references ──
//
// The obvious approach is to add `onnx/` and `voice_styles/` to the Xcode
// project as folder references so they land in Copy Bundle Resources. That
// works, but it means generating pbxproj entries that have to survive every
// `expo prebuild`, and a malformed reference fails in ways that are hard to
// read. A single shell build phase copying straight into
// $BUILT_PRODUCTS_DIR is far easier to reason about, survives regeneration
// the same way, and — because it reads from the project root — avoids
// duplicating ~400MB into ios/ as well.
//
// ── Why the model isn't in git ──
//
// It's ~400MB of ONNX weights that never change. Committing it would bloat
// every clone forever. It lives at assets/model/ (gitignored) and reaches
// EAS through a .easignore negation, since EAS excludes files by gitignore
// rules rather than by whether they're committed.
//
// The build FAILS LOUDLY when the model is missing. A silent skip would
// produce an app that installs cleanly and then has no voice — the worst
// possible failure for something this large and this central.

const { withXcodeProject } = require('@expo/config-plugins');

const PHASE_NAME = 'Copy speech model';

// CarPlay, the lock screen and Control Centre reserve space for artwork and
// draw an empty placeholder without it. The icon rides along in this phase
// because it has the same requirement — a plain file in the bundle that
// native code can open by name, which the asset catalogue does not provide.
// A dedicated file when one exists, the app icon otherwise. They want
// different compositions: the icon is a bare mark, while artwork on a car
// screen sits among other apps' covers and has to say which app it is.
const ARTWORK_SRC = '$SRCROOT/../assets/images/now-playing-artwork.png';
const ARTWORK_FALLBACK = '$SRCROOT/../assets/images/icon.png';
const ARTWORK_DEST = 'now-playing-artwork.png';

// Relative to ios/ (Xcode's $SRCROOT for the app target).
const MODEL_SRC = '$SRCROOT/../assets/model';

const SCRIPT = [
  'set -e',
  `SRC="${MODEL_SRC}"`,
  'DEST="$BUILT_PRODUCTS_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"',
  '',
  'if [ ! -d "$SRC/onnx" ] || [ ! -f "$SRC/onnx/tts.json" ]; then',
  '  echo "error: Speech model not found at $SRC/onnx"',
  '  echo "note: Download it with:"',
  '  echo "note:   git clone https://huggingface.co/Supertone/supertonic-3 assets/model"',
  '  echo "note: The model is deliberately not in git (~400MB); see plugins/withSpeechModel.js"',
  '  exit 1',
  'fi',
  '',
  'mkdir -p "$DEST"',
  '# --delete so a removed or renamed model file does not linger in the app',
  '# from a previous build.',
  'rsync -a --delete "$SRC/onnx" "$DEST/"',
  'rsync -a --delete "$SRC/voice_styles" "$DEST/"',
  '# Same reason as the artwork below: rsync -a preserves extended',
  '# attributes, and signing refuses a bundle that contains them.',
  'xattr -cr "$DEST/onnx" "$DEST/voice_styles" 2>/dev/null || true',
  'echo "Copied speech model into $DEST"',
  '',
  `ART=""`,
  `if [ -f "${ARTWORK_SRC}" ]; then ART="${ARTWORK_SRC}"; fi`,
  `if [ -z "$ART" ] && [ -f "${ARTWORK_FALLBACK}" ]; then ART="${ARTWORK_FALLBACK}"; fi`,
  '',
  'if [ -n "$ART" ]; then',
  `  cp "$ART" "$DEST/${ARTWORK_DEST}"`,
  '  # Signing rejects a bundle containing extended attributes; cp keeps',
  '  # them, and anything touched by Finder or a download has them.',
`  xattr -c "$DEST/${ARTWORK_DEST}" 2>/dev/null || true`,
  `  echo "Copied Now Playing artwork from $ART"`,
  'else',
  `  echo "warning: no artwork found; Now Playing will show an empty placeholder"`,
  'fi',
].join('\n');

module.exports = function withSpeechModel(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.getFirstTarget().uuid;

    // REPLACE a phase we already own rather than skipping it.
    //
    // Skipping on a name match seemed like the safe idempotent choice, but a
    // plain `expo prebuild` reuses ios/ — so once the phase existed, every
    // later edit to this script was silently ignored and the project kept
    // running the original version. That is a bad failure: the build
    // succeeds, and what changed simply doesn't happen.
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase || {};
    for (const key of Object.keys(phases)) {
      const phase = phases[key];
      if (typeof phase === 'object' && phase.name === `"${PHASE_NAME}"`) {
        delete project.hash.project.objects.PBXShellScriptBuildPhase[key];
        delete project.hash.project.objects.PBXShellScriptBuildPhase[`${key}_comment`];
        // Drop the reference from every target that listed it, or the
        // project keeps a dangling id.
        const targets = project.hash.project.objects.PBXNativeTarget || {};
        for (const tKey of Object.keys(targets)) {
          const t = targets[tKey];
          if (typeof t === 'object' && Array.isArray(t.buildPhases)) {
            t.buildPhases = t.buildPhases.filter((bp) => bp.value !== key);
          }
        }
      }
    }

    project.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      PHASE_NAME,
      target,
      {
        shellPath: '/bin/sh',
        shellScript: SCRIPT,
      }
    );

    // No inputs or outputs declared, so Xcode runs it every build. rsync is
    // nearly free when nothing changed, and the alternative — Xcode deciding
    // it can skip — would silently ship an app with a stale or absent model.
    const added = project.hash.project.objects.PBXShellScriptBuildPhase;
    for (const key of Object.keys(added)) {
      const phase = added[key];
      if (typeof phase === 'object' && phase.name === `"${PHASE_NAME}"`) {
        phase.alwaysOutOfDate = 1;
      }
    }

    return cfg;
  });
};
