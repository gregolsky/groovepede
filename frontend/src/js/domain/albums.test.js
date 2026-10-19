import { describe, it, expect } from 'vitest';
import { canonicalAlbumId, filterAlbums, isRetryableResolveError, makePendingRecord, mergeRefreshedAlbum, needsTagEnrichment, upgradeAlbumRecord, deezerAlbumId } from './albums.js';

describe('filterAlbums', () => {
  const albums = [
    { id: '1', title: 'Kind of Blue', artist: 'Miles Davis',    tags: ['jazz', 'classic'] },
    { id: '2', title: 'Blue Lines',   artist: 'Massive Attack', tags: ['trip hop'] },
    { id: '3', title: 'Nevermind',    artist: 'Nirvana',        tags: ['grunge', 'classic'] },
    { id: '4', title: 'Untagged',     artist: 'Nobody' },  // no tags key at all
  ];
  const ids = list => list.map(a => a.id);

  it("returns everything for the 'all' filter and an empty query", () => {
    expect(ids(filterAlbums(albums, 'all', ''))).toEqual(['1', '2', '3', '4']);
  });

  it('filters by tag', () => {
    expect(ids(filterAlbums(albums, 'classic', ''))).toEqual(['1', '3']);
  });

  it('treats a missing tags key as no tags rather than throwing', () => {
    expect(ids(filterAlbums(albums, 'jazz', ''))).toEqual(['1']);
  });

  it('searches title and artist case-insensitively', () => {
    expect(ids(filterAlbums(albums, 'all', 'blue'))).toEqual(['1', '2']);   // title matches
    expect(ids(filterAlbums(albums, 'all', 'NIRVANA'))).toEqual(['3']);     // artist matches
  });

  it('applies tag filter and search together', () => {
    expect(ids(filterAlbums(albums, 'classic', 'blue'))).toEqual(['1']);
  });

  it('ignores a whitespace-only query', () => {
    expect(ids(filterAlbums(albums, 'all', '   '))).toEqual(['1', '2', '3', '4']);
  });

  it('tolerates an undefined query', () => {
    expect(ids(filterAlbums(albums, 'all', undefined))).toEqual(['1', '2', '3', '4']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterAlbums(albums, 'all', 'zzzz')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const copy = albums.slice();
    filterAlbums(albums, 'classic', 'blue');
    expect(albums).toEqual(copy);
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

describe('canonicalAlbumId', () => {
  it('maps every legacy Spotify id shape to spotify:<id>', () => {
    expect(canonicalAlbumId('65mmHlZPWc1L3wkfWzG0n9')).toBe('spotify:65mmHlZPWc1L3wkfWzG0n9');
    expect(canonicalAlbumId('SPOTIFY_ALBUM::4D18mfFBl73AN5URPMV083')).toBe('spotify:4D18mfFBl73AN5URPMV083');
    expect(canonicalAlbumId('spotify:0KujZH5TNJs8KcFNvkvahF')).toBe('spotify:0KujZH5TNJs8KcFNvkvahF');
  });

  it('leaves every other id alone', () => {
    for (const id of ['mb:9d7b0c1a', 'apple:1097861328', 'deezer:302127', 'pending:https://open.spotify.com/album/x', null]) {
      expect(canonicalAlbumId(id)).toBe(id);
    }
  });
});

describe('mergeRefreshedAlbum', () => {
  const existing = {
    id: 'SPOTIFY_ALBUM::abc',
    sourceUrl: 'https://open.spotify.com/album/abc',
    service: 'spotify',
    title: 'Old Title',
    artist: 'Old Artist',
    cover: 'https://example.com/old.jpg',
    year: '2020',
    tags: ['jazz', 'blues'],
    links: { spotify: { url: 'https://open.spotify.com/album/abc', nativeUri: 'spotify:album:abc' } },
    firstTrackUri: 'spotify:track:old',
    addedAt: '2024-01-01T00:00:00.000Z',
  };
  const resolved = {
    id: 'SPOTIFY_ALBUM::abc',
    title: 'New Title',
    artist: 'New Artist',
    cover: 'https://example.com/new.jpg',
    year: '2024',
    links: { spotify: { url: 'https://open.spotify.com/album/abc', nativeUri: 'spotify:album:abc' }, apple: { url: 'https://music.apple.com/album/abc' } },
  };

  it('overwrites title, artist, cover, year', () => {
    const merged = mergeRefreshedAlbum(existing, resolved);
    expect(merged.title).toBe('New Title');
    expect(merged.artist).toBe('New Artist');
    expect(merged.cover).toBe('https://example.com/new.jpg');
    expect(merged.year).toBe('2024');
  });

  it('merges links (adds new platforms, keeps existing)', () => {
    const merged = mergeRefreshedAlbum(existing, resolved);
    expect(merged.links.spotify.url).toBe('https://open.spotify.com/album/abc');
    expect(merged.links.apple.url).toBe('https://music.apple.com/album/abc');
  });

  it('preserves identity: id, sourceUrl, addedAt', () => {
    const merged = mergeRefreshedAlbum(existing, resolved);
    expect(merged.id).toBe(existing.id);
    expect(merged.sourceUrl).toBe(existing.sourceUrl);
    expect(merged.addedAt).toBe(existing.addedAt);
  });

  it('preserves user data: tags and firstTrackUri', () => {
    const merged = mergeRefreshedAlbum(existing, resolved);
    expect(merged.tags).toEqual(['jazz', 'blues']);
    expect(merged.firstTrackUri).toBe('spotify:track:old');
  });

  it('null fields in resolved fall back to existing value', () => {
    const sparse = { ...resolved, cover: null, year: null };
    const merged = mergeRefreshedAlbum(existing, sparse);
    expect(merged.cover).toBe('https://example.com/old.jpg');
    expect(merged.year).toBe('2020');
  });
});

describe('makePendingRecord', () => {
  it('has _pending: true', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(rec._pending).toBe(true);
  });

  it('sets id to pending:<url>', () => {
    const url = 'https://music.apple.com/album/abc';
    const rec = makePendingRecord(url, 'apple');
    expect(rec.id).toBe('pending:' + url);
  });

  it('stores sourceUrl', () => {
    const url = 'https://tidal.com/album/12345';
    const rec = makePendingRecord(url, 'tidal');
    expect(rec.sourceUrl).toBe(url);
  });

  it('stores service', () => {
    const rec = makePendingRecord('https://tidal.com/album/12345', 'tidal');
    expect(rec.service).toBe('tidal');
  });

  it('has empty links object (not null)', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(rec.links).toEqual({});
  });

  it('has null title, artist, cover, year', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(rec.title).toBeNull();
    expect(rec.artist).toBeNull();
    expect(rec.cover).toBeNull();
    expect(rec.year).toBeNull();
  });

  it('has empty tags array', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(rec.tags).toEqual([]);
  });

  it('has an addedAt ISO string', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(typeof rec.addedAt).toBe('string');
    expect(() => new Date(rec.addedAt)).not.toThrow();
  });

  it('upgradeAlbumRecord leaves it untouched (links already present)', () => {
    const rec = makePendingRecord('https://music.apple.com/album/abc', 'apple');
    expect(upgradeAlbumRecord({ ...rec })).toEqual(rec);
  });
});

