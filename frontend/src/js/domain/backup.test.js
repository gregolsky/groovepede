import { describe, it, expect } from 'vitest';
import { parseBackup, serializeBackup } from './backup.js';

describe('serializeBackup / parseBackup', () => {
  const fullAlbum = {
    id: 'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy',
    sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
    service: 'spotify',
    title: 'OK Computer',
    artist: 'Radiohead',
    cover: 'https://example.com/cover.jpg',
    year: '1997',
    tags: ['alternative rock'],
    links: { spotify: { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', nativeUri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' } },
    firstTrackUri: 'spotify:track:abc123',
    addedAt: '2024-01-01T00:00:00.000Z',
  };

  it('export produces v4 with full metadata including cover and links', () => {
    const data = JSON.parse(serializeBackup([fullAlbum], 5));
    expect(data.version).toBe(4);
    expect(data.albums[0].title).toBe('OK Computer');
    expect(data.albums[0].artist).toBe('Radiohead');
    expect(data.albums[0].cover).toBe('https://example.com/cover.jpg');
    expect(data.albums[0].year).toBe('1997');
    expect(data.albums[0].tags).toEqual(['alternative rock']);
    expect(data.albums[0].links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(data.albums[0].firstTrackUri).toBe('spotify:track:abc123');
    expect(data.albums[0].sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(data.albums[0].addedAt).toBe('2024-01-01T00:00:00.000Z');
    // Transient flags must NOT appear
    expect(data.albums[0]._pending).toBeUndefined();
    expect(data.done).toBe(5);
  });

  it('serialized output includes version 4 and exportedAt', () => {
    const data = JSON.parse(serializeBackup([], 0));
    expect(data.version).toBe(4);
    expect(typeof data.exportedAt).toBe('string');
  });

  it('v4 round-trip: export then import restores full non-pending record', () => {
    const text = serializeBackup([fullAlbum], 5);
    const result = parseBackup(text);
    expect(result.albums[0]._pending).toBeFalsy();
    expect(result.albums[0].title).toBe('OK Computer');
    expect(result.albums[0].artist).toBe('Radiohead');
    expect(result.albums[0].cover).toBe('https://example.com/cover.jpg');
    expect(result.albums[0].year).toBe('1997');
    expect(result.albums[0].tags).toEqual(['alternative rock']);
    expect(result.albums[0].links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.albums[0].firstTrackUri).toBe('spotify:track:abc123');
    expect(result.albums[0].addedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.done).toBe(5);
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

  it('imports v1 Spotify backup with metadata directly (non-pending)', () => {
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
    expect(result.albums[0]._pending).toBeFalsy();
    expect(result.albums[0].sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.albums[0].title).toBe('OK Computer');
    expect(result.albums[0].artist).toBe('Radiohead');
    expect(result.albums[0].addedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(result.done).toBe(2);
  });

  it('imports v2 backup with metadata directly (non-pending), cover and links restored', () => {
    const v2 = JSON.stringify({
      version: 2,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [{
        id: 'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy',
        sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
        service: 'spotify',
        title: 'OK Computer',
        artist: 'Radiohead',
        tags: ['rock'],
        cover: 'https://example.com/cover.jpg',
        links: { spotify: { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', nativeUri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' } },
        addedAt: '2024-06-01T00:00:00.000Z',
      }],
      done: 1,
    });
    const result = parseBackup(v2);
    expect(result.albums[0]._pending).toBeFalsy();
    expect(result.albums[0].title).toBe('OK Computer');
    expect(result.albums[0].cover).toBe('https://example.com/cover.jpg');
    expect(result.albums[0].tags).toEqual(['rock']);
    expect(result.albums[0].links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.albums[0].addedAt).toBe('2024-06-01T00:00:00.000Z');
    expect(result.done).toBe(1);
  });

  it('legacy record with no title/artist falls back to pending stub', () => {
    const v1 = JSON.stringify({
      version: 1,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [{
        id: '4aawyAB9vmqN3uQ7FjRGTy',
        url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
        addedAt: '2024-01-01T00:00:00.000Z',
      }],
      done: 0,
    });
    const result = parseBackup(v1);
    expect(result.albums[0]._pending).toBe(true);
    expect(result.albums[0].title).toBeNull();
  });

  it('v3 lean backup still produces pending stubs (back-compat)', () => {
    const v3 = JSON.stringify({
      version: 3,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [{ sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', service: 'spotify', addedAt: '2024-01-01T00:00:00.000Z' }],
      done: 0,
    });
    const result = parseBackup(v3);
    expect(result.albums[0]._pending).toBe(true);
    expect(result.albums[0].title).toBeNull();
    expect(result.albums[0].sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.albums[0].addedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('throws on wrong version', () => {
    expect(() => parseBackup(JSON.stringify({ version: 99, albums: [], done: 0 }))).toThrow();
  });

  it('filters out albums with no sourceUrl', () => {
    const v3 = JSON.stringify({
      version: 3,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [
        { sourceUrl: null, service: 'spotify', addedAt: '2024-01-01T00:00:00.000Z' },
        { sourceUrl: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', service: 'spotify', addedAt: '2024-01-01T00:00:00.000Z' },
      ],
      done: 0,
    });
    const result = parseBackup(v3);
    expect(result.albums.length).toBe(1);
    expect(result.albums[0].sourceUrl).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('strips _pending and _error flags from exported records', () => {
    const withTransientFlags = { ...fullAlbum, _pending: true, _error: 'network error' };
    const data = JSON.parse(serializeBackup([withTransientFlags], 0));
    expect(data.albums[0]._pending).toBeUndefined();
    expect(data.albums[0]._error).toBeUndefined();
    expect(data.albums[0].title).toBe('OK Computer'); // everything else survives
  });

  it('empty queue exports and round-trips to an empty album list', () => {
    const text = serializeBackup([], 0);
    const data = JSON.parse(text);
    expect(data.albums).toEqual([]);
    expect(data.done).toBe(0);
    const result = parseBackup(text);
    expect(result.albums).toEqual([]);
    expect(result.done).toBe(0);
  });

  it('falls back to spotify when service is absent and sourceUrl matches no known service', () => {
    const v4 = JSON.stringify({
      version: 4,
      exportedAt: '2024-01-01T00:00:00.000Z',
      albums: [{ sourceUrl: 'https://example.com/foo', addedAt: '2024-01-01T00:00:00.000Z' }],
      done: 0,
    });
    const result = parseBackup(v4);
    expect(result.albums[0]._pending).toBe(true);
    expect(result.albums[0].service).toBe('spotify');
  });
});

// An imported backup is user-supplied JSON ("export it, import it anywhere"),
// so every field the UI renders or opens is untrusted.
describe('parseBackup sanitizes untrusted records', () => {
  const wrap = albums => JSON.stringify({ version: 4, exportedAt: 'x', albums, done: 0 });

  it('drops unsafe link/cover URLs and non-string tags, and coerces a numeric year', () => {
    const { albums } = parseBackup(wrap([{
      id: 'spotify:abc', title: 'T', artist: 'A', year: 1999, cover: 'javascript:alert(1)',
      tags: ['rock', 42, { x: 1 }], sourceUrl: 'https://open.spotify.com/album/abc',
      links: {
        spotify: { url: 'javascript:alert(1)', nativeUri: 'spotify:album:abc' },
        evil:    { url: 'data:text/html,<script>alert(1)</script>' },
      },
    }]));
    const a = albums[0];
    expect(a.year).toBe('1999');
    expect(a.cover).toBeNull();
    expect(a.tags).toEqual(['rock']);
    expect(a.links.spotify).toEqual({ url: null, nativeUri: 'spotify:album:abc' });
    expect(a.links.evil).toBeUndefined();
  });

  it('drops a record whose sourceUrl is not http(s)', () => {
    const { albums } = parseBackup(wrap([{ id: 'x', title: 'T', artist: 'A', sourceUrl: 'javascript:alert(1)', links: {} }]));
    expect(albums).toHaveLength(0);
  });

  it('drops entries that are not objects', () => {
    const { albums } = parseBackup(wrap([null, 'str', 5, []]));
    expect(albums).toHaveLength(0);
  });

  it('canonicalises ids and drops cross-era duplicates on import', () => {
    const rec = (id, url) => ({ id, title: 'T', artist: 'A', tags: [], sourceUrl: url, links: {} });
    const { albums } = parseBackup(wrap([
      rec('65mmHlZPWc1L3wkfWzG0n9', 'https://open.spotify.com/album/65mmHlZPWc1L3wkfWzG0n9'),
      rec('SPOTIFY_ALBUM::4D18mfFBl73AN5URPMV083', 'https://open.spotify.com/album/4D18mfFBl73AN5URPMV083'),
      rec('spotify:65mmHlZPWc1L3wkfWzG0n9', 'https://open.spotify.com/album/65mmHlZPWc1L3wkfWzG0n9?si=x'),
    ]));
    expect(albums.map(a => a.id)).toEqual(['spotify:65mmHlZPWc1L3wkfWzG0n9', 'spotify:4D18mfFBl73AN5URPMV083']);
  });

  it('keeps an ordinary record intact', () => {
    const rec = {
      id: 'spotify:abc', title: 'T', artist: 'A', year: '2020', cover: 'https://i.scdn.co/x.jpg',
      tags: ['rock'], sourceUrl: 'https://open.spotify.com/album/abc', addedAt: '2026-01-01T00:00:00.000Z',
      links: { spotify: { url: 'https://open.spotify.com/album/abc', nativeUri: 'spotify:album:abc' } },
    };
    expect(parseBackup(wrap([rec])).albums[0]).toEqual(rec);
  });
});
