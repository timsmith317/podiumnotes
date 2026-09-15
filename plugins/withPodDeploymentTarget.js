// File: withPodDeploymentTarget.js → ~/Projects/podiumnotes/plugins/withPodDeploymentTarget.js
//
// Raises IPHONEOS_DEPLOYMENT_TARGET on EVERY target in the Pods project.
//
// expo-build-properties already sets ios.deploymentTarget, and that covers
// the pods themselves — but not the RESOURCE BUNDLE targets CocoaPods
// generates alongside them. RNCAsyncStorage-RNCAsyncStorage_resources stayed
// at 13.4, and "Mac (Designed for iPad)" requires 14.0 or higher, so the Mac
// build failed while iPhone and iPad builds were unaffected (13.4 is valid
// there).
//
// This appends a loop to the Podfile's post_install hook, which runs after
// CocoaPods has generated every target. A config plugin can't edit the Pods
// project directly: it doesn't exist yet at prebuild time — `pod install`
// creates it afterwards.
//
// Keep the value in step with ios.deploymentTarget in app.json.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# podiumnotes: deployment target floor';

function snippet(target) {
  return `
    ${MARKER}
    # Covers resource bundles too, which expo-build-properties leaves alone.
    installer.pods_project.targets.each do |t|
      t.build_configurations.each do |bc|
        current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < ${target}
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'
        end
      end
    end
    installer.pods_project.build_configurations.each do |bc|
      current = bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
      if current.nil? || current.to_f < ${target}
        bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${target}'
      end
    end
`;
}

module.exports = function withPodDeploymentTarget(config, { target = '16.4' } = {}) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfile)) {
        console.warn('[withPodDeploymentTarget] no Podfile found; skipping');
        return cfg;
      }
      let contents = fs.readFileSync(podfile, 'utf8');

      // Idempotent by content, not by presence: a changed target value must
      // replace the old block rather than stack a second one.
      if (contents.includes(MARKER)) {
        // Include the leading newline the snippet added, or each prebuild
        // leaves one more blank line behind than the last.
        const start = contents.indexOf(`\n    ${MARKER}`);
        const end = contents.indexOf('\n    end\n', contents.indexOf('installer.pods_project.build_configurations', start));
        if (start !== -1 && end !== -1) {
          contents = contents.slice(0, start) + contents.slice(end + '\n    end\n'.length);
        }
      }

      const hook = 'post_install do |installer|';
      const at = contents.indexOf(hook);
      if (at === -1) {
        console.warn('[withPodDeploymentTarget] no post_install hook in Podfile; skipping');
        return cfg;
      }
      const insertAt = at + hook.length;
      contents = contents.slice(0, insertAt) + snippet(target) + contents.slice(insertAt);

      fs.writeFileSync(podfile, contents);
      return cfg;
    },
  ]);
};
