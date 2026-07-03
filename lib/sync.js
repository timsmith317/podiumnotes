// lib/sync.js
//
// The ONLY module that imports the CloudKit library. Everything else
// (useNotes, settings diagnostics) talks to this interface. If the library
// changes, we rewrite the bodies here and nothing above changes.
//
// Model (deliberately simple — Podium Notes is NOT the source of truth for a
// user's notes; it's a tool you bring notes INTO to present. Sync is a
// convenience so a note composed/imported on the iPhone is there on the iPad,
// nothing more):
//   - AsyncStorage is the local source of truth the UI runs on.
//   - iCloud (private CloudKit DB) is a convenience mirror.
//   - Foreground reconcile: push on local write, pull+merge on app open.
//   - Conflict policy: last-write-wins by updatedAt. No conflict copies — the
//     durable copy of any note lives in the user's real notes app, so a lost
//     edit costs a re-share, not real data. LWW matches the actual usage
//     pattern (compose on one device, practice on another, sequentially).
//   - Deletes are honored via a local tombstone set so a pull can't resurrect
//     a note deleted on this device.
//
// Uses react-native-icloud-kit: iCloud.save/query/delete/batchSave/isAvailable.
// Records are { recordId, fields }; we use the note id as recordId for
// idempotent upserts. The library auto-creates/uses a private custom zone.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { iCloud } from 'react-native-icloud-kit';

// ── Config ──────────────────────────────────────────────────────────────────
const RECORD_TYPE = 'Note';
const DELETION_TYPE = 'Deletion';                    // cloud tombstone marker (deletedAt only, no content)
const DELETION_PREFIX = 'del_';                      // marker recordId = prefix + note id
const LOG = 'PODIUM_SYNC:';
const PUSH_DEBOUNCE_MS = 1500;                       // batch rapid edits into one push
const TOMBSTONE_KEY = 'podiumnotes.tombstones.v1';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // prune deletes after 30d

// A CloudKit recordId can only ever belong to ONE record type. The Deletion
// marker must therefore use a DIFFERENT recordId than the Note it tombstones —
// reusing the note id makes CloudKit reject the save ("invalid attempt to
// update record from type 'Note' to 'Deletion'"). Prefixing keeps the marker
// id deterministic (both devices derive the same one) while distinct from the
// note record.
function markerIdFor(noteId) { return DELETION_PREFIX + noteId; }
function noteIdFromMarker(markerId) {
  return markerId.startsWith(DELETION_PREFIX) ? markerId.slice(DELETION_PREFIX.length) : markerId;
}

// ── Status ───────────────────────────────────────────────────────────────────
export const SYNC_STATUS = {
  IDLE:       'idle',
  NO_ACCOUNT: 'no-account',
  SYNCING:    'syncing',     // a push/pull is in flight
  IDLE_OK:    'idle-ok',     // started, signed in, nothing in flight
  ERROR:      'error',
};

let _status = SYNC_STATUS.IDLE;
let _statusListeners = [];
let _remoteListeners = [];
let _lastError = null;
let _lastSyncAt = null;
let _pendingCount = 0;
let _started = false;
let _available = false;

function log(...args) { console.log(LOG, ...args); }

function setStatus(next, detail) {
  if (_status === next) return;
  _status = next;
  log('status →', next, detail || '');
  _statusListeners.forEach(fn => { try { fn(next); } catch (e) {} });
}

// ── Tombstones (honor-delete) ────────────────────────────────────────────────
let _tombstones = {};

async function loadTombstones() {
  try {
    const raw = await AsyncStorage.getItem(TOMBSTONE_KEY);
    _tombstones = raw ? JSON.parse(raw) : {};
    pruneTombstones();
  } catch (e) { _tombstones = {}; }
}
async function persistTombstones() {
  try { await AsyncStorage.setItem(TOMBSTONE_KEY, JSON.stringify(_tombstones)); } catch (e) {}
}
function pruneTombstones() {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  let changed = false;
  for (const id of Object.keys(_tombstones)) {
    if (_tombstones[id] < cutoff) { delete _tombstones[id]; changed = true; }
  }
  if (changed) persistTombstones();
}
function addTombstone(id) { _tombstones[id] = Date.now(); persistTombstones(); }
function isTombstoned(id) { return _tombstones[id] != null; }

