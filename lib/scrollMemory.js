// lib/scrollMemory.js
//
// Remembers the presenter scroll position per note, so reopening a note returns
// to where you left off. Kept separate from the notes store on purpose: viewing
// a note shouldn't change its updatedAt / list ordering, only editing should.

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'podiumnotes.scroll.v1';

let _map = {};
let _loaded = false;
let _loadPromise = null;

function load() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      _map = raw ? JSON.parse(raw) : {};
    } catch (e) {
      _map = {};
    }
    _loaded = true;
  })();
  return _loadPromise;
}

load();

function persist() {
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_map)).catch(() => {});
}

// Synchronous best-effort read (returns 0 until the store has loaded).
export function getScrollSync(id) {
  return (_loaded && _map[id]) || 0;
}

// Async read that waits for the store to be ready (covers cold-start first open).
export async function getScroll(id) {
  await load();
  return _map[id] || 0;
}

export function setScroll(id, y) {
  if (!id) return;
  _map[id] = Math.max(0, Math.round(y || 0));
  persist();
}

export function clearScroll(id) {
  if (id && _map[id] != null) {
    delete _map[id];
    persist();
  }
}