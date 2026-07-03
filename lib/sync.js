// lib/sync.js
//
// The ONLY module in the app that imports expo-cloudkit. Everything else
// (useNotes, editor, list, settings) talks to this interface. If the library
// is abandoned or breaks, we rewrite the bodies here and nothing above changes.
// This mirrors the single-source-of-truth pattern in useSettings / useNotes.
//
// Model (see the architecture doc):
//   - AsyncStorage is the source of truth the UI runs on.
//   - CloudKit is a background courier that keeps devices in agreement.
//   - CKSyncEngine (iOS 17+) does the hard sync work; this is a thin bridge.
//
// v1 decisions baked in:
//   - Conflict policy: Last-Write-Wins by updatedAt, PLUS a "conflict copy"
//     so a losing edit is never silently destroyed (Option B).
//   - Deletes are HONORED over edits via a local tombstone store: once a note
//     id is deleted, a late-arriving edit for that id is dropped rather than
//     resurrecting the note. Tradeoff: an in-flight edit racing a delete loses.
//   - Diagnostics: getDiagnostics() feeds the long-press panel on the Settings
//     header.
//
// VERIFY markers below flag the exact expo-cloudkit call signatures that must
// be confirmed against the installed library version — the surrounding logic
// (state machine, tombstones, mapping, conflict copy, reconcile) is ours and
// is complete.

import AsyncStorage from '@react-native-async-storage/async-storage';
// VERIFY: exact named exports of expo-cloudkit against the installed version.
// Documented surface includes: configure, getAccountStatus,
// addAccountStatusListener, startSyncEngine, addSyncEventListener,
// saveRecords, deleteRecords, resolveSyncConflict, fetchPrivateDatabaseZones.
import * as CloudKit from 'expo-cloudkit';

// ── Config ──────────────────────────────────────────────────────────────────
const CONTAINER_ID = 'iCloud.app.podiumnotes.app';   // must match app.config.js + Apple Dev portal
const ZONE         = 'NotesZone';
const RECORD_TYPE  = 'Note';

const LOG = 'PODIUM_SYNC:';                            // greppable, matches PODIUM_NOTES_EDITOR convention
const PUSH_DEBOUNCE_MS = 1500;                         // batch rapid edits into one upload (AsyncStorage write is NOT debounced)
const TOMBSTONE_KEY = 'podiumnotes.tombstones.v1';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // prune deletes after 30d — by then every device has synced them

// ── Status state machine ─────────────────────────────────────────────────────
// idle → app launched, not yet started.  no-account → not signed into iCloud.
// syncing → engine active.  offline → engine active but no network.  error.
export const SYNC_STATUS = {
  IDLE:       'idle',
  NO_ACCOUNT: 'no-account',
  SYNCING:    'syncing',
  OFFLINE:    'offline',
  ERROR:      'error',
};

let _status = SYNC_STATUS.IDLE;
let _statusListeners = [];
let _remoteListeners = [];
let _lastError = null;
let _lastSyncAt = null;
let _pendingCount = 0;         // notes waiting on a debounced push
let _started = false;

// ── Small logger ─────────────────────────────────────────────────────────────
function log(...args) { console.log(LOG, ...args); }

function setStatus(next, detail) {
  if (_status === next) return;
  _status = next;
  log('status →', next, detail || '');
  _statusListeners.forEach(fn => { try { fn(next); } catch (e) {} });
}

// ── Tombstone store (honor-delete) ───────────────────────────────────────────
// { [noteId]: deletedAtEpochMs }. Persisted so a delete survives app restarts
// long enough for every device to observe it.
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

function addTombstone(id, deletedAt) {
  _tombstones[id] = deletedAt || Date.now();
  persistTombstones();
}

// A note id is "dead" if tombstoned and the tombstone is at least as new as the
// incoming edit. This is the honor-delete rule: the delete wins ties and wins
// against anything older. (A strictly-newer edit could resurrect, but v1 keeps
// deletes final for predictability — see doc §6.)
function isTombstoned(id, incomingUpdatedAt) {
  const t = _tombstones[id];
  if (t == null) return false;
  if (incomingUpdatedAt == null) return true;
  return t >= incomingUpdatedAt;
}

