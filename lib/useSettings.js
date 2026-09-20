// lib/useSettings.js
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'podiumnotes.settings.v1';

const DEFAULTS = {
  themeMode:      'system',    // 'system' | 'light' | 'dark' | 'sepia' | 'ice'
  displayFont:    'system',    // 'system' | 'serif' | 'mono'
  // 4, not 3. Three lines is a tight window for a reader glancing down
  // between sentences — enough to find your place, not enough to see where
  // the sentence is going. Changed after repeatedly setting it to 4 by hand
  // on every fresh install.
  bandLines:      4,
  bandPositionPct: 45,
  bandColor:      '#15803d',
  bandFades:      false,       // whether to dim text above/below band
  wordsPerMinute: 130,         // per-user speaking pace; drives time estimates on the list
};

let _settings = { ...DEFAULTS };
let _listeners = [];

function notify() {
  _listeners.forEach(fn => fn({ ..._settings }));
}

async function load() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) _settings = { ...DEFAULTS, ...JSON.parse(raw) };
    notify();
  } catch (e) {}
}

async function persist() {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_settings));
  } catch (e) {}
}

load();

export function useSettings() {
  const [settings, setSettings] = useState({ ..._settings });

  useEffect(() => {
    _listeners.push(setSettings);
    return () => { _listeners = _listeners.filter(fn => fn !== setSettings); };
  }, []);

  const update = useCallback((changes) => {
    _settings = { ..._settings, ...changes };
    persist();
    notify();
  }, []);

  return { settings, update };
}

export function fontFamily(displayFont) {
  switch (displayFont) {
    case 'serif': return 'Georgia';
    case 'mono':  return 'Courier New';
    default:      return undefined;
  }
}

// Sepia and Ice are explicit palettes; 'system' resolves to light/dark only.
export function themeColors(themeMode, systemColorScheme) {
  if (themeMode === 'sepia') return SEPIA;
  if (themeMode === 'ice')   return ICE;
  const dark = themeMode === 'dark' || (themeMode === 'system' && systemColorScheme === 'dark');
  return dark ? DARK : LIGHT;
}

// accent / accentBorder / accentText drive the FAB and selected segmented chips.
// Light and Dark keep the existing neutral grey so they look unchanged.

// Secondary text passes WCAG AA (4.5:1) in ALL FOUR palettes, and the three
// levels stay in order: text is strongest, then textMuted, then textFaint.
// Contrast ratios are against each palette's own bg.
//
// The previous values were badly out: dark textFaint measured 1.72:1 — not
// dim but invisible — and light textFaint 2.45:1. Fixing dark textFaint
// alone then inverted the order, leaving faint text MORE readable than
// muted, so every palette is set together here.
//
// Sepia and Ice were worse than Light: 1.87:1 and 2.07:1 for faint text.
// They keep their warm and cool casts — the hue is unchanged, only the
// value is deepened — because the palettes are meant to be gentle to read
// against, and gentle isn't the same as illegible at a podium.

const DARK = {
  bg:          '#0f172a',
  surface:     '#1e293b',
  border:      '#1e293b',
  text:        '#f8fafc',
  textMuted:   '#94a3b8',   // 6.96:1  (was #64748b, 3.75:1 — below AA)
  textFaint:   '#7c8ba3',   // 5.17:1  (was #334155, 1.72:1)
  placeholder: '#64748b',   // 3.75:1  — placeholders may sit below body text
  headerBg:    '#0f172a',
  headerText:  '#ffffff',
  toolbarBg:   '#0f172a',
  accent:       '#c8c8ce',
  accentBorder: '#a8a8b0',
  accentText:   '#1a1a1a',
};

const LIGHT = {
  bg:          '#f8fafc',
  surface:     '#ffffff',
  border:      '#e2e8f0',
  text:        '#0f172a',
  textMuted:   '#556075',   // 6.05:1  (was #64748b, 4.55:1 — only just passing)
  textFaint:   '#64748b',   // 4.55:1  (was #94a3b8, 2.45:1)
  placeholder: '#94a3b8',   // 2.45:1  — placeholders may sit below body text
  headerBg:    '#ffffff',
  headerText:  '#0f172a',
  toolbarBg:   '#ffffff',
  accent:       '#c8c8ce',
  accentBorder: '#a8a8b0',
  accentText:   '#1a1a1a',
};

const SEPIA = {
  bg:          '#f3e9d2',
  surface:     '#f9f1de',
  border:      '#e3d8bf',
  text:        '#4b4034',
  textMuted:   '#5f5034',   // 6.48:1  (was #8c7a5e, 3.44:1)
  textFaint:   '#6d5c3e',   // 5.35:1  (was #bcab86, 1.87:1)
  placeholder: '#8c7a5e',   // 3.44:1  — placeholders may sit below body text
  headerBg:    '#ece1c6',
  headerText:  '#4b4034',
  toolbarBg:   '#ece1c6',
  accent:       '#9c6b3f',
  accentBorder: '#85592f',
  accentText:   '#ffffff',
};

const ICE = {
  bg:          '#ffffff',
  surface:     '#eef3fa',
  border:      '#e3e9f3',
  text:        '#233044',
  textMuted:   '#526078',   // 6.36:1  (was #6f7f9c, 4.04:1)
  textFaint:   '#5c6c88',   // 5.31:1  (was #a9b5cb, 2.07:1)
  placeholder: '#6f7f9c',   // 4.04:1  — placeholders may sit below body text
  headerBg:    '#ffffff',
  headerText:  '#233044',
  toolbarBg:   '#ffffff',
  accent:       '#2f86d6',
  accentBorder: '#2a78c0',
  accentText:   '#ffffff',
};