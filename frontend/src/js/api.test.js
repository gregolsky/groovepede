import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAlbum, parseMbRelease, resolveAlbumMusicBrainz, resolveAlbumResilient, _setThrottles, normalizeAlbumStr, fetchLastfmAlbum, fetchLastfmArtist, fetchAudiodbArtistImage, fetchDeezerArtistData, fetchAlbumTracks, TRACKS_ERROR, deezerAlbumId, fetchArtistImage, enrichWithLastfm, cleanTags } from './api.js';
import { _resetBeaconState } from './beacon.js';
import { loadAlbums } from './storage.js';

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

describe('resolveAlbum', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
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

describe('cleanTags', () => {
  const tag = (name) => ({ name });

  it('lowercases tag names', () => {
    expect(cleanTags([tag('Post-Rock')])).toEqual(['post-rock']);
  });

  it('drops 4-digit year and 2-digit decade tags', () => {
    expect(cleanTags([tag('1990'), tag('1990s'), tag('90s'), tag('shoegaze')])).toEqual(['shoegaze']);
  });

  it('drops known junk tags', () => {
    expect(cleanTags([tag('seen live'), tag('vinyl'), tag('awesome'), tag('ambient')])).toEqual(['ambient']);
  });

  it('canonicalizes near-duplicate spellings and dedupes the result', () => {
    expect(cleanTags([tag('hip hop'), tag('hiphop'), tag('HIP-HOP')])).toEqual(['hip-hop']);
  });

  it('drops a tag matching the artist name, case-insensitively', () => {
    expect(cleanTags([tag('Mogwai'), tag('post-rock')], 'mogwai')).toEqual(['post-rock']);
  });

  it('keeps tags unrelated to the artist name', () => {
    expect(cleanTags([tag('post-rock')], 'Mogwai')).toEqual(['post-rock']);
  });

  it('drops tags outside the length bounds', () => {
    expect(cleanTags([tag('a'), tag('x'.repeat(26)), tag('drone')])).toEqual(['drone']);
  });

  it('returns an empty array for an empty input', () => {
    expect(cleanTags([])).toEqual([]);
  });
});

// ── enrichWithLastfm ────────────────────────────────────────────────────────────

describe('enrichWithLastfm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
    vi.stubGlobal('localStorage', {
      _store: {},
      getItem(k) { return this._store[k] ?? null; },
      setItem(k, v) { this._store[k] = v; },
      removeItem(k) { delete this._store[k]; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockFetchSequence(responses) {
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => responses[i++] })
    );
  }

  function seedAlbum(id) {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id, sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: [], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
  }

  it('merges artist tags before album tags, dropping duplicates from the album side', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }, { name: 'ambient', count: 8 }] } }, // artist.gettoptags
      { album: { tags: { tag: [{ name: 'ambient' }, { name: 'drone' }] } } },                  // album.getinfo
    ]);
    const onUpdate = vi.fn();
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer', onUpdate);
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'ambient', 'drone']);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('preserves the album\'s existing resolver-supplied tags, merging Last.fm tags on top instead of overwriting them', async () => {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id: 'album-1', sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: ['Alternative'], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [{ name: 'ambient' }] } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['Alternative', 'post-rock', 'ambient']);
  });

  it('does not duplicate an existing resolver-supplied tag that Last.fm also returns', async () => {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id: 'album-1', sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: ['post-rock'], addedAt: '2024-01-01T00:00:00.000Z', links: {},
    }]));
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [{ name: 'ambient' }] } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'ambient']);
  });

  it('caps merged tags at 7', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [1, 2, 3, 4, 5].map(n => ({ name: `artist-tag-${n}`, count: 10 })) } },
      { album: { tags: { tag: [1, 2, 3, 4, 5].map(n => ({ name: `album-tag-${n}` })) } } },
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toHaveLength(7);
    expect(album.tags).toEqual(['artist-tag-1', 'artist-tag-2', 'artist-tag-3', 'artist-tag-4', 'artist-tag-5', 'album-tag-1', 'album-tag-2']);
  });

  it('falls back to similar-artist tags when artist and album sources return nothing', async () => {
    seedAlbum('album-1');
    mockFetchSequence([
      { toptags: { tag: [] } },                                                    // artist.gettoptags — empty
      { album: { tags: {} } },                                                     // album.getinfo — empty
      { similarartists: { artist: [{ name: 'Sim1' }, { name: 'Sim2' }] } },        // artist.getsimilar
      { toptags: { tag: [{ name: 'shoegaze', count: 20 }] } },                     // Sim1 toptags
      { toptags: { tag: [{ name: 'shoegaze', count: 20 }] } },                     // Sim2 toptags
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toContain('shoegaze');
  });

  function seedAlbumWithDeezerLink(id) {
    localStorage.setItem('gp_albums', JSON.stringify([{
      id, sourceUrl: 'https://open.spotify.com/album/x', title: 'OK Computer', artist: 'Radiohead',
      cover: null, year: null, tags: [], addedAt: '2024-01-01T00:00:00.000Z',
      links: { deezer: { url: 'https://www.deezer.com/album/302127', nativeUri: null } },
    }]));
  }

  it('fills in with Deezer genres when Last.fm returns fewer than 3 tags', async () => {
    seedAlbumWithDeezerLink('album-1');
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } }, // artist.gettoptags — 1 tag
      { album: { tags: { tag: [] } } },                          // album.getinfo — empty
      { image: null, genres: ['Rock', 'Alternative'] },          // resolver /v1/artist
    ]);
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock', 'rock', 'alternative']);
  });

  it('does not query Deezer when Last.fm is thin but the album has no Deezer link', async () => {
    seedAlbum('album-1'); // no links.deezer
    let calls = 0;
    const responses = [
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [] } } },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = responses[calls++];
      return Promise.resolve({ ok: true, json: async () => body });
    });
    await enrichWithLastfm('album-1', 'Radiohead', 'OK Computer');
    expect(calls).toBe(2);
    const album = loadAlbums().find(a => a.id === 'album-1');
    expect(album.tags).toEqual(['post-rock']);
  });

  it('returns early without fetching when artistName is falsy', async () => {
    seedAlbum('album-1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onUpdate = vi.fn();
    await enrichWithLastfm('album-1', '', 'OK Computer', onUpdate);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not write or call onUpdate when the album id is not in storage', async () => {
    // No seedAlbum() — storage is empty.
    mockFetchSequence([
      { toptags: { tag: [{ name: 'post-rock', count: 10 }] } },
      { album: { tags: { tag: [] } } },
    ]);
    const onUpdate = vi.fn();
    await enrichWithLastfm('missing-id', 'Radiohead', 'OK Computer', onUpdate);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(loadAlbums()).toEqual([]);
  });
});

