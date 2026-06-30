// app.config.js — dynamic config layered on top of app.json.
//
// Mirrors the three-variant setup from The Filter List / Hanger so dev,
// preview, and production each get their own bundle ID, display name, and
// icon, and can coexist on one device. The variant is chosen by APP_VARIANT:
//
//   APP_VARIANT=development → "Dev · Podium Notes",     bundle ...app.dev,     amber icon
//   APP_VARIANT=preview     → "Preview · Podium Notes", bundle ...app.preview, production icon
//   (unset)                 → app.json name,            bundle ...app,         green icon
//
// app.json stays the single source of truth — Expo passes it in as `config`,
// so spreading it preserves plugins, infoPlist, share-intent, EAS projectId,
// scheme, etc. The variant marker is front-loaded in the name so it survives
// home-screen truncation. The expo-share-intent plugin derives the share
// extension bundle ID + App Group from the (suffixed) main bundle ID at
// prebuild time, so the share flow stays self-consistent per variant.
//
// IMPORTANT (local builds): there is one ios/ folder, so switching variants
// requires a clean prebuild each time, e.g.:
//   Preview:  APP_VARIANT=preview     npx expo prebuild --clean -p ios && APP_VARIANT=preview     npx expo run:ios --configuration Release --device
//   Dev:      APP_VARIANT=development npx expo prebuild --clean -p ios && APP_VARIANT=development npx expo run:ios --device
export default ({ config }) => {
const variant = process.env.APP_VARIANT;
const baseId = config.ios?.bundleIdentifier;
const basePkg = config.android?.package;
const variants = {
development: {
suffix: '.dev',
name: `Dev · ${config.name}`,
icon: './assets/images/icon-dev.png',
    },
preview: {
suffix: '.preview',
name: `Preview · ${config.name}`,
icon: config.icon, // use the production app.json icon so Preview shows the real on-device look
    },
  };
const v = variants[variant];
if (!v) return config; // production / unset → app.json unchanged
return {
...config,
name: v.name,
icon: v.icon,
ios: {
...config.ios,
bundleIdentifier: `${baseId}${v.suffix}`,
    },
...(basePkg
? { android: { ...config.android, package: `${basePkg}${v.suffix}` } }
: {}),
  };
};