import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makePendingRecord } from '../domain/albums.js';
import { getPreferredService, loadAlbums, replacePendingStub, saveAlbums, setPreferredService, updateAlbum, updateAlbums } from './storage.js';

describe('loadAlbums migration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('folds stored tags that differ only in case or spelling into one lowercase tag', () => {
    localStorage.setItem('gp_albums', JSON.stringify([
      { id: 'a', title: 'T', artist: 'A', tags: ['Rock', 'rock', 'Pop', 'Rap/Hip Hop', 'hip-hop'], links: {} },
    ]));
    expect(loadAlbums()[0].tags).toEqual(['rock', 'pop', 'hip-hop']);
  });

  it('returns an already-clean record as-is', () => {
    const rec = { id: 'a', title: 'T', artist: 'A', tags: ['rock', 'jazz'], links: {} };
    localStorage.setItem('gp_albums', JSON.stringify([rec]));
    expect(loadAlbums()[0]).toEqual(rec);
  });

  it('upgrades legacy records on load', () => {
    const legacy = [{
      id: '4aawyAB9vmqN3uQ7FjRGTy',
      url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      title: 'OK Computer',
      artist: 'Radiohead',
      tags: [],
      addedAt: '2024-01-01T00:00:00.000Z',
    }];
    localStorage.setItem('gp_albums', JSON.stringify(legacy));
    const albums = loadAlbums();
    expect(albums[0].links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(albums[0].sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('is idempotent across multiple loadAlbums calls', () => {
    const legacy = [{
      id: '4aawyAB9vmqN3uQ7FjRGTy',
      url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      title: 'OK Computer',
      artist: 'Radiohead',
      tags: [],
      addedAt: '2024-01-01T00:00:00.000Z',
    }];
    localStorage.setItem('gp_albums', JSON.stringify(legacy));
    const first = loadAlbums();
    saveAlbums(first);
    const second = loadAlbums();
    expect(second).toEqual(first);
  });

  it('returns empty array when storage is empty', () => {
    expect(loadAlbums()).toEqual([]);
  });

  it('canonicalises legacy ids and collapses records that turn out to be the same album', () => {
    // A queue carrying the three Spotify id eras at once — the same album
    // saved long ago (bare id) and again recently (spotify:<id>) is one album.
    localStorage.setItem('gp_albums', JSON.stringify([
      { id: '65mmHlZPWc1L3wkfWzG0n9', title: 'Functional Designs', artist: 'Deepchord', tags: [], links: {}, sourceUrl: 'https://open.spotify.com/album/65mmHlZPWc1L3wkfWzG0n9' },
      { id: 'SPOTIFY_ALBUM::4D18mfFBl73AN5URPMV083', title: 'Underneath My Tears', artist: 'Betwixt The Stars', tags: [], links: {}, sourceUrl: 'https://open.spotify.com/album/4D18mfFBl73AN5URPMV083' },
      { id: 'spotify:65mmHlZPWc1L3wkfWzG0n9', title: 'Functional Designs', artist: 'Deepchord', tags: [], links: {}, sourceUrl: 'https://open.spotify.com/album/65mmHlZPWc1L3wkfWzG0n9?si=x' },
    ]));
    const ids = loadAlbums().map(a => a.id);
    expect(ids).toEqual(['spotify:65mmHlZPWc1L3wkfWzG0n9', 'spotify:4D18mfFBl73AN5URPMV083']);
  });
});

describe('updateAlbums / updateAlbum', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
    saveAlbums([{ id: 'a', tags: [], links: {} }, { id: 'b', tags: [], links: {} }]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('updateAlbums saves a returned list', () => {
    updateAlbums(albums => albums.filter(x => x.id !== 'a'));
    expect(loadAlbums().map(x => x.id)).toEqual(['b']);
  });

  it('updateAlbums saves in-place mutation when fn returns nothing', () => {
    updateAlbums(albums => { albums.push({ id: 'c', tags: [], links: {} }); });
    expect(loadAlbums().map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('updateAlbum changes one record and returns it', () => {
    const saved = updateAlbum('b', rec => { rec.title = 'T'; });
    expect(saved.title).toBe('T');
    expect(loadAlbums().find(x => x.id === 'b').title).toBe('T');
  });

  it('updateAlbum is a no-op returning null for an album no longer queued', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    expect(updateAlbum('gone', rec => { rec.title = 'T'; })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('loadAlbums in-memory cache', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses the stored string once — a second call with nothing changed skips JSON.parse', () => {
    saveAlbums([{ id: 'a', tags: [], links: {} }]);
    const parseSpy = vi.spyOn(JSON, 'parse');
    loadAlbums();
    loadAlbums();
    expect(parseSpy).not.toHaveBeenCalled(); // saveAlbums already populated the cache
  });

  it('reparses when the raw string changes from outside saveAlbums (another tab, or a test seeding directly)', () => {
    saveAlbums([{ id: 'a', tags: [], links: {} }]);
    expect(loadAlbums().map(x => x.id)).toEqual(['a']);

    // Bypasses saveAlbums — simulates a write this tab didn't make.
    localStorage.setItem('gp_albums', JSON.stringify([{ id: 'b', tags: [], links: {} }]));
    expect(loadAlbums().map(x => x.id)).toEqual(['b']);
  });

  it('throws on a direct mutation of a loaded record instead of silently corrupting the cache', () => {
    saveAlbums([{ id: 'a', tags: [], links: {} }]);
    const [album] = loadAlbums();
    expect(() => { album.title = 'sneaky'; }).toThrow();
    expect(() => { loadAlbums()[0].tags.push('x'); }).toThrow();
    expect(() => { loadAlbums().push({ id: 'b', tags: [], links: {} }); }).toThrow();
  });

  it('updateAlbum still commits — the clone it hands to fn is mutable even though the cache is frozen', () => {
    saveAlbums([{ id: 'a', tags: [], links: {} }]);
    updateAlbum('a', rec => { rec.title = 'T'; });
    expect(loadAlbums().find(x => x.id === 'a').title).toBe('T');
  });
});

describe('getPreferredService / setPreferredService', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns spotify as default when nothing is stored', () => {
    expect(getPreferredService()).toBe('spotify');
  });

  it('round-trips set → get', () => {
    setPreferredService('apple');
    expect(getPreferredService()).toBe('apple');
  });

  it('persists across multiple calls', () => {
    setPreferredService('deezer');
    expect(getPreferredService()).toBe('deezer');
    expect(getPreferredService()).toBe('deezer');
  });

  it('overwrites previous preference', () => {
    setPreferredService('tidal');
    setPreferredService('youtube');
    expect(getPreferredService()).toBe('youtube');
  });

  it('falls back to the default when the stored preference is a service dropped from the registry', () => {
    setPreferredService('amazon'); // stale value from before amazon was dropped
    expect(getPreferredService()).toBe('spotify');
  });
});

// ── makePendingRecord ─────────────────────────────────────────────────────────

describe('replacePendingStub', () => {
  const stub = { ...makePendingRecord('https://spotify.link/x', 'spotify'), addedAt: '2026-01-01T00:00:00.000Z' };
  const rec  = { id: 'spotify:abc', title: 'T', artist: 'A', tags: [], links: {}, addedAt: '2026-09-09T00:00:00.000Z' };

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('replaces the stub in place, keeping its addedAt', () => {
    saveAlbums([{ id: 'first', tags: [], links: {} }, stub, { id: 'last', tags: [], links: {} }]);
    expect(replacePendingStub(stub.id, rec)).toBe('added');
    const albums = loadAlbums();
    expect(albums.map(a => a.id)).toEqual(['first', 'spotify:abc', 'last']);
    expect(albums[1].addedAt).toBe(stub.addedAt);
  });

  it('drops the stub when its album is already queued, so no id is ever stored twice', () => {
    saveAlbums([{ ...rec, title: 'Queued earlier' }, stub]);
    expect(replacePendingStub(stub.id, rec)).toBe('exists');
    const albums = loadAlbums();
    expect(albums.map(a => a.id)).toEqual(['spotify:abc']);
    expect(albums[0].title).toBe('Queued earlier');
  });

  it('is a no-op returning null when the stub has left the queue', () => {
    saveAlbums([{ id: 'other', tags: [], links: {} }]);
    expect(replacePendingStub(stub.id, rec)).toBeNull();
    expect(loadAlbums().map(a => a.id)).toEqual(['other']);
  });
});