// ── isRetryableResolveError ───────────────────────────────────────────────────

describe('isRetryableResolveError', () => {
  it('returns true for network error', () => {
    expect(isRetryableResolveError('network')).toBe(true);
  });
  it('returns true for 429 rate-limit', () => {
    expect(isRetryableResolveError(429)).toBe(true);
  });
  it('returns true for 500 server error', () => {
    expect(isRetryableResolveError(500)).toBe(true);
  });
  it('returns true for 503', () => {
    expect(isRetryableResolveError(503)).toBe(true);
  });
  it('returns false for 404 (no match — retrying is pointless)', () => {
    expect(isRetryableResolveError(404)).toBe(false);
  });
  it('returns false for 400 (bad request)', () => {
    expect(isRetryableResolveError(400)).toBe(false);
  });
  it('returns false for 401', () => {
    expect(isRetryableResolveError(401)).toBe(false);
  });
  it('returns false for unknown string', () => {
    expect(isRetryableResolveError('unknown')).toBe(false);
  });
});

describe('needsTagEnrichment', () => {
  const NOW = Date.parse('2026-10-18T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const album = (extra = {}) => ({ id: 'a', title: 'T', artist: 'A', tags: [], ...extra });

  it('wants enrichment for an untagged, never-checked album', () => {
    expect(needsTagEnrichment(album(), NOW)).toBe(true);
  });

  it('treats year-only tags as no tags', () => {
    expect(needsTagEnrichment(album({ tags: ['1997', '1990s'] }), NOW)).toBe(true);
    expect(needsTagEnrichment(album({ tags: ['1997', 'shoegaze'] }), NOW)).toBe(false);
  });

  it('skips an album Last.fm was asked about recently, rechecking after 30 days', () => {
    const at = d => new Date(NOW - d * DAY).toISOString();
    expect(needsTagEnrichment(album({ tagsCheckedAt: at(2) }), NOW)).toBe(false);
    expect(needsTagEnrichment(album({ tagsCheckedAt: at(31) }), NOW)).toBe(true);
  });

  it('counts a garbage or future stamp (e.g. from an imported backup) as never checked', () => {
    expect(needsTagEnrichment(album({ tagsCheckedAt: 'yesterday' }), NOW)).toBe(true);
    expect(needsTagEnrichment(album({ tagsCheckedAt: '9999-01-01T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('never wants enrichment without both artist and title to look up', () => {
    expect(needsTagEnrichment(album({ artist: null }), NOW)).toBe(false);
    expect(needsTagEnrichment(album({ title: null }), NOW)).toBe(false);
  });
});

describe('deezerAlbumId', () => {
  it('extracts the numeric id from a deezer album link', () => {
    const album = { links: { deezer: { url: 'https://www.deezer.com/album/542142182' } } };
    expect(deezerAlbumId(album)).toBe('542142182');
  });

  it('handles localised deezer paths', () => {
    const album = { links: { deezer: { url: 'https://www.deezer.com/en/album/302127' } } };
    expect(deezerAlbumId(album)).toBe('302127');
  });

  it('returns null when there is no deezer link', () => {
    expect(deezerAlbumId({ links: { spotify: { url: 'x' } } })).toBeNull();
    expect(deezerAlbumId({})).toBeNull();
    expect(deezerAlbumId(null)).toBeNull();
  });
});
