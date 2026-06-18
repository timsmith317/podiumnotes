import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

load();

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
    return note.id;
  }, []);

  const updateNote = useCallback((id, changes) => {
    _notes = _notes.map(n =>
      n.id === id ? { ...n, ...changes, updatedAt: Date.now() } : n
    );
    persist();
    notify();
  }, []);

  const deleteNote = useCallback((id) => {
    _notes = _notes.filter(n => n.id !== id);
    persist();
    notify();
  }, []);

  const getNote = useCallback((id) => {
    return _notes.find(n => n.id === id) ?? null;
  }, [notes]);

  return { notes, createNote, updateNote, deleteNote, getNote };
}
