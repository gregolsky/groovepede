import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../infra/api.js', () => ({
  fetchLastfmArtist: vi.fn(),
  fetchArtistImage:  vi.fn(),
  fetchAlbumTracks:  vi.fn(),
}));

const { fetchLastfmArtist, fetchArtistImage, fetchAlbumTracks } = await import('../infra/api.js');
const { albumDetails, loadAlbumDetails, retryTracklist, forgetAlbumDetails } = await import('./album-details.js');

const ARTIST_INFO = { bio: 'b', similar: [], tags: [], lastfmUrl: null };
const FAILED = Object.freeze({ _error: 'network' });
let n = 0;
// A fresh artist + album per test: the caches are session-lifetime module state.
const album = (extra = {}) => ({ id: `id-${++n}`, artist: `Artist ${n}`, links: {}, ...extra });
const withDeezer = () => album({ links: { deezer: { url: 'https://www.deezer.com/album/302127' } } });

beforeEach(() => {
  vi.clearAllMocks();
  fetchLastfmArtist.mockResolvedValue(ARTIST_INFO);
  fetchArtistImage.mockResolvedValue(null);
  fetchAlbumTracks.mockResolvedValue([{ number: 1, name: 'Airbag' }]);
});

describe('loadAlbumDetails', () => {
  it('fetches the artist info and the Deezer tracklist, then reports the change', async () => {
    const a = withDeezer();
    const onChange = vi.fn();
    await loadAlbumDetails(a, onChange);
    const { artistCache, trackCache } = albumDetails();
    expect(artistCache[a.artist]).toMatchObject(ARTIST_INFO);
    expect(trackCache[a.id]).toEqual([{ number: 1, name: 'Airbag' }]);
    expect(fetchAlbumTracks).toHaveBeenCalledWith('302127');
    expect(onChange).toHaveBeenCalledWith(a.id);
  });

  it('marks a Deezer-less tracklist empty synchronously — before any await', () => {
    const a = album();
    loadAlbumDetails(a, () => {});
    expect(albumDetails().trackCache[a.id]).toEqual([]);
    expect(fetchAlbumTracks).not.toHaveBeenCalled();
  });

  it('does not cache a failed artist lookup, so the next load retries it', async () => {
    const a = album();
    fetchLastfmArtist.mockResolvedValueOnce(FAILED);
    await loadAlbumDetails(a, () => {});
    expect(albumDetails().artistCache[a.artist]).toBeUndefined();
    await loadAlbumDetails(a, () => {});
    expect(fetchLastfmArtist).toHaveBeenCalledTimes(2);
  });

  it('retries a failed tracklist on the next load, but never a successful (even empty) one', async () => {
    const a = withDeezer();
    fetchAlbumTracks.mockResolvedValueOnce(FAILED).mockResolvedValueOnce([]);
    await loadAlbumDetails(a, () => {});
    await loadAlbumDetails(a, () => {});
    await loadAlbumDetails(a, () => {});
    expect(fetchAlbumTracks).toHaveBeenCalledTimes(2);
    expect(albumDetails().trackCache[a.id]).toEqual([]);
  });

  it('adds the artist photo when one turns up', async () => {
    const a = album();
    fetchArtistImage.mockResolvedValueOnce('https://img/x.jpg');
    const onChange = vi.fn();
    await loadAlbumDetails(a, onChange);
    expect(albumDetails().artistCache[a.artist].image).toBe('https://img/x.jpg');
    expect(onChange).toHaveBeenCalledTimes(2); // Last.fm data, then the photo
  });
});

describe('retryTracklist', () => {
  it('shows loading again, then the refetched tracklist', async () => {
    const a = withDeezer();
    fetchAlbumTracks.mockResolvedValueOnce(FAILED);
    await loadAlbumDetails(a, () => {});
    const seen = [];
    retryTracklist(a, id => seen.push(albumDetails().trackCache[id]));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([undefined, [{ number: 1, name: 'Airbag' }]]);
  });
});

describe('forgetAlbumDetails', () => {
  it('drops the artist and tracklist so the next load refetches both', async () => {
    const a = withDeezer();
    await loadAlbumDetails(a, () => {});
    forgetAlbumDetails(a);
    expect(albumDetails().artistCache[a.artist]).toBeUndefined();
    expect(albumDetails().trackCache[a.id]).toBeUndefined();
  });
});