// ── Record <-> note mapping ──────────────────────────────────────────────────
// Note: { id, title, body, kind?, createdAt, updatedAt }.
// iCloud record: { recordId, fields }. Fields are flat string|number|null.
function noteToFields(note) {
  return {
    title:     note.title ?? '',
    body:      note.body ?? '',
    kind:      note.kind ?? 'text',
    createdAt: note.createdAt ?? Date.now(),
    updatedAt: note.updatedAt ?? Date.now(),
  };
}
function recordToNote(rec) {
  const f = rec.fields || {};
  return {
    id:        rec.recordId,
    title:     f.title ?? '',
    body:      f.body ?? '',
    kind:      f.kind ?? 'text',
    createdAt: f.createdAt ?? Date.now(),
    updatedAt: f.updatedAt ?? Date.now(),
  };
}

// ── Remote-change fan-out (useNotes subscribes) ──────────────────────────────
function emitRemote(upserts, deletes) {
  if (!upserts.length && !deletes.length) return;
  _remoteListeners.forEach(fn => { try { fn({ upserts, deletes }); } catch (e) {} });
}

// ── Public API ────────────────────────────────────────────────────────────────
export function onStatusChange(cb) {
  _statusListeners.push(cb);
  return () => { _statusListeners = _statusListeners.filter(fn => fn !== cb); };
}
export function onRemoteChange(cb) {
  _remoteListeners.push(cb);
  return () => { _remoteListeners = _remoteListeners.filter(fn => fn !== cb); };
}
export function getStatus() { return _status; }
export function getDiagnostics() {
  return {
    status:       _status,
    lastError:    _lastError,
    lastSyncAt:   _lastSyncAt,
    pendingCount: _pendingCount,
    tombstones:   Object.keys(_tombstones).length,
    started:      _started,
    available:    _available,
  };
}

// Called once at app launch.
export async function initSync() {
  if (_started) return;
  _started = true;
  log('initSync');
  await loadTombstones();
  try {
    _available = await iCloud.isAvailable();
    if (!_available) { setStatus(SYNC_STATUS.NO_ACCOUNT); return; }
    setStatus(SYNC_STATUS.IDLE_OK);
    await runInitialReconcile();
  } catch (e) {
    _lastError = String(e && e.message ? e.message : e);
    setStatus(SYNC_STATUS.ERROR, _lastError);
  }
}

// Pull + merge from iCloud. Called on launch (via initSync) and on app
// foreground (via useNotes wiring). This is the "automatic on open" path.
export async function runInitialReconcile() {
  if (!_started) return;
  try {
    _available = await iCloud.isAvailable();
    if (!_available) { setStatus(SYNC_STATUS.NO_ACCOUNT); return; }

    setStatus(SYNC_STATUS.SYNCING, 'pull');

    // Two fetches: the notes, and the deletion tombstones. The Deletion markers
    // are what make deletes propagate to devices that didn't do the deleting —
    // without them, "local note absent from cloud" is ambiguous (deleted vs.
    // not-yet-synced) and we'd resurrect deleted notes.
    const records = await iCloud.query(RECORD_TYPE);
    const remote = records.map(recordToNote);

    let deletions = [];
    try { deletions = await iCloud.query(DELETION_TYPE); } catch (e) { /* type may not exist yet */ }
    // Map note id → deletedAt (ms). The marker's OWN recordId is prefixed
    // (del_<noteId>), so derive the note id it refers to. Also seed our local
    // tombstone set so this device honors the delete and syncNote won't push.
    // markerIdByNote lets us clean up the correctly-prefixed marker later.
    const deletedById = new Map();
    const markerIdByNote = new Map();
    for (const d of deletions) {
      const noteId = (d.fields && d.fields.noteId) || noteIdFromMarker(d.recordId);
      const when = (d.fields && d.fields.deletedAt) || Date.now();
      deletedById.set(noteId, when);
      markerIdByNote.set(noteId, d.recordId);
      if (!isTombstoned(noteId)) addTombstone(noteId);
    }

    const localById  = new Map(_localSnapshot.map(n => [n.id, n]));
    const remoteById = new Map(remote.map(n => [n.id, n]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys(), ...deletedById.keys()]);

    const upserts = [];        // → AsyncStorage (pull down / update)
    const removals = [];       // → AsyncStorage (delete locally)
    const toPush = [];         // → iCloud (push up)
    const cleanupDeletions = []; // old Deletion marker ids to prune from cloud
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;

    for (const id of allIds) {
      const l = localById.get(id);
      const r = remoteById.get(id);

      // A cloud Deletion marker (or a local tombstone) means the note is dead.
      if (deletedById.has(id) || isTombstoned(id)) {
        if (l) removals.push(id);                  // remove from this device if present
        if (r) { try { await iCloud.delete(RECORD_TYPE, id); } catch (e) {} } // stray note record → clean up
        // Prune very old markers so Deletion records don't accumulate forever.
        const when = deletedById.get(id);
        const markerId = markerIdByNote.get(id);
        if (when != null && when < cutoff && markerId) cleanupDeletions.push(markerId);
        continue;
      }

      if (l && !r)      toPush.push(l);            // local only, not deleted → push up
      else if (!l && r) upserts.push(r);           // remote only → pull down
      else if (l && r) {                           // both → LWW by updatedAt
        if (r.updatedAt > l.updatedAt) upserts.push(r);
        else if (l.updatedAt > r.updatedAt) toPush.push(l);
      }
    }

    if (upserts.length || removals.length) emitRemote(upserts, removals);
    for (const n of toPush) syncNote(n);           // debounced pushes
    for (const markerId of cleanupDeletions) {
      try { await iCloud.delete(DELETION_TYPE, markerId); } catch (e) {}
    }

    _lastSyncAt = Date.now();
    setStatus(SYNC_STATUS.IDLE_OK, `pulled ${upserts.length} removed ${removals.length}`);
    log('reconcile done: pulled', upserts.length, 'removed', removals.length, 'pushed', toPush.length);
  } catch (e) {
    _lastError = String(e && e.message ? e.message : e);
    setStatus(SYNC_STATUS.ERROR, _lastError);
  }
}

