import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAlbum, parseMbRelease, resolveAlbumMusicBrainz, resolveAlbumResilient, _setThrottles, normalizeAlbumStr, fetchLastfmAlbum, fetchLastfmArtist, fetchAudiodbArtistImage, fetchDeezerArtistData, fetchAlbumTracks, fetchArtistImage, enrichWithLastfm, cleanTags } from './api.js';
import { isApiError } from '../lib/api-error.js';
import { _resetBeaconState } from './beacon.js';

// ── throttle helpers ──────────────────────────────────────────────────────────

/** A no-op throttle: fires immediately, never cools down. */
const noopThrottle = () => ({ run: fn => fn(), coolingDown: () => false });
/** A cooling throttle: always reports coolingDown, but still executes run(fn). */
const coolingThrottle = () => ({ run: fn => fn(), coolingDown: () => true });

/** Reset throttles to no-op before each test so pacing doesn't bleed between tests. */
function resetThrottles() {
  _setThrottles({
    resolver:    noopThrottle(),
    musicbrainz: noopThrottle(),
    lastfm:      noopThrottle(),
    spotify:     noopThrottle(),
    audiodb:     noopThrottle(),
    deezer:      noopThrottle(),
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────────

// Shape returned by the resolver's /v1/album (backend/resolver-core.mjs) —
// already normalized server-side, so resolveAlbum just adopts it verbatim.
const RESOLVER_RESPONSE = {
  id: 'spotify:4aawyAB9vmqN3uQ7FjRGTy',
  service: 'spotify',
  title: 'OK Computer',
  artist: 'Radiohead',
  cover: 'https://example.com/cover.jpg',
  year: '1997',
  tags: ['alternative rock'],
  links: {
    spotify: { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', nativeUri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' },
    apple:   { url: 'https://music.apple.com/us/album/ok-computer/1097861328' },
  },
};

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

// ── resolveAlbum ──────────────────────────────────────────────────────────────

/** A fetch that never answers on its own — only the caller's AbortSignal ends it. */
function stalledFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, opts = {}) => new Promise((_, reject) => {
    opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
}

describe('resolveAlbum', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
  });

  it('gives up with a retryable network error when the resolver stalls, instead of spinning forever', async () => {
    vi.useFakeTimers();
    try {
      stalledFetch();
      const p = resolveAlbum('https://open.spotify.com/album/x');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toEqual({ _error: 'network' });
    } finally { vi.useRealTimers(); }
  });

  it('returns album record with title, artist, cover, year, tags from the resolver', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.title).toBe('OK Computer');
    expect(result.artist).toBe('Radiohead');
    expect(result.cover).toBe('https://example.com/cover.jpg');
    expect(result.year).toBe('1997');
    expect(result.tags).toEqual(['alternative rock']);
    expect(result._error).toBeUndefined();
  });

  it("canonicalizes the resolver's service genre names so they match Last.fm's lowercase tags", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...RESOLVER_RESPONSE, tags: ['Pop', 'Rap/Hip Hop', 'pop', 'Radiohead'] }),
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.tags).toEqual(['pop', 'hip-hop']);
  });

  it('calls the resolver\'s /v1/album endpoint, not the retired /v1/resolve, with no userCountry param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = new URL(fetchSpy.mock.calls[0][0]);
    expect(calledUrl.pathname).toBe('/v1/album');
    expect(calledUrl.pathname).not.toBe('/v1/resolve');
    expect(calledUrl.searchParams.has('userCountry')).toBe(false);
  });

  it('uses the resolver-assigned <service>:<id> as album id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.id).toBe('spotify:4aawyAB9vmqN3uQ7FjRGTy');
  });

  it('adopts the links map from the resolver verbatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.spotify.url).toBe('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.spotify.nativeUri).toBe('spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
    expect(result.links.apple.url).toBe('https://music.apple.com/us/album/ok-computer/1097861328');
  });

  it('defaults links/tags to empty when the resolver omits them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'spotify:x', title: 'X', artist: 'Y' }),
    });
    const result = await resolveAlbum('https://open.spotify.com/album/x');
    expect(result.links).toEqual({});
    expect(result.tags).toEqual([]);
    expect(result.cover).toBeNull();
    expect(result.year).toBeNull();
  });

  it('sets sourceUrl to the input URL', async () => {
    const inputUrl = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    const result = await resolveAlbum(inputUrl);
    expect(result.sourceUrl).toBe(inputUrl);
  });

  it('sets addedAt as an ISO string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => RESOLVER_RESPONSE,
    });
    const result = await resolveAlbum('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
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

// ── parseMbRelease ────────────────────────────────────────────────────────────

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

  it('initialises tags as an empty array', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.tags).toEqual([]);
  });
});

