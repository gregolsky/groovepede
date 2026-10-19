/**
 * Queue use cases: adding an album from a link, marking one listened,
 * refreshing one's details, and replacing the whole queue from a backup.
 * No DOM — each returns an outcome for the UI to show; `onChange` is called
 * whenever background work (enrichment) later updates a stored album.
 */
import { resolveAlbumResilient } from '../infra/api.js';
import { loadAlbums, saveAlbums, updateAlbums, updateAlbum, loadDone, saveDone } from '../infra/storage.js';
import { reportFailure } from '../infra/beacon.js';
import { makePendingRecord, isRetryableResolveError, mergeRefreshedAlbum } from '../domain/albums.js';
import { serializeBackup } from '../domain/backup.js';
import { enrichWithLastfm } from './enrich.js';

/** The queued album saved from exactly this link, if any. */
export function findBySourceUrl(url) {
  return loadAlbums().find(a => a.sourceUrl === url);
}

/**
 * Persist a freshly resolved album and kick off its background enrichment.
 * Goes through updateAlbums rather than a caller-held array: resolving is
 * async, and a share-target add or a pending retry can land in between.
 * Returns false when an album with the same id was already queued.
 */
function saveResolvedAlbum(rec, onChange) {
  let added = false;
  updateAlbums(albums => {
    if (albums.some(a => a.id === rec.id)) return;
    albums.push(rec);
    added = true;
  });
  if (added) enrichWithLastfm(rec.id, rec.artist, rec.title, onChange);
  return added;
}

/**
 * Resolve `url` and record the outcome in the queue. The one implementation of
 * the add lifecycle shared by paste and a share-target launch — they used to
 * be two copies, and had already drifted: the share path pushed a pending stub
 * without checking for one. Resolves to one of
 *   { kind: 'added',   album } — new album saved; enrichment started
 *   { kind: 'exists',  album } — resolved to an album already queued (by id)
 *   { kind: 'pending', album } — resolver unreachable: saved as a stub, retried later
 *   { kind: 'failed',  error } — permanent failure: nothing saved; reported
 *
 * resolvePending (pending.js) and refreshAlbum resolve too but do something
 * different with the result (replace a stub in place with retries; merge into
 * an existing record), so they deliberately don't route through here.
 */
export async function addAlbumFromUrl(url, service, route, onChange) {
  const rec = await resolveAlbumResilient(url, { service });
  if (!rec._error) {
    return { kind: saveResolvedAlbum(rec, onChange) ? 'added' : 'exists', album: rec };
  }
  if (isRetryableResolveError(rec._error)) {
    let stub;
    updateAlbums(albums => {
      stub = albums.find(a => a.sourceUrl === url);
      if (!stub) albums.push(stub = makePendingRecord(url, service));
    });
    return { kind: 'pending', album: stub };
  }
  reportFailure('add-failed', { route, service, msg: String(rec._error) });
  return { kind: 'failed', error: rec._error };
}

/** Remove an album as listened and count it. False when it had already left the queue. */
export function markListened(albumId) {
  let removed = false;
  updateAlbums(albums => {
    const kept = albums.filter(a => a.id !== albumId);
    removed = kept.length !== albums.length;
    return kept;
  });
  if (removed) saveDone(loadDone() + 1);
  return removed;
}

/**
 * Re-resolve an album from its source link and merge the result into the
 * record as stored NOW, not the pre-await `album` (see updateAlbum). Resolves
 * to the merged record, or null when nothing changed: the resolve failed (a
 * permanent failure is reported here, like the add flows do; a transport one
 * already was, by api.js) or the album left the queue meanwhile.
 */
export async function refreshAlbum(album, onChange) {
  const rec = await resolveAlbumResilient(album.sourceUrl, { service: album.service });
  if (rec._error) {
    if (!isRetryableResolveError(rec._error)) {
      reportFailure('refresh-failed', { route: 'refresh', service: album.service, msg: String(rec._error) });
    }
    return null;
  }
  const merged = updateAlbum(album.id, current => mergeRefreshedAlbum(current, rec));
  if (merged) enrichWithLastfm(merged.id, merged.artist, merged.title, onChange);
  return merged;
}

/** The backup file for the current queue: `{ filename, text }`. */
export function exportBackup() {
  return {
    filename: `groovepede-backup-${new Date().toISOString().slice(0, 10)}.json`,
    text:     serializeBackup(loadAlbums(), loadDone()),
  };
}

/** Replace the queue and listened count with a parsed backup (see parseBackup). */
export function replaceQueue({ albums, done }) {
  saveAlbums(albums);
  saveDone(done);
}
