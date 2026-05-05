import { describe, it, expect } from 'vitest';
import { albumsToTrackUris, playlistTracksToAlbums, chunk } from './sync.js';

describe('albumsToTrackUris', () => {
  it('returns URIs for albums that have firstTrackUri', () => {
    const albums = [
      { id: 'a1', firstTrackUri: 'spotify:track:aaa' },
      { id: 'a2', firstTrackUri: 'spotify:track:bbb' },
    ];
    expect(albumsToTrackUris(albums)).toEqual(['spotify:track:aaa', 'spotify:track:bbb']);
  });

  it('skips albums missing firstTrackUri', () => {
    const albums = [
      { id: 'a1', firstTrackUri: 'spotify:track:aaa' },
      { id: 'a2', firstTrackUri: null },
      { id: 'a3' },
    ];
    expect(albumsToTrackUris(albums)).toEqual(['spotify:track:aaa']);
  });

  it('returns empty array for empty queue', () => {
    expect(albumsToTrackUris([])).toEqual([]);
  });
});

describe('playlistTracksToAlbums', () => {
  function makeItem(albumId, trackUri, extra = {}) {
    return {
      track: {
        uri: trackUri,
        album: {
          id: albumId,
          name: 'Album ' + albumId,
          release_date: '2023-01-01',
          external_urls: { spotify: 'https://open.spotify.com/album/' + albumId },
          images: [{ url: 'https://img/' + albumId }],
          artists: [{ id: 'artist1', name: 'Artist' }],
          ...extra,
        },
      },
    };
  }

  it('maps tracks to albums with correct shape', () => {
    const result = playlistTracksToAlbums([makeItem('alb1', 'spotify:track:t1')]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id:            'alb1',
      title:         'Album alb1',
      firstTrackUri: 'spotify:track:t1',
      year:          '2023',
      tags:          [],
    });
  });

  it('deduplicates by album id, keeping first occurrence', () => {
    const items = [
      makeItem('alb1', 'spotify:track:t1'),
      makeItem('alb1', 'spotify:track:t2'),
      makeItem('alb2', 'spotify:track:t3'),
    ];
    const result = playlistTracksToAlbums(items);
    expect(result).toHaveLength(2);
    expect(result[0].firstTrackUri).toBe('spotify:track:t1');
    expect(result[1].id).toBe('alb2');
  });

  it('preserves playlist order', () => {
    const items = [
      makeItem('z', 'spotify:track:tz'),
      makeItem('a', 'spotify:track:ta'),
    ];
    const ids = playlistTracksToAlbums(items).map(a => a.id);
    expect(ids).toEqual(['z', 'a']);
  });

  it('skips items with no track or album', () => {
    const items = [
      { track: null },
      { track: { uri: 'x', album: null } },
      makeItem('ok', 'spotify:track:tok'),
    ];
    expect(playlistTracksToAlbums(items)).toHaveLength(1);
  });

  it('returns empty array for empty items', () => {
    expect(playlistTracksToAlbums([])).toEqual([]);
  });
});

describe('chunk', () => {
  it('splits an array into chunks of given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns single chunk when array is smaller than size', () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });

  it('returns empty array for empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('handles exact multiple of size', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('handles size of 100 with 250 items', () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const chunks = chunk(arr, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
    expect(chunks[1]).toHaveLength(100);
    expect(chunks[2]).toHaveLength(50);
  });
});