// ── Record <-> note mapping ──────────────────────────────────────────────────
// Note shape (from useNotes): { id, title, body, kind, createdAt, updatedAt }.
// VERIFY: the exact field-container shape expo-cloudkit expects/returns
// (recordName vs recordId, fields wrapper, changeTag location).
function noteToRecord(note) {
  return {
    recordType: RECORD_TYPE,
    recordName: note.id,                 // deterministic id → idempotent upsert (doc §3)
    zoneName:   ZONE,
    fields: {
      title:     note.title ?? '',
      body:      note.body ?? '',
      kind:      note.kind ?? 'text',
      createdAt: note.createdAt ?? Date.now(),
      updatedAt: note.updatedAt ?? Date.now(),
    },
  };
}

function recordToNote(rec) {
  const f = rec.fields || {};
  return {
    id:        rec.recordName,
    title:     f.title ?? '',
    body:      f.body ?? '',
    kind:      f.kind ?? 'text',
    createdAt: f.createdAt ?? Date.now(),
    updatedAt: f.updatedAt ?? Date.now(),
    _changeTag: rec.changeTag,           // retained for conflict-copy id derivation
  };
}

// ── Remote-change fan-out ────────────────────────────────────────────────────
// useNotes subscribes here; we hand it {upserts, deletes} to apply to AsyncStorage.
function emitRemote(upserts, deletes) {
  if (!upserts.length && !deletes.length) return;
  const payload = { upserts, deletes };
  _remoteListeners.forEach(fn => { try { fn(payload); } catch (e) {} });
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
  };
}

// Called once at app launch.
export async function initSync() {
  if (_started) return;
  _started = true;
  log('initSync');
  await loadTombstones();

  try {
    // VERIFY: configure() signature — container id, environment.
    CloudKit.configure(CONTAINER_ID);

    const status = await CloudKit.getAccountStatus();   // VERIFY: return values ('available' | ...)
    if (status !== 'available') {
      setStatus(SYNC_STATUS.NO_ACCOUNT, status);
      wireAccountListener();                            // recover if they sign in later
      return;
    }

    await startEngine();
    await runInitialReconcile();
  } catch (e) {
    _lastError = String(e);
    setStatus(SYNC_STATUS.ERROR, _lastError);
  }
}

function wireAccountListener() {
  // VERIFY: addAccountStatusListener signature + unsubscribe handle.
  try {
    CloudKit.addAccountStatusListener(async (status) => {
      log('account status', status);
      if (status === 'available' && _status === SYNC_STATUS.NO_ACCOUNT) {
        try {
          await startEngine();
          await runInitialReconcile();
        } catch (e) {
          _lastError = String(e);
          setStatus(SYNC_STATUS.ERROR, _lastError);
        }
      } else if (status !== 'available') {
        // Signed out mid-session: stop syncing, keep all local data.
        setStatus(SYNC_STATUS.NO_ACCOUNT, status);
      }
    });
  } catch (e) { /* listener unsupported → stay local-only */ }
}

async function startEngine() {
  log('startEngine');
  // CONFIRMED (v0.14 docs): startSyncEngine takes `zones` (array) + `database`
  // (or `databases` array in v0.14+). resolveConflicts:true routes conflicts to
  // the 'conflict' event instead of auto-resolving.
  // VERIFY: exact event object shape from addSyncEventListener (the `.type`
  // strings this handler switches on) — see the checklist doc.
  // NOTE: background sync needs registerBackgroundTask() at startup +
  // backgroundSyncTaskIdentifier in the config plugin. v1 is foreground-sync
  // only; add background later if testers want it.
  CloudKit.addSyncEventListener(handleSyncEvent);
  await CloudKit.startSyncEngine({ zones: [ZONE], database: 'private', resolveConflicts: true });
  setStatus(SYNC_STATUS.SYNCING);
}

