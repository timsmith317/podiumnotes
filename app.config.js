// File: app.config.js → ~/Projects/podiumnotes/app.config.js
//
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
// etc. The variant marker is front-loaded in the name so it survives
// home-screen truncation. The expo-share-intent plugin derives the share
// extension bundle ID + App Group from the (suffixed) main bundle ID at
// prebuild time, so the share flow stays self-consistent per variant.
//
// PER-VARIANT URL SCHEME (do not remove): the share extension delivers its
// payload by writing to the variant's App Group and then opening the main app
// via URL scheme. If all variants share the scheme "podiumnotes", iOS picks
// ONE of the installed apps to answer the redirect — often the wrong one —
// which silently breaks imports (payload sits unread in the other variant's
// App Group) and can leave the SOURCE app (Simplenote, Keep, etc.) hung
// waiting on a share that never completes. Discovered during build 5 testing
// with all three variants installed on one iPhone. Each variant therefore
// gets its own scheme: podiumnotes-dev / podiumnotes-preview / podiumnotes.
//
// PER-VARIANT ENTITLEMENTS (do not remove): app.json declares an explicit
// com.apple.security.application-groups entitlement with the PRODUCTION group
// (added so EAS capability sync stops stripping the App Group from the prod
// provisioning profile). That value is wrong for dev/preview, whose share
// extensions use the suffixed groups — so the variant block overrides it with
// the suffixed group to match what the share-intent plugin generates.
//
// NO DEV CLIENT: expo-dev-client is intentionally NOT installed or referenced.
// It auto-injects dev-only Info.plist keys (_expo._tcp Bonjour service,
// NSLocalNetworkUsageDescription about "development servers") into EVERY build
// it's present in — including production — which looks unprofessional and can
// draw App Review questions. Local development uses plain `expo start`. (This
// matches The Filter List, which also ships without dev-client.)
//
// IMPORTANT (local builds): there is one ios/ folder, so switching variants
// requires a clean prebuild each time, e.g.:
//   Preview:  APP_VARIANT=preview npx expo prebuild --clean -p ios && APP_VARIANT=preview npx expo run:ios --configuration Release --device
export default ({ config }) => {
  const variant = process.env.APP_VARIANT;
  const baseId = config.ios?.bundleIdentifier;
  const basePkg = config.android?.package;
  const baseScheme = config.scheme;

  const variants = {
    development: {
      suffix: '.dev',
      schemeSuffix: '-dev',
      name: `Dev · ${config.name}`,
      icon: './assets/images/icon-dev.png',
    },
    preview: {
      suffix: '.preview',
      schemeSuffix: '-preview',
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
    scheme: `${baseScheme}${v.schemeSuffix}`,
    ios: {
      ...config.ios,
      bundleIdentifier: `${baseId}${v.suffix}`,
      entitlements: {
        ...config.ios?.entitlements,
        'com.apple.security.application-groups': [`group.${baseId}${v.suffix}`],
      },
    },
    ...(basePkg
      ? { android: { ...config.android, package: `${basePkg}${v.suffix}` } }
      : {}),
  };
};
