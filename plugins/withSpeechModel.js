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
  'echo "Copied speech model into $DEST"',
].join('\n');

module.exports = function withSpeechModel(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.getFirstTarget().uuid;

    // Idempotent: prebuild regenerates the project, but a plain re-run of
    // the plugin chain must not stack duplicate phases.
    const phases = project.hash.project.objects.PBXShellScriptBuildPhase || {};
    const exists = Object.keys(phases).some(
      (key) => typeof phases[key] === 'object' && phases[key].name === `"${PHASE_NAME}"`
    );
    if (exists) return cfg;

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