// ── resolveAlbumMusicBrainz ───────────────────────────────────────────────────

describe('resolveAlbumMusicBrainz', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetThrottles(); });

  it('carries Retry-After on a 429, so the MusicBrainz throttle honours it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '20' : null) },
    });
    expect(await resolveAlbumMusicBrainz('https://open.spotify.com/album/x', 'spotify'))
      .toEqual({ _error: 429, _retryAfter: 20 });
  });

  it('gives up with a network error when MusicBrainz stalls', async () => {
    vi.useFakeTimers();
    try {
      stalledFetch();
      const p = resolveAlbumMusicBrainz('https://open.spotify.com/album/x', 'spotify');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await p).toEqual({ _error: 'network' });
    } finally { vi.useRealTimers(); }
  });

  it('returns album record on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE });               // /url lookup
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ genres: [] }) });          // /release genres
    const rec = await resolveAlbumMusicBrainz('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec._error).toBeUndefined();
  });

  it('attaches genres from the second /release lookup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ genres: [{ name: 'black metal' }, { name: 'avant-garde' }] }) });
    const rec = await resolveAlbumMusicBrainz('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.tags).toEqual(['black metal', 'avant-garde']);
    const genreUrl = fetchMock.mock.calls[1][0];
    expect(genreUrl).toContain('/release/ce4d1a76-7727-45d7-b61a-21a6e841e21c');
    expect(genreUrl).toContain('inc=genres');
  });

  it('degrades to empty tags (not a failed resolve) when the genre lookup fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    const rec = await resolveAlbumMusicBrainz('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec._error).toBeUndefined();
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec.tags).toEqual([]);
  });

  it('degrades to empty tags when the genre lookup throws', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const rec = await resolveAlbumMusicBrainz('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec._error).toBeUndefined();
    expect(rec.tags).toEqual([]);
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
  beforeEach(() => { vi.restoreAllMocks(); resetThrottles(); });

  it('returns the resolver result immediately when the resolver succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => RESOLVER_RESPONSE,
    });
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(rec.title).toBe('OK Computer');
    expect(rec._error).toBeUndefined();
  });

  it('MusicBrainz is not called when the resolver succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => RESOLVER_RESPONSE });
    await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to MusicBrainz when the resolver returns any error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // resolver error
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // MB success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ genres: [] }) }); // MB genres
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec.id).toMatch(/^mb:/);
  });

  it('falls back to MusicBrainz when the resolver 429s', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }); // resolver 429
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // MB success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ genres: [] }) }); // MB genres
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
  });

  it('skips the resolver and goes straight to MusicBrainz when it is cooling down', async () => {
    _setThrottles({ resolver: coolingThrottle() });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // MB lookup
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ genres: [] }) }); // MB genres
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
    expect(fetchMock).toHaveBeenCalledTimes(2); // resolver fetch never called; MB lookup + MB genres
  });

  it('returns the resolver error when both the resolver and MusicBrainz fail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }); // resolver 429
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // MB fails
    const rec = await resolveAlbumResilient('https://url');
    expect(rec._error).toBe(429);
  });

  it('returns synthetic 429 error when the resolver is cooling and MB also fails', async () => {
    _setThrottles({ resolver: coolingThrottle() });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // MB fails
    const rec = await resolveAlbumResilient('https://url');
    expect(rec._error).toBe(429); // cooling = effectively 429
  });
});

// ── normalizeAlbumStr ─────────────────────────────────────────────────────────

