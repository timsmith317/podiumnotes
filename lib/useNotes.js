// lib/useNotes.js
import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  initSync, syncNote, deleteNoteRemote, onRemoteChange, setLocalSnapshot,
} from './sync';

const STORAGE_KEY = 'podiumnotes.notes.v1';

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function makeNote(overrides = {}) {
  const now = Date.now();
  return {
    id: makeId(),
    title: '',
    body: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let _notes = [];
let _listeners = [];

function notify() {
  _listeners.forEach(fn => fn([..._notes]));
}

async function load() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    _notes = raw ? JSON.parse(raw) : [];
    notify();
  } catch (e) {
    _notes = [];
  }
}

async function persist() {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(_notes));
  } catch (e) {}
}

// ── Remote → local apply path ────────────────────────────────────────────────
// Changes fetched from CloudKit land here. This path writes to _notes, persists,
// and notifies — but must NEVER call syncNote/deleteNoteRemote, or a fetched
// change would bounce straight back to the cloud (echo loop). It is the mirror
// image of the local mutators below: they push, this one doesn't.
function applyRemote({ upserts, deletes }) {
  let changed = false;

  if (deletes && deletes.length) {
    const del = new Set(deletes);
    const before = _notes.length;
    _notes = _notes.filter(n => !del.has(n.id));
    if (_notes.length !== before) changed = true;
  }

  if (upserts && upserts.length) {
    const existing = new Map(_notes.map(n => [n.id, n]));
    const added = [];
    for (const u of upserts) {
      // Copy only real note fields — strip sync metadata (e.g. _changeTag).
      const clean = {
        id: u.id,
        title: u.title ?? '',
        body: u.body ?? '',
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      };
      if (u.kind != null) clean.kind = u.kind;   // don't force `kind` onto text notes
      if (existing.has(u.id)) existing.set(u.id, { ...existing.get(u.id), ...clean });
      else added.push(clean);
      changed = true;
    }
    // Preserve existing order for updated notes; prepend new ones (newest-first,
    // consistent with createNote).
    _notes = [...added, ..._notes.map(n => existing.get(n.id) || n)];
  }

  if (changed) { persist(); notify(); }
}

// ── Startup: load local, then hand a snapshot to sync and start it ───────────
// Order matters: setLocalSnapshot must run before initSync, because initSync's
// initial reconcile merges against that snapshot. onRemoteChange is subscribed
// before initSync so no early fetched change is missed.
load().then(() => {
  setLocalSnapshot(_notes);
  onRemoteChange(applyRemote);
  initSync();
});

export function useNotes() {
  const [notes, setNotes] = useState([..._notes]);

  useEffect(() => {
    _listeners.push(setNotes);
    return () => { _listeners = _listeners.filter(fn => fn !== setNotes); };
  }, []);

  const createNote = useCallback((initial = {}) => {
    const note = makeNote(initial);
    _notes = [note, ..._notes];
    persist();
    notify();
    syncNote(note);              // push up (sync layer no-ops for pdf / no-account)
    return note.id;
  }, []);

  const updateNote = useCallback((id, changes) => {
    let updated = null;
    _notes = _notes.map(n => {
      if (n.id === id) { updated = { ...n, ...changes, updatedAt: Date.now() }; return updated; }
      return n;
    });
    persist();
    notify();
    if (updated) syncNote(updated);   // debounced push of the new state
  }, []);

  const deleteNote = useCallback((id) => {
    _notes = _notes.filter(n => n.id !== id);
    persist();
    notify();
    deleteNoteRemote(id);       // tombstones locally (honor-delete) + deletes remote
  }, []);

  const getNote = useCallback((id) => {
    return _notes.find(n => n.id === id) ?? null;
  }, [notes]);

  return { notes, createNote, updateNote, deleteNote, getNote };
}
