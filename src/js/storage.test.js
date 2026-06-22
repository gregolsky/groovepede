import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { extractAlbumId, validateAlbumInput, parseMusicLink, serializeBackup, parseBackup, upgradeAlbumRecord, loadAlbums, saveAlbums } from './storage.js';

describe('extractAlbumId', () => {
  it('extracts id from full Spotify URL', () => {
    expect(extractAlbumId('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('extracts id from Spotify URI', () => {
    expect(extractAlbumId('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('accepts a bare 22-char album ID', () => {
    expect(extractAlbumId('4aawyAB9vmqN3uQ7FjRGTy')).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });
  it('returns null for an artist URL', () => {
    expect(extractAlbumId('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(extractAlbumId('not a url')).toBeNull();
  });
});

describe('validateAlbumInput', () => {
  it('returns id for a valid album URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns id for a valid Spotify URI', () => {
    const r = validateAlbumInput('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns id for a bare album ID', () => {
    const r = validateAlbumInput('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.error).toBeNull();
  });
  it('returns null id and no error for empty string', () => {
    const r = validateAlbumInput('');
    expect(r.id).toBeNull();
    expect(r.error).toBeNull();
  });
  it('returns artist error for artist URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/artist/i);
  });
  it('returns artist error for artist URI', () => {
    const r = validateAlbumInput('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/artist/i);
  });
  it('returns track error for track URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/track/i);
  });
  it('returns playlist error for playlist URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/playlist/i);
  });
  it('returns podcast error for show URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/podcast/i);
  });
  it('returns podcast error for episode URL', () => {
    const r = validateAlbumInput('https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/podcast/i);
  });
  it('returns generic spotify error for unknown spotify path', () => {
    const r = validateAlbumInput('https://open.spotify.com/user/someuser');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/spotify/i);
  });
  it('returns non-spotify error for other URL', () => {
    const r = validateAlbumInput('https://www.youtube.com/watch?v=abc');
    expect(r.id).toBeNull();
    expect(r.error).toMatch(/spotify/i);
  });
  it('returns generic error for garbage text', () => {
    const r = validateAlbumInput('blah blah blah');
    expect(r.id).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

describe('parseMusicLink', () => {
  // ── Spotify ──────────────────────────────────────────────────────────────────
  it('accepts Spotify album URL', () => {
    const r = parseMusicLink('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
    expect(r.error).toBeUndefined();
  });
  it('normalizes Spotify URI to URL', () => {
    const r = parseMusicLink('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
  });
  it('normalizes bare 22-char Spotify ID to URL', () => {
    const r = parseMusicLink('4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(r.service).toBe('spotify');
  });
  it('rejects Spotify artist URL with artist error', () => {
    const r = parseMusicLink('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(r.error).toMatch(/artist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify track URL with track error', () => {
    const r = parseMusicLink('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify playlist URL with playlist error', () => {
    const r = parseMusicLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    expect(r.error).toMatch(/playlist/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Spotify podcast with podcast error', () => {
    const r = parseMusicLink('https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL');
    expect(r.error).toMatch(/podcast/i);
    expect(r.url).toBeUndefined();
  });

  // ── Apple Music ───────────────────────────────────────────────────────────────
  it('accepts Apple Music album URL', () => {
    const r = parseMusicLink('https://music.apple.com/us/album/ok-computer/1097861328');
    expect(r.service).toBe('apple');
    expect(r.url).toBe('https://music.apple.com/us/album/ok-computer/1097861328');
    expect(r.error).toBeUndefined();
  });

  // ── YouTube / YouTube Music ───────────────────────────────────────────────────
  it('accepts YouTube Music playlist URL', () => {
    const r = parseMusicLink('https://music.youtube.com/playlist?list=OLAK5uy_abc123');
    expect(r.service).toBe('youtube');
    expect(r.error).toBeUndefined();
  });
  it('accepts YouTube playlist URL', () => {
    const r = parseMusicLink('https://www.youtube.com/playlist?list=PLabc123');
    expect(r.service).toBe('youtube');
    expect(r.error).toBeUndefined();
  });
  it('rejects YouTube single-video URL with track error', () => {
    const r = parseMusicLink('https://www.youtube.com/watch?v=abc123');
    expect(r.error).toMatch(/track/i);
    expect(r.url).toBeUndefined();
  });

  // ── Deezer ────────────────────────────────────────────────────────────────────
  it('accepts Deezer album URL', () => {
    const r = parseMusicLink('https://www.deezer.com/album/302127');
    expect(r.service).toBe('deezer');
    expect(r.error).toBeUndefined();
  });

  // ── Tidal ─────────────────────────────────────────────────────────────────────
  it('accepts Tidal album URL', () => {
    const r = parseMusicLink('https://tidal.com/album/26026362');
    expect(r.service).toBe('tidal');
    expect(r.error).toBeUndefined();
  });
  it('accepts Tidal listen subdomain URL', () => {
    const r = parseMusicLink('https://listen.tidal.com/album/26026362');
    expect(r.service).toBe('tidal');
    expect(r.error).toBeUndefined();
  });

  // ── Blocked sources ───────────────────────────────────────────────────────────
  it('rejects Bandcamp with specific error', () => {
    const r = parseMusicLink('https://radiohead.bandcamp.com/album/ok-computer');
    expect(r.error).toMatch(/bandcamp/i);
    expect(r.url).toBeUndefined();
  });
  it('rejects Discogs with specific error', () => {
    const r = parseMusicLink('https://www.discogs.com/release/123456');
    expect(r.error).toMatch(/discogs/i);
    expect(r.url).toBeUndefined();
  });

  // ── Unknown / garbage ─────────────────────────────────────────────────────────
  it('returns null error for empty string', () => {
    const r = parseMusicLink('');
    expect(r.error).toBeNull();
    expect(r.url).toBeUndefined();
  });
  it('rejects unknown URL with generic error', () => {
    const r = parseMusicLink('https://example.com/foo');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
  it('rejects garbage text with generic error', () => {
    const r = parseMusicLink('blah blah blah');
    expect(r.error).toBeTruthy();
    expect(r.url).toBeUndefined();
  });
});

describe('upgradeAlbumRecord', () => {
  const legacy = {
    id: '4aawyAB9vmqN3uQ7FjRGTy',
    url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
    title: 'OK Computer',
    artist: 'Radiohead',
    cover: 'https://example.com/cover.jpg',
    year: '1997',
    tags: ['alternative rock'],
    addedAt: '2024-01-01T00:00:00.000Z',
    firstTrackUri: 'spotify:track:abc123',
  };

  it('populates links.spotify from url', () => {
    const rec = upgradeAlbumRecord({ ...legacy });
    expect(rec.links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(rec.links.spotify.nativeUri).toBe('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('sets sourceUrl from url', () => {
    const rec = upgradeAlbumRecord({ ...legacy });
    expect(rec.sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('moves id to legacyId', () => {
    const rec = upgradeAlbumRecord({ ...legacy });
    expect(rec.legacyId).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('preserves existing id as-is', () => {
    const rec = upgradeAlbumRecord({ ...legacy });
    expect(rec.id).toBe('4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('preserves all other fields', () => {
    const rec = upgradeAlbumRecord({ ...legacy });
    expect(rec.title).toBe('OK Computer');
    expect(rec.artist).toBe('Radiohead');
    expect(rec.year).toBe('1997');
    expect(rec.tags).toEqual(['alternative rock']);
    expect(rec.firstTrackUri).toBe('spotify:track:abc123');
  });

  it('is idempotent: already-upgraded records are unchanged', () => {
    const upgraded = upgradeAlbumRecord({ ...legacy });
    const second = upgradeAlbumRecord({ ...upgraded });
    expect(second).toEqual(upgraded);
  });

  it('leaves records with existing links map untouched', () => {
    const modern = {
      id: 'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy',
      sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      links: { spotify: { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', nativeUri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' } },
      title: 'OK Computer',
      artist: 'Radiohead',
      tags: [],
      addedAt: '2024-01-01T00:00:00.000Z',
    };
    const rec = upgradeAlbumRecord({ ...modern });
    expect(rec.links).toEqual(modern.links);
    expect(rec.sourceUrl).toBe(modern.sourceUrl);
  });
});

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
});

describe('serializeBackup / parseBackup', () => {
  const albums = [{ id: 'abc', title: 'Test', artist: 'Artist', links: {}, sourceUrl: null }];

  it('round-trips albums and done count', () => {
    const text = serializeBackup(albums, 5);
    const result = parseBackup(text);
    expect(result.albums[0].title).toBe('Test');
    expect(result.albums[0].id).toBe('abc');
    expect(result.done).toBe(5);
  });

  it('serialized output includes version and exportedAt', () => {
    const data = JSON.parse(serializeBackup([], 0));
    expect(data.version).toBe(2);
    expect(typeof data.exportedAt).toBe('string');
  });

  it('throws on malformed JSON', () => {
    expect(() => parseBackup('not json')).toThrow();
  });

  it('throws when albums is not an array', () => {
    expect(() => parseBackup(JSON.stringify({ version: 1, albums: 'bad', done: 0 }))).toThrow();
  });

  it('throws when done is not a number', () => {
    expect(() => parseBackup(JSON.stringify({ version: 1, albums: [], done: 'bad' }))).toThrow();
  });

  it('loads version 1 backups with upgrade applied', () => {
    const v1 = JSON.stringify({
      version: 1,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [{
        id: '4aawyAB9vmqN3uQ7FjRGTy',
        url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
        title: 'OK Computer',
        artist: 'Radiohead',
        tags: [],
        addedAt: '2024-01-01T00:00:00.000Z',
      }],
      done: 2,
    });
    const result = parseBackup(v1);
    expect(result.albums[0].links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.done).toBe(2);
  });

  it('throws on wrong version', () => {
    expect(() => parseBackup(JSON.stringify({ version: 99, albums: [], done: 0 }))).toThrow();
  });
});
