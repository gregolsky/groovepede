import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAlbum, parseMbRelease, resolveAlbumMusicBrainz, resolveAlbumResilient, _setThrottles, normalizeAlbumStr, spotifyAlbumMatches, searchSpotifyAlbum, fetchLastfmAlbum, fetchLastfmArtist, fetchAudiodbArtistImage, fetchDeezerArtistImage, deezerAlbumId, fetchArtistImage } from './api.js';

// ── throttle helpers ──────────────────────────────────────────────────────────

/** A no-op throttle: fires immediately, never cools down. */
const noopThrottle = () => ({ run: fn => fn(), coolingDown: () => false });
/** A cooling throttle: always reports coolingDown, but still executes run(fn). */
const coolingThrottle = () => ({ run: fn => fn(), coolingDown: () => true });

/** Reset throttles to no-op before each test so pacing doesn't bleed between tests. */
function resetThrottles() {
  _setThrottles({
    odesli:      noopThrottle(),
    musicbrainz: noopThrottle(),
    lastfm:      noopThrottle(),
    spotify:     noopThrottle(),
    audiodb:     noopThrottle(),
    deezer:      noopThrottle(),
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────────

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

  it('initialises tags as empty array and firstTrackUri as null', () => {
    const rec = parseMbRelease(MB_RESPONSE, 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', 'spotify');
    expect(rec.tags).toEqual([]);
    expect(rec.firstTrackUri).toBeNull();
  });
});

// ── resolveAlbumMusicBrainz ───────────────────────────────────────────────────

describe('resolveAlbumMusicBrainz', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetThrottles(); });

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
  beforeEach(() => { vi.restoreAllMocks(); resetThrottles(); });

  it('returns Odesli result immediately when Odesli succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => ODESLI_RESPONSE,
    });
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(rec.title).toBe('OK Computer');
    expect(rec._error).toBeUndefined();
  });

  it('MusicBrainz is not called when Odesli succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ODESLI_RESPONSE });
    await resolveAlbumResilient('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to MusicBrainz when Odesli returns any error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // Odesli error
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // MB success
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
    expect(rec.id).toMatch(/^mb:/);
  });

  it('falls back to MusicBrainz when Odesli 429s', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }); // Odesli 429
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // MB success
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
  });

  it('skips Odesli and goes straight to MusicBrainz when Odesli is cooling down', async () => {
    _setThrottles({ odesli: coolingThrottle() });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => MB_RESPONSE }); // only MB is called
    const rec = await resolveAlbumResilient('https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', { service: 'spotify' });
    expect(rec.title).toBe('Devil Is Fine');
    expect(fetchMock).toHaveBeenCalledTimes(1); // Odesli fetch never called
  });

  it('returns Odesli error when both Odesli and MusicBrainz fail', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }); // Odesli 429
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 }); // MB fails
    const rec = await resolveAlbumResilient('https://url');
    expect(rec._error).toBe(429);
  });

  it('returns synthetic 429 error when Odesli is cooling and MB also fails', async () => {
    _setThrottles({ odesli: coolingThrottle() });
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

// ── spotifyAlbumMatches ───────────────────────────────────────────────────────

describe('spotifyAlbumMatches', () => {
  const makeItem = (name, artists) => ({ name, artists: artists.map(a => ({ name: a })) });

  it('returns true for exact artist + title match', () => {
    expect(spotifyAlbumMatches(
      makeItem('Dopethrone', ['Electric Wizard']),
      'Electric Wizard', 'Dopethrone',
    )).toBe(true);
  });

  it('returns true when album has edition noise but core title matches', () => {
    expect(spotifyAlbumMatches(
      makeItem('Dopethrone (Deluxe Edition)', ['Electric Wizard']),
      'Electric Wizard', 'Dopethrone',
    )).toBe(true);
  });

  it('returns true when resolved title has edition noise', () => {
    expect(spotifyAlbumMatches(
      makeItem('Dopethrone', ['Electric Wizard']),
      'Electric Wizard', 'Dopethrone (Remastered)',
    )).toBe(true);
  });

  it('returns false when titles differ', () => {
    expect(spotifyAlbumMatches(
      makeItem('Come My Fanatics', ['Electric Wizard']),
      'Electric Wizard', 'Dopethrone',
    )).toBe(false);
  });

  it('returns false when artist does not match', () => {
    expect(spotifyAlbumMatches(
      makeItem('Dopethrone', ['Sleep']),
      'Electric Wizard', 'Dopethrone',
    )).toBe(false);
  });

  it('returns true for artist partial-overlap (e.g. feat. credits)', () => {
    expect(spotifyAlbumMatches(
      makeItem('OK Computer', ['Radiohead']),
      'Radiohead', 'OK Computer',
    )).toBe(true);
  });
});

// ── searchSpotifyAlbum ────────────────────────────────────────────────────────

describe('searchSpotifyAlbum', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetThrottles();
    // Stub localStorage so getToken() doesn't throw in the test environment
    globalThis.localStorage = { getItem: () => 'fake-token', setItem: () => {}, removeItem: () => {} };
  });

  const SEARCH_RESPONSE = {
    albums: {
      items: [{
        name: 'Dopethrone',
        uri: 'spotify:album:1AxwLCMtx8rnIxkFQKU2LO',
        external_urls: { spotify: 'https://open.spotify.com/album/1AxwLCMtx8rnIxkFQKU2LO' },
        artists: [{ name: 'Electric Wizard' }],
      }],
    },
  };

  it('returns url + nativeUri when search finds a confident match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => SEARCH_RESPONSE,
      headers: { get: () => null },
    });
    const result = await searchSpotifyAlbum('Electric Wizard', 'Dopethrone');
    expect(result).toEqual({
      url: 'https://open.spotify.com/album/1AxwLCMtx8rnIxkFQKU2LO',
      nativeUri: 'spotify:album:1AxwLCMtx8rnIxkFQKU2LO',
    });
  });

  it('returns null when no items match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ albums: { items: [] } }),
      headers: { get: () => null },
    });
    const result = await searchSpotifyAlbum('Electric Wizard', 'Dopethrone');
    expect(result).toBeNull();
  });

  it('returns null when items present but none match the title', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ albums: { items: [{ name: 'Come My Fanatics', uri: 'spotify:album:xyz', external_urls: { spotify: 'https://...' }, artists: [{ name: 'Electric Wizard' }] }] } }),
      headers: { get: () => null },
    });
    const result = await searchSpotifyAlbum('Electric Wizard', 'Dopethrone');
    expect(result).toBeNull();
  });

  it('returns null on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null } });
    const result = await searchSpotifyAlbum('Electric Wizard', 'Dopethrone');
    expect(result).toBeNull();
  });

  it('returns null when artist or title is missing', async () => {
    expect(await searchSpotifyAlbum('', 'Dopethrone')).toBeNull();
    expect(await searchSpotifyAlbum('Electric Wizard', '')).toBeNull();
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

describe('fetchDeezerArtistImage', () => {
  beforeEach(() => { resetThrottles(); vi.restoreAllMocks(); });

  it('passes albumId through and returns the resolver image', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC }));
    expect(await fetchDeezerArtistImage('Witch Club Satan', '542142182')).toBe(DZ_PIC);
    const url = spy.mock.calls[0][0];
    expect(url).toContain('/v1/artist?');
    expect(url).toContain('albumId=542142182');
  });

  it('omits albumId when there is none', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ image: DZ_PIC }));
    await fetchDeezerArtistImage('Hamulec', null);
    expect(spy.mock.calls[0][0]).not.toContain('albumId');
  });

  it('treats a Deezer placeholder as no image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      okJson({ image: 'https://cdn-images.dzcdn.net/images/artist//1000x1000.jpg' }));
    expect(await fetchDeezerArtistImage('Betwixt The Stars', null)).toBeNull();
  });

  it('surfaces 429 so the throttler can back off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false, status: 429, headers: { get: h => (h === 'retry-after' ? '12' : null) },
    });
    expect(await fetchDeezerArtistImage('X', null)).toEqual({ _error: 429, _retryAfter: 12 });
  });

  it('returns null on other errors and on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await fetchDeezerArtistImage('X', null)).toBeNull();

    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await fetchDeezerArtistImage('X', null)).toBeNull();
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
