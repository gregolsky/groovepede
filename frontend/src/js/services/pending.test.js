import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../infra/api.js', () => ({ resolveAlbumResilient: vi.fn() }));
vi.mock('../infra/beacon.js', () => ({ reportFailure: vi.fn() }));

const { resolveAlbumResilient } = await import('../infra/api.js');
const { reportFailure } = await import('../infra/beacon.js');
const { resolvePending, hasPendingAlbums } = await import('./pending.js');
const { loadAlbums, saveAlbums } = await import('../infra/storage.js');
const { makePendingRecord } = await import('../domain/albums.js');

const stubA = makePendingRecord('https://spotify.link/a', 'spotify');
const stubB = makePendingRecord('https://spotify.link/b', 'spotify');
const resolved = id => ({ id, title: `T ${id}`, artist: 'A', tags: [], links: {}, addedAt: '2026-10-18T00:00:00.000Z' });

describe('resolvePending', () => {
  let progress, added;
  const callbacks = () => ({ onProgress: p => progress.push(p), onAdded: rec => added.push(rec.id) });

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
    resolveAlbumResilient.mockReset();
    reportFailure.mockReset();
    progress = [];
    added = [];
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('returns null and does nothing when nothing is pending', async () => {
    saveAlbums([resolved('spotify:x')]);
    expect(hasPendingAlbums()).toBe(false);
    expect(await resolvePending(callbacks())).toBeNull();
    expect(resolveAlbumResilient).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
  });

  it('replaces each stub with its record, reporting progress and each added album', async () => {
    saveAlbums([stubA, stubB]);
    resolveAlbumResilient
      .mockResolvedValueOnce(resolved('spotify:a'))
      .mockResolvedValueOnce(resolved('spotify:b'));

    expect(await resolvePending(callbacks())).toEqual({ added: 2, failed: [] });
    expect(loadAlbums().map(a => a.id)).toEqual(['spotify:a', 'spotify:b']);
    expect(added).toEqual(['spotify:a', 'spotify:b']);
    expect(progress).toEqual([
      { done: 0, total: 2, retrying: 0 },
      { done: 1, total: 2, retrying: 0 },
      { done: 2, total: 2, retrying: 0 },
      null,
    ]);
  });

  it('drops a stub whose album is already queued, without counting or enriching it', async () => {
    saveAlbums([resolved('spotify:a'), stubA]);
    resolveAlbumResilient.mockResolvedValueOnce(resolved('spotify:a'));

    expect(await resolvePending(callbacks())).toEqual({ added: 0, failed: [] });
    expect(loadAlbums().map(a => a.id)).toEqual(['spotify:a']);
    expect(added).toEqual([]);
  });

  it('drops a permanently failing stub, records its URL and reports it', async () => {
    saveAlbums([stubA]);
    resolveAlbumResilient.mockResolvedValueOnce({ _error: 400 });

    expect(await resolvePending(callbacks())).toEqual({ added: 0, failed: [stubA.sourceUrl] });
    expect(loadAlbums()).toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith('add-failed', expect.objectContaining({ route: 'pending-resolve', msg: '400' }));
  });

  it('backs off on retryable errors and recovers', async () => {
    vi.useFakeTimers();
    saveAlbums([stubA]);
    resolveAlbumResilient
      .mockResolvedValueOnce({ _error: 'network' })
      .mockResolvedValueOnce(resolved('spotify:a'));

    const run = resolvePending(callbacks());
    await vi.advanceTimersByTimeAsync(2_000); // backoff(1) = 2 s
    expect(await run).toEqual({ added: 1, failed: [] });
    expect(progress).toContainEqual({ done: 0, total: 1, retrying: 1 });
  });

  it('leaves a stub pending after 4 retries (5 attempts) for a later run', async () => {
    vi.useFakeTimers();
    saveAlbums([stubA]);
    resolveAlbumResilient.mockResolvedValue({ _error: 503 });

    const run = resolvePending(callbacks());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toEqual({ added: 0, failed: [] });
    expect(resolveAlbumResilient).toHaveBeenCalledTimes(5);
    expect(loadAlbums().map(a => a.id)).toEqual([stubA.id]);
  });

  it('a call during a run joins it: returns null, and the run loops to pick up new stubs', async () => {
    saveAlbums([stubA]);
    let release;
    resolveAlbumResilient
      .mockImplementationOnce(() => new Promise(r => { release = () => r(resolved('spotify:a')); }))
      .mockResolvedValueOnce(resolved('spotify:b'));

    const first = resolvePending(callbacks());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    saveAlbums([...loadAlbums(), stubB]); // e.g. a share-target add while resolving
    expect(await resolvePending(callbacks())).toBeNull();
    release();

    expect(await first).toEqual({ added: 2, failed: [] });
    expect(loadAlbums().map(a => a.id)).toEqual(['spotify:a', 'spotify:b']);
  });
});
