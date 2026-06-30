// lib/useSettings.js
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'podiumnotes.settings.v1';

const DEFAULTS = {
  themeMode:      'system',    // 'system' | 'light' | 'dark' | 'sepia' | 'ice'
  displayFont:    'system',    // 'system' | 'serif' | 'mono'
  bandLines:      3,
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

const DARK = {
  bg:          '#0f172a',
  surface:     '#1e293b',
  border:      '#1e293b',
  text:        '#f8fafc',
  textMuted:   '#64748b',
  textFaint:   '#334155',
  placeholder: '#334155',
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
  textMuted:   '#64748b',
  textFaint:   '#94a3b8',
  placeholder: '#94a3b8',
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
  textMuted:   '#8c7a5e',
  textFaint:   '#bcab86',
  placeholder: '#bcab86',
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
  textMuted:   '#6f7f9c',
  textFaint:   '#a9b5cb',
  placeholder: '#a9b5cb',
  headerBg:    '#ffffff',
  headerText:  '#233044',
  toolbarBg:   '#ffffff',
  accent:       '#2f86d6',
  accentBorder: '#2a78c0',
  accentText:   '#ffffff',
};