describe('normalizeAlbumStr', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeAlbumStr('OK Computer')).toBe('ok computer');
  });

  it('strips diacritics', () => {
    expect(normalizeAlbumStr('Björk')).toBe('bjork');
  });

  it('removes (Deluxe Edition) suffix', () => {
    expect(normalizeAlbumStr('Dopethrone (Deluxe Edition)')).toBe('dopethrone');
  });

  it('removes (Remastered) suffix', () => {
    expect(normalizeAlbumStr('Dark Side of the Moon (Remastered)')).toBe('dark side of the moon');
  });

  it('removes trailing - Remastered', () => {
    expect(normalizeAlbumStr('Nevermind - Remastered')).toBe('nevermind');
  });

  it('keeps non-Latin letters (a Latin-only filter folded them all to "")', () => {
    expect(normalizeAlbumStr('Кино')).toBe('кино');
    expect(normalizeAlbumStr('宇多田ヒカル')).not.toBe('');
    expect(normalizeAlbumStr('宇多田ヒカル')).not.toBe(normalizeAlbumStr('Кино'));
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeAlbumStr(null)).toBe('');
    expect(normalizeAlbumStr(undefined)).toBe('');
  });
});

// ── Last.fm single-element-as-object guard ────────────────────────────────────

describe('fetchLastfmAlbum — Last.fm single-object quirk', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
  });

  it('extracts tags when Last.fm returns tag as array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        album: { tags: { tag: [{ name: 'post-rock' }, { name: 'ambient' }] } },
      }),
    });
    const { tags } = await fetchLastfmAlbum('Mogwai', 'Young Team');
    expect(tags).toContain('post-rock');
    expect(tags).toContain('ambient');
  });

  it('extracts tags when Last.fm returns tag as a single object (not array)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        album: { tags: { tag: { name: 'post-rock' } } },
      }),
    });
    const { tags } = await fetchLastfmAlbum('Mogwai', 'Young Team');
    expect(tags).toContain('post-rock');
  });

  it('returns empty tags when tag field is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ album: { tags: {} } }),
    });
    const { tags } = await fetchLastfmAlbum('Unknown', 'Unknown');
    expect(tags).toEqual([]);
  });
});

describe('fetchLastfmArtist — Last.fm single-object quirk', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
  });

  function mockFetchSequence(responses) {
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => responses[i++] })
    );
  }

  it('handles similar artists as array', async () => {
    mockFetchSequence([
      { artist: { bio: { content: 'Some bio.' }, url: 'https://last.fm/music/Mogwai', toptags: { tag: [] } } },
      { similarartists: { artist: [{ name: 'Godspeed', url: 'https://last.fm/music/GY!BE' }, { name: 'Explosions', url: 'https://last.fm/music/EitS' }] } },
      { toptags: { tag: [] } },
    ]);
    const { similar } = await fetchLastfmArtist('Mogwai');
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].name).toBe('Godspeed');
  });

  it('handles similar artists as single object (not array)', async () => {
    mockFetchSequence([
      { artist: { bio: { content: 'Some bio.' }, url: 'https://last.fm/music/Mogwai', toptags: { tag: [] } } },
      { similarartists: { artist: { name: 'Godspeed', url: 'https://last.fm/music/GY!BE' } } },
      { toptags: { tag: [] } },
    ]);
    const { similar } = await fetchLastfmArtist('Mogwai');
    expect(similar).toEqual([{ name: 'Godspeed', url: 'https://last.fm/music/GY!BE' }]);
  });
});

// ── cleanTags ───────────────────────────────────────────────────────────────────

// ── enrichWithLastfm ────────────────────────────────────────────────────────────

// ── artist images ─────────────────────────────────────────────────────────────

const DZ_PIC = 'https://cdn-images.dzcdn.net/images/artist/09bbbb9b4f4cab65db1e69a7d4005aec/1000x1000-000000-80-0-0.jpg';
const ADB_PIC = 'https://r2.theaudiodb.com/images/media/artist/thumb/blzer-566becc4435d3.jpg';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