// ── Local → cloud (debounced per note) ───────────────────────────────────────
const _pushTimers = {};
const _pendingIds = new Set();

export function syncNote(note) {
  if (!_started || !_available) return;            // local-only mode
  if (note.kind === 'pdf') return;                 // v1 scope: text only
  if (isTombstoned(note.id)) return;

  _pendingIds.add(note.id);
  _pendingCount = _pendingIds.size;

  if (_pushTimers[note.id]) clearTimeout(_pushTimers[note.id]);
  _pushTimers[note.id] = setTimeout(async () => {
    delete _pushTimers[note.id];
    _pendingIds.delete(note.id);
    _pendingCount = _pendingIds.size;
    try {
      setStatus(SYNC_STATUS.SYNCING, 'push');
      // save(recordType, fields, recordId) — note.id as recordId → idempotent
      // upsert (savePolicy .allKeys replaces the whole record).
      await iCloud.save(RECORD_TYPE, noteToFields(note), note.id);
      _lastSyncAt = Date.now();
      setStatus(SYNC_STATUS.IDLE_OK);
    } catch (e) {
      _lastError = String(e && e.message ? e.message : e);
      log('save error', note.id, _lastError);
      setStatus(SYNC_STATUS.ERROR, _lastError);
    }
  }, PUSH_DEBOUNCE_MS);
}

export async function deleteNoteRemote(id) {
  addTombstone(id);                                // honor-delete: remember locally
  if (_pushTimers[id]) { clearTimeout(_pushTimers[id]); delete _pushTimers[id]; }
  _pendingIds.delete(id);
  _pendingCount = _pendingIds.size;
  if (!_started || !_available) {
    log('delete (local only, not synced)', id, 'started=', _started, 'available=', _available);
    return;
  }
  try {
    // Write a cloud tombstone FIRST, then remove the note. The Deletion marker
    // is how OTHER devices learn the note is gone: without it, a device that
    // still holds the note locally would see "local note absent from cloud" on
    // reconcile and re-push it (resurrection). The marker turns the deletion
    // into a positive fact every device can observe. Deterministic recordId
    // (== note id) means two devices deleting the same note write one marker.
    log('delete: writing Deletion marker', id);
    await iCloud.save(DELETION_TYPE, { deletedAt: Date.now(), noteId: id }, markerIdFor(id));
    log('delete: marker written, removing Note', id);
    try { await iCloud.delete(RECORD_TYPE, id); } catch (e) { log('delete: Note remove failed (ok if absent)', String(e && e.message ? e.message : e)); }
    log('delete: done', id);
    _lastSyncAt = Date.now();
  } catch (e) {
    _lastError = String(e && e.message ? e.message : e);
    log('delete ERROR (marker write failed)', id, _lastError);
    setStatus(SYNC_STATUS.ERROR, _lastError);
  }
}

// ── Local snapshot handoff (useNotes sets this before initSync/reconcile) ─────
let _localSnapshot = [];
export function setLocalSnapshot(notes) { _localSnapshot = Array.isArray(notes) ? notes : []; }

// Kept for API compatibility with the previous engine-based wrapper; a manual
// nudge just re-runs the pull. useNotes can call this on app foreground.
// Manual reconcile trigger — returns the promise so callers (e.g. pull-to-
// refresh) can await completion and drive a spinner.
export function nudgeSync() { return runInitialReconcile(); }