// ── artist images ─────────────────────────────────────────────────────────────

const DZ_PIC = 'https://cdn-images.dzcdn.net/images/artist/09bbbb9b4f4cab65db1e69a7d4005aec/1000x1000-000000-80-0-0.jpg';
const ADB_PIC = 'https://r2.theaudiodb.com/images/media/artist/thumb/blzer-566becc4435d3.jpg';

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

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

  it('returns null when the API has no artists or errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ artists: null }));
    expect(await fetchAudiodbArtistImage('Nobody')).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await fetchAudiodbArtistImage('Nobody')).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchAudiodbArtistImage('Nobody')).toBeNull();
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

  it('returns null on other errors and on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await fetchDeezerArtistData('X', null)).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchDeezerArtistData('X', null)).toBeNull();
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
  // ({_error:429,...} or []) stored directly in app.js's trackCache, where
  // its truthiness permanently blocked any retry for the rest of the
  // session — see app.js's prefetchExplore. TRACKS_ERROR is the one shape
  // every failure now collapses to, so callers can retry on it uniformly.
  it('collapses a 429 into TRACKS_ERROR (the throttle itself still sees the raw marker to back off)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '12' : null) },
    });
    expect(await fetchAlbumTracks('302127')).toBe(TRACKS_ERROR);
  });

  it('collapses other HTTP errors and network failures into TRACKS_ERROR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 422 });
    expect(await fetchAlbumTracks('302127')).toBe(TRACKS_ERROR);

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchAlbumTracks('302127')).toBe(TRACKS_ERROR);
  });

  it('fails fast to TRACKS_ERROR when the shared deezer throttle is cooling down, without calling fetch', async () => {
    _setThrottles({ deezer: coolingThrottle() });
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchAlbumTracks('302127')).toBe(TRACKS_ERROR);
    expect(spy).not.toHaveBeenCalled();
  });

  it('aborts and returns TRACKS_ERROR if the request takes too long', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const promise = fetchAlbumTracks('302127');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(TRACKS_ERROR);
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
});