// Optional foreground nudge — CKSyncEngine schedules itself, but triggerSync()
// asks it to sync now (e.g. on app foreground). Safe no-op if unsupported.
export function nudgeSync() {
  try { CloudKit.triggerSync && CloudKit.triggerSync(); } catch (e) {}
}

// Central handler for engine events. Event shapes per expo-cloudkit docs:
//   type 'fetched'  → server changes arrived  { upserts:[record], deletes:[recordName] }
//   type 'conflict' → { requestId, clientRecord, serverRecord }
//   type 'sent'     → local changes accepted
//   type 'error'    → { error }
// VERIFY: exact event.type strings and payload keys.
async function handleSyncEvent(event) {
  try {
    switch (event.type) {
      case 'fetched':   await onFetched(event);  break;
      case 'conflict':  await onConflict(event); break;
      case 'sent':      _lastSyncAt = Date.now(); break;
      case 'stateUpdate': /* engine persists its own token; nothing for us */ break;
      case 'error':
        _lastError = String(event.error);
        setStatus(SYNC_STATUS.ERROR, _lastError);
        break;
      default: /* ignore unknown */ break;
    }
  } catch (e) {
    _lastError = String(e);
    log('handleSyncEvent error', _lastError);
  }
}

// Server changes → filter through tombstones, then hand to useNotes.
async function onFetched(event) {
  const rawUpserts = (event.upserts || []).map(recordToNote);
  const rawDeletes = event.deletes || [];   // array of recordNames (== note ids)

  // Honor delete: drop any upsert whose id we consider deleted.
  const upserts = [];
  for (const n of rawUpserts) {
    if (isTombstoned(n.id, n.updatedAt)) {
      log('drop resurrect (tombstoned)', n.id);
      continue;
    }
    upserts.push(n);
  }

  // Record incoming deletes as tombstones so a racing local edit can't resurrect.
  for (const id of rawDeletes) addTombstone(id, Date.now());

  _lastSyncAt = Date.now();
  emitRemote(upserts, rawDeletes);
}

// Conflict → Last-Write-Wins by updatedAt, and preserve the loser as a copy.
async function onConflict(event) {
  const client = recordToNote(event.clientRecord);
  const server = recordToNote(event.serverRecord);

  // If the note was deleted, honor the delete instead of resurrecting via copy.
  if (isTombstoned(client.id) || isTombstoned(server.id)) {
    log('conflict on tombstoned id → honor delete', client.id);
    // VERIFY: resolveSyncConflict signature — resolve toward deletion/no-op.
    try { await CloudKit.deleteRecords([{ recordName: client.id, zoneName: ZONE }]); } catch (e) {}
    return;
  }

  const winner = (server.updatedAt >= client.updatedAt) ? server : client;
  const loser  = (winner === server) ? client : server;

  // Only make a copy if the bodies actually differ — identical bodies aren't a
  // real conflict, just a race. Prevents needless duplicate notes.
  const bodiesDiffer = (winner.body || '') !== (loser.body || '');

  // Resolve the canonical record toward the winner.
  // VERIFY: resolveSyncConflict signature (requestId + chosen record).
  try {
    await CloudKit.resolveSyncConflict({ requestId: event.requestId, record: noteToRecord(winner) });
  } catch (e) { log('resolveSyncConflict failed', String(e)); }

  if (bodiesDiffer) {
    // Deterministic copy id from the server changeTag → both devices generate
    // the SAME id, so the copy dedupes instead of multiplying across devices.
    const tagPart = (server._changeTag || 'x').toString().slice(0, 8);
    const copy = {
      id:        `${loser.id}-conflict-${tagPart}`,
      title:     `${loser.title || 'Untitled'} (conflict copy)`,
      body:      loser.body,
      kind:      loser.kind || 'text',
      createdAt: Date.now(),
      updatedAt: loser.updatedAt,
    };
    log('conflict copy created', copy.id);
    emitRemote([copy], []);        // surface to useNotes → AsyncStorage
    syncNote(copy);                // push the copy so the other device gets it too
  }

  _lastSyncAt = Date.now();
}

