/**
 * localStorage: the queue (behind a frozen in-memory cache, changed only
 * through updateAlbums/updateAlbum), the listened count and the preferred
 * service. The only module that touches localStorage.
 */
import { STORAGE_KEY, DONE_KEY, PREF_SERVICE_KEY } from './config.js';
import { SERVICES } from '../domain/music-services.js';
import { normalizeAlbums } from '../domain/albums.js';

const DEFAULT_PREF_SERVICE = 'spotify';

// ── In-memory cache ──────────────────────────────────────────────────────────
// loadAlbums() used to re-parse and re-migrate localStorage on every call —
// cheap per call, but it's called several times per rerender (getState(),
// visibleAlbums(), plus whatever a handler reads before dispatching). Keyed on
// the raw stored string rather than a dirty flag: a write from another tab (or
// a test seeding via localStorage.setItem directly, bypassing saveAlbums) just
// changes the raw string, so the next loadAlbums() call sees the mismatch and
// reparses — no separate invalidation path to keep in sync.
//
// The cached array and its records are deep-frozen. Nothing may mutate a
// loaded record except through updateAlbums/updateAlbum below, which clone
// before handing `fn` a mutable copy — a call site that mutates a loaded
// record directly now throws immediately (ES modules run in strict mode)
// instead of silently corrupting the cache every other caller shares.
let _cache = { raw: undefined, albums: undefined };

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function loadAlbums() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== _cache.raw) {
    let albums;
    try { albums = normalizeAlbums(JSON.parse(raw) || []); } catch { albums = []; }
    _cache = { raw, albums: deepFreeze(albums) };
  }
  return _cache.albums;
}

export function saveAlbums(a) {
  const raw = JSON.stringify(a);
  localStorage.setItem(STORAGE_KEY, raw);
  // Cache a JSON round-trip of `a`, not `a` itself: `a` is whatever the caller
  // (often a fresh structuredClone from updateAlbums below) still holds a
  // reference to, and this way the cache can never disagree with what
  // actually got persisted — nor can freezing it reach back and freeze
  // something the caller didn't mean to hand off.
  _cache = { raw, albums: deepFreeze(JSON.parse(raw)) };
}

/**
 * Read the stored queue, apply `fn`, and save — all synchronously, so no await
 * can land between the read and the write. Every change to the queue goes
 * through this (or updateAlbum): a caller that loads, awaits, then saves
 * writes back a stale snapshot and silently undoes whatever happened in
 * between (an album marked Done comes back, a just-added one disappears).
 * `fn` may return a new list, or mutate in place and return nothing — the
 * list it's handed is a fresh clone of the cache, never the frozen original.
 */
export function updateAlbums(fn) {
  const albums = structuredClone(loadAlbums());
  const next = fn(albums) ?? albums;
  saveAlbums(next);
  return next;
}

/**
 * Apply `fn` to one album by id, via the same synchronous read-modify-write.
 * `fn` may return a replacement record or mutate in place — again, a clone,
 * never the frozen cached record. Returns the stored record, or null —
 * without writing anything — when the album is no longer in the queue (e.g.
 * marked Done while an async lookup for it was in flight).
 */
export function updateAlbum(id, fn) {
  const albums = structuredClone(loadAlbums());
  const i = albums.findIndex(a => a.id === id);
  if (i === -1) return null;
  albums[i] = fn(albums[i]) ?? albums[i];
  saveAlbums(albums);
  return albums[i];
}

export function loadDone()    { return parseInt(localStorage.getItem(DONE_KEY) || '0'); }

export function saveDone(n)   { localStorage.setItem(DONE_KEY, String(n)); }

export function getPreferredService() {
  const stored = localStorage.getItem(PREF_SERVICE_KEY);
  // A previously-chosen preference (e.g. amazon/soundcloud, dropped from the
  // registry) that no longer maps to a registered service falls back to the
  // default rather than silently rendering nothing selected.
  if (stored && SERVICES.some(s => s.slug === stored)) return stored;
  return DEFAULT_PREF_SERVICE;
}

/** True when the user has explicitly chosen a preferred service (not just the default). */
export function hasExplicitPreferredService() {
  return !!localStorage.getItem(PREF_SERVICE_KEY);
}

export function setPreferredService(s) {
  localStorage.setItem(PREF_SERVICE_KEY, s);
}

/**
 * Swap a pending stub for its resolved record, keeping the stub's addedAt and
 * queue position. A short link (or a re-share while the resolver was down)
 * can resolve to an album that's already queued under its real id; then the
 * stub is just dropped — replacing it would put two records with one id in
 * the queue, and Done on either would remove both.
 * Returns 'added', 'exists', or null when the stub has left the queue.
 */
export function replacePendingStub(stubId, rec) {
  let outcome = null;
  updateAlbums(albums => {
    const i = albums.findIndex(a => a.id === stubId);
    if (i === -1) return;
    if (albums.some(a => a.id === rec.id)) {
      albums.splice(i, 1);
      outcome = 'exists';
    } else {
      albums[i] = { ...rec, addedAt: albums[i].addedAt };
      outcome = 'added';
    }
  });
  return outcome;
}