describe('fetchAudiodbArtistImage', () => {
  beforeEach(() => { resetThrottles(); vi.restoreAllMocks(); });

  it('returns the thumb for an exact (normalised) name match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Bölzer', strArtistThumb: ADB_PIC }] }));
    expect(await fetchAudiodbArtistImage('Bolzer')).toBe(ADB_PIC);
  });

  it('upgrades an http thumb to https (mixed content would be blocked)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Bölzer', strArtistThumb: ADB_PIC.replace('https:', 'http:') }] }));
    expect(await fetchAudiodbArtistImage('Bölzer')).toBe(ADB_PIC);
  });

  it('rejects a near-miss rather than returning the wrong artist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Black Bomb A', strArtistThumb: ADB_PIC }] }));
    expect(await fetchAudiodbArtistImage('Black Limbo')).toBeNull();
  });

  it('does not match a different non-Latin artist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: '宇多田ヒカル', strArtistThumb: ADB_PIC }] }));
    expect(await fetchAudiodbArtistImage('Кино')).toBeNull();
  });

  it('never matches a name that folds to nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: '???', strArtistThumb: ADB_PIC }] }));
    expect(await fetchAudiodbArtistImage('!!!')).toBeNull();
  });

  it('returns null (a real "no artists found") when the API answers with none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ artists: null }));
    expect(await fetchAudiodbArtistImage('Nobody')).toBeNull();
  });

  it('returns an ApiError, not null, on an HTTP error or network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500 });
    expect(isApiError(await fetchAudiodbArtistImage('Nobody'))).toBe(true);

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(isApiError(await fetchAudiodbArtistImage('Nobody'))).toBe(true);
  });

  it('returns null when the match has no usable image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Ghost', strArtistThumb: '' }] }));
    expect(await fetchAudiodbArtistImage('Ghost')).toBeNull();
  });
});

describe('fetchDeezerArtistData', () => {
  beforeEach(() => { resetThrottles(); vi.restoreAllMocks(); });

  it('passes albumId through and returns the resolver image', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC, genres: [] }));
    expect(await fetchDeezerArtistData('Witch Club Satan', '542142182')).toEqual({ image: DZ_PIC, genres: [] });
    const url = spy.mock.calls[0][0];
    expect(url).toContain('/v1/artist?');
    expect(url).toContain('albumId=542142182');
  });

  it('omits albumId when there is none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC, genres: [] }));
    await fetchDeezerArtistData('Hamulec', null);
    expect(spy.mock.calls[0][0]).not.toContain('albumId');
  });

  it('treats a Deezer placeholder as no image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ image: 'https://cdn-images.dzcdn.net/images/artist//1000x1000.jpg', genres: [] }));
    expect(await fetchDeezerArtistData('Betwixt The Stars', null)).toEqual({ image: null, genres: [] });
  });

  it('passes genres through when present', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC, genres: ['Rock', 'Metal'] }));
    expect(await fetchDeezerArtistData('Witch Club Satan', '542142182')).toEqual({ image: DZ_PIC, genres: ['Rock', 'Metal'] });
  });

  it('defaults genres to [] when the resolver response predates the field', async () => {
    // Simulates a pre-genres cached /v1/artist response (no `genres` key at all).
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC }));
    expect(await fetchDeezerArtistData('X', null)).toEqual({ image: DZ_PIC, genres: [] });
  });

  it('surfaces 429 so the throttler can back off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '12' : null) },
    });
    expect(await fetchDeezerArtistData('X', null)).toEqual({ _error: 429, _retryAfter: 12 });
  });

  it('returns an ApiError, not null, on other errors and on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await fetchDeezerArtistData('X', null)).toEqual({ _error: 403 });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchDeezerArtistData('X', null)).toEqual({ _error: 'network' });
  });
});

