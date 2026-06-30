// lib/scale.js
//
// iPad scale knobs (phone is always 1x — these only affect iPad).
// Three factors because different element classes want different scaling:
//   - ui()  general text, list rows, spacing       (most chrome)
//   - uic() chunky graphical controls              (app icon, gear, FAB)
//   - uis() the Settings screen                    (denser than the list)
// Tune the three numbers below and rebuild.
import { Platform, Dimensions } from 'react-native';

export const TABLET_UI_SCALE       = 1.8;   // body text, list rows, general spacing
export const TABLET_CONTROL_SCALE  = 1.35;  // app icon, gear, FAB — already-chunky controls
export const TABLET_SETTINGS_SCALE = 1.45;  // Settings screen

const { width, height } = Dimensions.get('window');

// Platform.isPad catches the iPad mini (744pt wide), which a width threshold misses.
export const IS_TABLET =
  Platform.OS === 'ios' ? Platform.isPad : Math.min(width, height) >= 740;

export function ui(n)  { return IS_TABLET ? Math.round(n * TABLET_UI_SCALE)       : n; }
export function uic(n) { return IS_TABLET ? Math.round(n * TABLET_CONTROL_SCALE)  : n; }
export function uis(n) { return IS_TABLET ? Math.round(n * TABLET_SETTINGS_SCALE) : n; }