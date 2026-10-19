/**
 * Resolving pending stubs — links saved while the resolver was unreachable
 * (or restored from a lean v3 backup) — into full records, with per-stub
 * backoff. No DOM: app.js turns the progress callbacks into the import
 * progress bar and the import summary.
 */
import { resolveAlbumResilient } from '../infra/api.js';
import { loadAlbums, updateAlbums, replacePendingStub } from '../infra/storage.js';
import { isRetryableResolveError } from '../domain/albums.js';
import { reportFailure } from '../infra/beacon.js';

const MAX_RETRIES = 4;

// Backoff for transient errors in the retry loop (separate from the throttler's
// cooldown, which already paces resolver/MB calls). Capped at 60 s.
const retryBackoff = n => Math.min(Math.pow(2, n) * 1000, 60_000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = false;
let runAgain = false;

export function hasPendingAlbums() {
  return loadAlbums().some(a => a._pending);
}

/**
 * Resolve every pending stub in the queue, one at a time.
 *
 * Only one run at a time: a call while one is in progress makes that run loop
 * again (to pick up stubs added since it started) and returns null, as does a
 * call with nothing pending. Otherwise resolves to `{ added, failed }` —
 * albums newly in the queue, and the source URLs that permanently failed (and
 * were dropped). A stub still failing after its retries stays pending for a
 * later run.
 *
 * @param {object}   cb
 * @param {(progress: {done:number,total:number,retrying:number}|null) => void} cb.onProgress
 *        after every step; null once the run is over
 * @param {(rec: object) => void} cb.onAdded  for each album that entered the queue
 */
export async function resolvePending({ onProgress, onAdded }) {
  if (running) { runAgain = true; return null; }
  if (!hasPendingAlbums()) return null;

  running = true;
  let added = 0;
  const failed = [];
  try {
    do {
      runAgain = false;
      const pending = loadAlbums().filter(a => a._pending);
      if (!pending.length) break;

      const progress = { done: 0, total: pending.length, retrying: 0 };
      onProgress({ ...progress });

      for (const stub of pending) {
        const outcome = await resolveStub(stub, retrying => onProgress({ ...progress, retrying }));
        if (outcome.kind === 'added') { added++; onAdded(outcome.album); }
        if (outcome.kind === 'failed') failed.push(stub.sourceUrl);
        progress.done++;
        onProgress({ ...progress });
      }
    } while (runAgain);
  } finally {
    running = false;
    onProgress(null);
  }
  return { added, failed };
}

/**
 * Resolve one stub, backing off on retryable errors. Resolves to
 *   { kind: 'added', album } — replaced in place by its resolved record
 *   { kind: 'exists' }       — its album was already queued; stub dropped
 *   { kind: 'failed' }       — permanent failure (not-found / 4xx); stub dropped, reported
 *   { kind: 'pending' }      — still failing after MAX_RETRIES; left for a later run
 */
async function resolveStub(stub, onRetry) {
  for (let retry = 0; ; retry++) {
    const rec = await resolveAlbumResilient(stub.sourceUrl, { service: stub.service });
    if (!rec._error) {
      return replacePendingStub(stub.id, rec) === 'added' ? { kind: 'added', album: rec } : { kind: 'exists' };
    }
    if (!isRetryableResolveError(rec._error)) {
      updateAlbums(albums => albums.filter(a => a.id !== stub.id));
      reportFailure('add-failed', { route: 'pending-resolve', service: stub.service, msg: String(rec._error) });
      return { kind: 'failed' };
    }
    // Transient / rate-limited — back off and retry, or give up for now.
    if (retry >= MAX_RETRIES) return { kind: 'pending' };
    onRetry(retry + 1);
    await sleep(retryBackoff(retry + 1));
  }
}