describe('fetchAlbumTracks', () => {
  beforeEach(() => { resetThrottles(); _resetBeaconState(); vi.restoreAllMocks(); });

  it('returns [] without calling fetch when albumId is missing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchAlbumTracks(null)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes albumId through and maps the resolver response', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ tracks: [{ number: 1, name: 'Airbag', duration_ms: 284000 }] }));
    expect(await fetchAlbumTracks('302127')).toEqual([{ number: 1, name: 'Airbag', duration_ms: 284000 }]);
    const url = spy.mock.calls[0][0];
    expect(url).toContain('/v1/tracks?');
    expect(url).toContain('albumId=302127');
  });

  it('defaults to [] when the response has no tracks key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({}));
    expect(await fetchAlbumTracks('302127')).toEqual([]);
  });

  // A 429 (or any other failure) used to surface as a raw marker object
  // ({_error:429,...} or []) stored directly in album-details.js's tracklist cache, where
  // its truthiness permanently blocked any retry for the rest of the
  // session — see loadAlbumDetails (services/album-details.js). An ApiError is the one shape
  // every failure now collapses to, so callers can retry on it uniformly.
  it('collapses a 429 into an ApiError (the throttle itself still sees the raw marker to back off)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '12' : null) },
    });
    expect(await fetchAlbumTracks('302127')).toEqual({ _error: 429, _retryAfter: 12 });
  });

  it('collapses other HTTP errors and network failures into an ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 422 });
    expect(await fetchAlbumTracks('302127')).toEqual({ _error: 422 });

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchAlbumTracks('302127')).toEqual({ _error: 'network' });
  });

  it('fails fast to an ApiError when the shared deezer throttle is cooling down, without calling fetch', async () => {
    _setThrottles({ deezer: coolingThrottle() });
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(isApiError(await fetchAlbumTracks('302127'))).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('aborts and returns an ApiError if the request takes too long', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const promise = fetchAlbumTracks('302127');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ _error: 'timeout' });
    vi.useRealTimers();
  });
});

describe('fetchArtistImage', () => {
  beforeEach(() => { resetThrottles(); vi.restoreAllMocks(); });

  it('uses TheAudioDB and never calls the resolver when it hits', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Chelsea Wolfe', strArtistThumb: ADB_PIC }] }));
    expect(await fetchArtistImage({ artist: 'Chelsea Wolfe' })).toBe(ADB_PIC);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Deezer resolver when TheAudioDB misses', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson({ artists: [] }))
      .mockResolvedValueOnce(okJson({ image: DZ_PIC }));
    expect(await fetchArtistImage({ artist: 'Hamulec' })).toBe(DZ_PIC);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('uses only the primary artist of a multi-artist credit', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ artists: [{ strArtist: 'Neurosis', strArtistThumb: ADB_PIC }] }));
    expect(await fetchArtistImage({ artist: 'Neurosis, Jarboe' })).toBe(ADB_PIC);
    expect(spy.mock.calls[0][0]).toContain('Neurosis');
    expect(spy.mock.calls[0][0]).not.toContain('Jarboe');
  });

  it('returns null when both sources miss', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson({ artists: [] }))
      .mockResolvedValueOnce(okJson({ image: null }));
    expect(await fetchArtistImage({ artist: 'Betwixt The Stars' })).toBeNull();
  });

  it('returns null without any network call when the album has no artist', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchArtistImage({ artist: '' })).toBeNull();
    expect(await fetchArtistImage({})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not return a 429 marker object as if it were an image url', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson({ artists: [] }))
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } });
    expect(await fetchArtistImage({ artist: 'X' })).toBeNull();
  });

  it('surfaces an ApiError only when BOTH sources fail to run, not when either just finds no image', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    expect(isApiError(await fetchArtistImage({ artist: 'X' }))).toBe(true);
  });
});

// ── ApiError (isApiError) ──────────────────────────────────────────────────────
// The one failure shape every function above returns on a transport failure —
// see api.js's apiError()/isApiError(). Exercised indirectly by every ".toEqual({
// _error: ... })" / "isApiError(...)" assertion above; this block checks the
// predicate itself against shapes a caller might plausibly compare it to.

describe('isApiError', () => {
  it('is true for a value with an _error property', () => {
    expect(isApiError({ _error: 429 })).toBe(true);
    expect(isApiError({ _error: 'network' })).toBe(true);
    expect(isApiError(Object.freeze({ _error: 500 }))).toBe(true);
  });

  it('is false for a genuine "nothing found" result, and for non-error values', () => {
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError([])).toBe(false);
    expect(isApiError('')).toBe(false);
    expect(isApiError(0)).toBe(false);
    expect(isApiError({ bio: '', similar: [], tags: [], lastfmUrl: null })).toBe(false);
  });
});
