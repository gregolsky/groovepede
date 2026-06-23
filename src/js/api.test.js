import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAlbum, backoffMs, parseMbRelease, resolveAlbumMusicBrainz, resolveAlbumResilient } from './api.js';

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

  it('returns _retryAfter when Retry-After header is present on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429,
      headers: { get: (h) => h === 'retry-after' ? '30' : null },
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result._error).toBe(429);
    expect(result._retryAfter).toBe(30);
  });
});

// ── backoffMs ─────────────────────────────────────────────────────────────────

describe('backoffMs', () => {
  it('uses Retry-After header value when present', () => {
    expect(backoffMs(20, 0)).toBe(20000);
    expect(backoffMs(60, 1)).toBe(60000);
  });
  it('falls back to capped exponential when no Retry-After', () => {
    expect(backoffMs(null, 0)).toBe(7000);
    expect(backoffMs(null, 1)).toBe(14000);
    expect(backoffMs(null, 10)).toBe(30000);  // capped at 30 s
  });
  it('treats 0 retryAfter as absent', () => {
    expect(backoffMs(0, 0)).toBe(7000);
  });
});

// ── parseMbRelease ────────────────────────────────────────────────────────────

const MB_RESPONSE = {
  resource: 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd',
  id: 'url-uuid',
  relations: [{
    'target-type': 'release',
    release: {
      id: 'ce4d1a76-7727-45d7-b61a-21a6e841e21c',
      title: 'Devil Is Fine',
      date: '2016-04-15',
      'artist-credit': [{ name: 'Zeal & Ardor' }],
    },
  }],
};

describe('parseMbRelease', () => {
  it('maps title, artist, year from MB response', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec.artist).toBe('Zeal & Ardor');
    expect(rec.year).toBe('2016');
  });

  it('sets cover to Cover Art Archive URL', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.cover).toContain('coverartarchive.org/release/ce4d1a76');
    expect(rec.cover).toContain('front-500');
  });

  it('reconstructs spotify nativeUri from sourceUrl', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.links.spotify.url).toBe('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd');
    expect(rec.links.spotify.nativeUri).toBe('spotify:album:5Oc87gybQZkVeqogIFXzMd');
  });

  it('uses mb: prefix for id', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.id).toBe('mb:ce4d1a76-7727-45d7-b61a-21a6e841e21c');
  });

  it('returns null when no release relation exists', () => {
    expect(parseMbRelease({ relations: [] }, 'url', 'spotify')).toBeNull();
    expect(parseMbRelease({}, 'url', 'spotify')).toBeNull();
  });

  it('initialises tags as empty array and firstTrackUri as null', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.tags).toEqual([]);
    expect(rec.firstTrackUri).toBeNull();
  });
});

// ── resolveAlbumMusicBrainz ───────────────────────────────────────────────────

describe('resolveAlbumMusicBrainz', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns album record on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => MB_RESPONSE,
    });
    const rec = await resolveAlbumMusicBrainz('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec._error).toBeUndefined();
  });

  it('returns { _error } on HTTP error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 503 });
    const rec = await resolveAlbumMusicBrainz('https://url', 'spotify');
    expect(rec._error).toBe(503);
  });

  it('returns { _error: "not-found" } when MB has no release relation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ({ relations: [] }),
    });
    const rec = await resolveAlbumMusicBrainz('https://url', 'spotify');
    expect(rec._error).toBe('not-found');
  });

  it('returns { _error: "network" } on fetch exception', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('net'));
    const rec = await resolveAlbumMusicBrainz('https://url', 'spotify');
    expect(rec._error).toBe('network');
  });
});

// ── resolveAlbumResilient ─────────────────────────────────────────────────────

describe('resolveAlbumResilient', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  const noSleep = async () => {};

  it('returns Odesli result immediately when successful', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ODESLI_RESPONSE,
    });
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', { sleep: noSleep });
    expect(rec.title).toBe('OK Computer');
    expect(rec._error).toBeUndefined();
  });

  it('retries on 429 and returns result on subsequent success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });  // first attempt: 429
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ODESLI_RESPONSE });  // retry: 200
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', { sleep: noSleep, maxRetries: 1 });
    expect(rec.title).toBe('OK Computer');
  });

  it('falls back to MusicBrainz after exhausting Odesli retries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    // All Odesli attempts 429, then MB succeeds
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE });
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify', sleep: noSleep, maxRetries: 1 });
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec.id).toMatch(/^mb:/);
  });

  it('returns last Odesli error when both Odesli and MusicBrainz fail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });  // Odesli 429 (only attempt)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });  // MB fails
    const rec = await resolveAlbumResilient('https://url', { sleep: noSleep, maxRetries: 0 });
    expect(rec._error).toBe(429);
  });

  it('does not retry on non-429 Odesli errors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });  // Odesli 404 — not retryable
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });  // MB also fails
    const rec = await resolveAlbumResilient('https://url', { sleep: noSleep, maxRetries: 2 });
    expect(rec._error).toBe(404);  // returns Odesli error, only 2 fetch calls total
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
