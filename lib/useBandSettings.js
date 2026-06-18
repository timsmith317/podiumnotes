import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'podiumnotes.bandsettings.v1';

const DEFAULTS = {
  lines: 3,
  positionPct: 45,
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

export function useBandSettings() {
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