// ── Local → cloud ─────────────────────────────────────────────────────────────
// Per-note debounce so fast typing yields one upload. Fire-and-forget: callers
// (useNotes) never await this.
const _pushTimers = {};
const _pendingIds = new Set();

export function syncNote(note) {
  if (!_started || _status === SYNC_STATUS.NO_ACCOUNT) return;   // local-only mode: no-op
  if (note.kind === 'pdf') return;              // v1 scope: text only; PDF fileUri is device-local
  if (isTombstoned(note.id)) { log('skip push (tombstoned)', note.id); return; }

  _pendingIds.add(note.id);
  _pendingCount = _pendingIds.size;

  if (_pushTimers[note.id]) clearTimeout(_pushTimers[note.id]);
  _pushTimers[note.id] = setTimeout(async () => {
    delete _pushTimers[note.id];
    _pendingIds.delete(note.id);
    _pendingCount = _pendingIds.size;
    try {
      // VERIFY: saveRecords signature (array of records, options).
      await CloudKit.saveRecords([noteToRecord(note)]);
      _lastSyncAt = Date.now();
    } catch (e) {
      // serverRecordChanged surfaces via the conflict event, not here; other
      // errors just leave the note pending for the engine's own retry.
      log('saveRecords error', note.id, String(e));
    }
  }, PUSH_DEBOUNCE_MS);
}

export async function deleteNoteRemote(id) {
  addTombstone(id, Date.now());                 // honor-delete: remember locally first
  if (_pushTimers[id]) { clearTimeout(_pushTimers[id]); delete _pushTimers[id]; }
  _pendingIds.delete(id);
  _pendingCount = _pendingIds.size;
  if (!_started || _status === SYNC_STATUS.NO_ACCOUNT) return;
  try {
    // VERIFY: deleteRecords signature.
    await CloudKit.deleteRecords([{ recordName: id, zoneName: ZONE }]);
    _lastSyncAt = Date.now();
  } catch (e) { log('deleteRecords error', id, String(e)); }
}

// ── Initial reconcile ─────────────────────────────────────────────────────────
// Union merge of local (AsyncStorage, passed in by useNotes) and remote. Runs
// once when sync is first enabled on a device, or on a fresh install with an
// account that already holds notes. Idempotent thanks to deterministic ids.
//
// NOTE: this needs the local notes to reconcile against. To avoid coupling
// lib/sync to the notes storage internals, useNotes calls setLocalSnapshot()
// with its current notes just before initSync runs. Kept as a setter so the
// sync layer never reaches into the notes store directly.
let _localSnapshot = [];
export function setLocalSnapshot(notes) { _localSnapshot = Array.isArray(notes) ? notes : []; }

export async function runInitialReconcile() {
  if (_status === SYNC_STATUS.NO_ACCOUNT) return;
  log('runInitialReconcile: local', _localSnapshot.length);
  try {
    // VERIFY: how expo-cloudkit exposes a full zone fetch (query all, or an
    // initial fetchZoneChanges). Placeholder call name below.
    const remoteRecords = await CloudKit.query
      ? await CloudKit.query(RECORD_TYPE, undefined, undefined)   // VERIFY signature
      : [];
    const remote = remoteRecords.map(recordToNote);

    const localById  = new Map(_localSnapshot.map(n => [n.id, n]));
    const remoteById = new Map(remote.map(n => [n.id, n]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

    const upserts = [];       // → AsyncStorage
    for (const id of allIds) {
      if (isTombstoned(id)) continue;                  // stays deleted
      const l = localById.get(id);
      const r = remoteById.get(id);
      if (l && !r)      syncNote(l);                    // local only → push up
      else if (!l && r) upserts.push(r);               // remote only → pull down
      else if (l && r) {                               // both → LWW
        if (r.updatedAt > l.updatedAt) upserts.push(r);
        else if (l.updatedAt > r.updatedAt) syncNote(l);
        // equal → already in agreement
      }
    }
    if (upserts.length) emitRemote(upserts, []);
    _lastSyncAt = Date.now();
    log('reconcile done: pulled', upserts.length);
  } catch (e) {
    _lastError = String(e);
    log('reconcile error', _lastError);
  }
}
