import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../infra/api.js', () => ({ resolveAlbumResilient: vi.fn() }));
vi.mock('../infra/beacon.js', () => ({ reportFailure: vi.fn() }));
vi.mock('./enrich.js', () => ({ enrichWithLastfm: vi.fn() }));

const { resolveAlbumResilient } = await import('../infra/api.js');
const { reportFailure } = await import('../infra/beacon.js');
const { enrichWithLastfm } = await import('./enrich.js');
const { addAlbumFromUrl, markListened, refreshAlbum, exportBackup, replaceQueue, findBySourceUrl } = await import('./queue.js');
const { loadAlbums, saveAlbums, loadDone, saveDone } = await import('../infra/storage.js');

const URL_A = 'https://open.spotify.com/album/a';
const record = (id, extra = {}) => ({ id, sourceUrl: URL_A, title: 'T', artist: 'A', tags: [], links: {}, addedAt: '2026-10-01T00:00:00.000Z', ...extra });
const onChange = () => {};

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    _store: {},
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = v; },
    removeItem(k) { delete this._store[k]; },
  });
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('addAlbumFromUrl', () => {
  it('saves a new album and starts its enrichment', async () => {
    resolveAlbumResilient.mockResolvedValueOnce(record('spotify:a'));
    const outcome = await addAlbumFromUrl(URL_A, 'spotify', 'manual-resolve', onChange);
    expect(outcome.kind).toBe('added');
    expect(loadAlbums().map(a => a.id)).toEqual(['spotify:a']);
    expect(enrichWithLastfm).toHaveBeenCalledWith('spotify:a', 'A', 'T', onChange);
  });

  it('reports an album already queued under the same id as `exists`, saving nothing', async () => {
    saveAlbums([record('spotify:a', { sourceUrl: 'https://spotify.link/old' })]);
    resolveAlbumResilient.mockResolvedValueOnce(record('spotify:a'));
    expect((await addAlbumFromUrl(URL_A, 'spotify', 'share-resolve', onChange)).kind).toBe('exists');
    expect(loadAlbums()).toHaveLength(1);
    expect(enrichWithLastfm).not.toHaveBeenCalled();
  });

  it('saves a pending stub on a retryable failure — once, however often it is retried', async () => {
    resolveAlbumResilient.mockResolvedValue({ _error: 'network' });
    const first  = await addAlbumFromUrl(URL_A, 'spotify', 'manual-resolve', onChange);
    const second = await addAlbumFromUrl(URL_A, 'spotify', 'share-resolve', onChange);
    expect(first.kind).toBe('pending');
    expect(second.album.id).toBe(first.album.id);
    expect(loadAlbums()).toHaveLength(1);
    expect(loadAlbums()[0]._pending).toBe(true);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('saves nothing and reports a permanent failure', async () => {
    resolveAlbumResilient.mockResolvedValueOnce({ _error: 400 });
    expect(await addAlbumFromUrl(URL_A, 'spotify', 'manual-resolve', onChange)).toEqual({ kind: 'failed', error: 400 });
    expect(loadAlbums()).toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith('add-failed', { route: 'manual-resolve', service: 'spotify', msg: '400' });
  });
});

describe('markListened', () => {
  it('removes the album and counts it', () => {
    saveAlbums([record('a'), record('b')]);
    saveDone(3);
    expect(markListened('a')).toBe(true);
    expect(loadAlbums().map(a => a.id)).toEqual(['b']);
    expect(loadDone()).toBe(4);
  });

  it('counts nothing when the album already left the queue', () => {
    saveAlbums([record('b')]);
    saveDone(3);
    expect(markListened('a')).toBe(false);
    expect(loadDone()).toBe(3);
  });
});

describe('refreshAlbum', () => {
  it('merges the fresh result into the stored record and re-enriches it', async () => {
    saveAlbums([record('spotify:a', { cover: null, tags: ['rock'], links: { spotify: { url: URL_A } } })]);
    resolveAlbumResilient.mockResolvedValueOnce(record('spotify:a', { cover: 'https://i/c.jpg', tags: [], links: { deezer: { url: 'https://www.deezer.com/album/1' } } }));
    const merged = await refreshAlbum(loadAlbums()[0], onChange);
    expect(merged.cover).toBe('https://i/c.jpg');
    expect(merged.tags).toEqual(['rock']);                        // enriched separately, kept
    expect(Object.keys(merged.links)).toEqual(['spotify', 'deezer']);
    expect(enrichWithLastfm).toHaveBeenCalledOnce();
  });

  it('reports a permanent failure, but not a transport one (api.js already did)', async () => {
    saveAlbums([record('spotify:a')]);
    resolveAlbumResilient.mockResolvedValueOnce({ _error: 'network' });
    expect(await refreshAlbum(loadAlbums()[0], onChange)).toBeNull();
    expect(reportFailure).not.toHaveBeenCalled();

    resolveAlbumResilient.mockResolvedValueOnce({ _error: 400 });
    expect(await refreshAlbum(loadAlbums()[0], onChange)).toBeNull();
    expect(reportFailure).toHaveBeenCalledWith('refresh-failed', expect.objectContaining({ msg: '400' }));
  });

  it('writes nothing when the album left the queue during the refresh', async () => {
    const album = record('spotify:a');
    saveAlbums([]);
    resolveAlbumResilient.mockResolvedValueOnce(record('spotify:a'));
    expect(await refreshAlbum(album, onChange)).toBeNull();
    expect(loadAlbums()).toEqual([]);
  });
});

describe('backup', () => {
  it('exports a dated file of the whole queue', () => {
    saveAlbums([record('a')]);
    saveDone(2);
    const { filename, text } = exportBackup();
    expect(filename).toMatch(/^groovepede-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(text)).toMatchObject({ version: 4, done: 2, albums: [{ id: 'a' }] });
  });

  it('replaceQueue swaps in a parsed backup', () => {
    saveAlbums([record('old')]);
    replaceQueue({ albums: [record('new')], done: 9 });
    expect(loadAlbums().map(a => a.id)).toEqual(['new']);
    expect(loadDone()).toBe(9);
    expect(findBySourceUrl(URL_A).id).toBe('new');
  });
});
