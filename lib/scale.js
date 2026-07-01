// lib/scale.js
//
// iPad scale knobs. Phone is always 1x — these only affect iPad.
//
// Four helpers, four knobs. If something feels off on iPad, find which
// helper it uses (search for ui(, uit(, uic(, or uis( in the file that
// draws it) and tune the matching knob below. Lower = smaller on iPad.
//
//   ui()  → TABLET_UI_SCALE
//     Chrome only. Bar heights, hamburger dimensions, menu row heights,
//     paddings and margins, icon sizes, HUD pill/track/mic dimensions.
//
//   uit() → TABLET_TEXT_SCALE
//     Typography — separated from ui() so text can be tuned for reading
//     without changing chrome geometry. Note-list title/meta/preview,
//     "Podium Notes" brand text. (Editor/settings text stay on their
//     own helpers for now — extend uit() there when needed.)
//
//   uic() → TABLET_CONTROL_SCALE
//     Only the green app-icon tile in the list header.
//
//   uis() → TABLET_SETTINGS_SCALE
//     Only the Settings screen — header, segmented controls, WPM stepper,
//     color swatches, spacing inside settings.
//
// Tune the four numbers below and rebuild.
import { Platform, Dimensions } from 'react-native';

export const TABLET_UI_SCALE       = 1.4;   // Chrome: bar heights, hamburger, menu, HUD, paddings
export const TABLET_TEXT_SCALE     = 1.55;  // Typography — see uit() for scope
export const TABLET_CONTROL_SCALE  = 1.2;   // Green app-icon tile in the list header
export const TABLET_SETTINGS_SCALE = 1.4;  // Settings screen

const { width, height } = Dimensions.get('window');

// Platform.isPad catches the iPad mini (744pt wide), which a width threshold misses.
export const IS_TABLET =
  Platform.OS === 'ios' ? Platform.isPad : Math.min(width, height) >= 740;

export function ui(n)  { return IS_TABLET ? Math.round(n * TABLET_UI_SCALE)       : n; }
export function uit(n) { return IS_TABLET ? Math.round(n * TABLET_TEXT_SCALE)     : n; }
export function uic(n) { return IS_TABLET ? Math.round(n * TABLET_CONTROL_SCALE)  : n; }
export function uis(n) { return IS_TABLET ? Math.round(n * TABLET_SETTINGS_SCALE) : n; }