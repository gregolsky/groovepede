import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAlbum } from './api.js';

const ODESLI_RESPONSE = {
  entityUniqueId: 'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy',
  entitiesByUniqueId: {
    'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy': {
      title: 'OK Computer',
      artistName: 'Radiohead',
      thumbnailUrl: 'https://example.com/cover.jpg',
      apiProvider: 'spotify',
      type: 'album',
    },
    'ITUNES_ALBUM::1097861328': {
      title: 'OK Computer',
      artistName: 'Radiohead',
      thumbnailUrl: 'https://example.com/cover2.jpg',
      apiProvider: 'itunes',
      type: 'album',
    },
  },
  linksByPlatform: {
    spotify: {
      url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy',
      nativeAppUriMobile: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
      nativeAppUriDesktop: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
      entityUniqueId: 'SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy',
    },
    appleMusic: {
      url: 'https://music.apple.com/us/album/ok-computer/1097861328',
      nativeAppUriMobile: null,
      nativeAppUriDesktop: null,
      entityUniqueId: 'ITUNES_ALBUM::1097861328',
    },
    youtube: {
      url: 'https://www.youtube.com/playlist?list=OLAK5uy_abc',
      nativeAppUriMobile: null,
      nativeAppUriDesktop: null,
      entityUniqueId: 'YOUTUBE_ALBUM::abc',
    },
  },
};

describe('resolveAlbum', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns album record with title, artist, cover from primary entity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.title).toBe('OK Computer');
    expect(result.artist).toBe('Radiohead');
    expect(result.cover).toBe('https://example.com/cover.jpg');
    expect(result._error).toBeUndefined();
  });

  it('uses Odesli entityUniqueId as album id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.id).toBe('SPOTIFY_ALBUM::4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('populates links map from linksByPlatform', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.spotify.nativeUri).toBe('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.apple.url).toBe('https://music.apple.com/us/album/ok-computer/1097861328');
    expect(result.links.youtube.url).toBe('https://www.youtube.com/playlist?list=OLAK5uy_abc');
  });

  it('sets firstTrackUri to null (resolved by sync later)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.firstTrackUri).toBeNull();
  });

  it('sets sourceUrl to the input URL', async () => {
    const inputUrl = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum(inputUrl);
    expect(result.sourceUrl).toBe(inputUrl);
  });

  it('initializes tags as empty array and addedAt as ISO string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ODESLI_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.tags).toEqual([]);
    expect(typeof result.addedAt).toBe('string');
    expect(() => new Date(result.addedAt)).not.toThrow();
  });

  it('returns _error on 429 rate limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 429 });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result._error).toBe(429);
  });

  it('returns _error on 404 not found', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result._error).toBe(404);
  });

  it('returns _error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network failure'));
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result._error).toBeTruthy();
  });
});
