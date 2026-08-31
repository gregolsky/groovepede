/**
 * Tests for resolver-core.mjs — run with: node --test
 * (Uses the built-in node:test runner; no external deps.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

// A throwaway ECDSA P-256 key pair; publish the public half via GP_PUBLIC_KEY
// BEFORE importing the module under test (the key is read lazily on first use).
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.GP_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const core = await import('./resolver-core.mjs');
const {
  albumRequest, verifyToken, normalizeUrl, corsHeaders, _resetPublicKey,
  artistRequest, normalizeArtist, normalizeAlbumTitle, isBlankArtistImage, pickArtistImage,
  _resetSpotifyToken, SERVICE_HOSTS, EXTRACTORS,
} = core;
_resetPublicKey(); // ensure the test key is the one loaded

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

function makeToken(url, ts = Math.floor(Date.now() / 1000)) {
  const sig = cryptoSign('sha256', Buffer.from(`${ts}\n${url}`), {
    key: privateKey, dsaEncoding: 'ieee-p1363',
  });
  return `${ts}.${b64url(sig)}`;
}

const SPOTIFY = 'https://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp';

// ── verifyToken ─────────────────────────────────────────────────────────────

test('verifyToken: valid signed token passes', () => {
  assert.equal(verifyToken(makeToken(SPOTIFY), SPOTIFY), true);
});

test('verifyToken: expired timestamp is rejected', () => {
  const old = Math.floor(Date.now() / 1000) - 301; // just past the 300s window
  assert.equal(verifyToken(makeToken(SPOTIFY, old), SPOTIFY), false);
});

test('verifyToken: tampered signature is rejected', () => {
  const t = makeToken(SPOTIFY);
  const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyToken(tampered, SPOTIFY), false);
});

test('verifyToken: signature bound to a different url is rejected', () => {
  const other = 'https://open.spotify.com/album/DIFFERENTIDDIFFERENTID00';
  assert.equal(verifyToken(makeToken(other), SPOTIFY), false);
});

test('verifyToken: malformed token (no dot) is rejected', () => {
  assert.equal(verifyToken('not-a-token', SPOTIFY), false);
});

// ── normalizeUrl ────────────────────────────────────────────────────────────

test('normalizeUrl strips si and utm_* but keeps other params', () => {
  const got = normalizeUrl('https://open.spotify.com/album/abc?si=xyz&utm_source=share&x=1');
  assert.equal(got, 'https://open.spotify.com/album/abc?x=1');
});

// ── corsHeaders ─────────────────────────────────────────────────────────────

test('corsHeaders returns ACAO for an allowed origin', () => {
  const h = corsHeaders('https://groovepede.gregolsky.pl');
  assert.equal(h['access-control-allow-origin'], 'https://groovepede.gregolsky.pl');
});

test('corsHeaders returns {} for an unknown origin', () => {
  assert.deepEqual(corsHeaders('https://evil.example'), {});
});

// ── normalizeArtist / normalizeAlbumTitle ───────────────────────────────────

test('normalizeArtist folds diacritics, case and punctuation', () => {
  assert.equal(normalizeArtist('Bölzer'), 'bolzer');
  assert.equal(normalizeArtist('Zeal & Ardor'), 'zeal ardor');
});

test('normalizeAlbumTitle strips edition/reissue qualifiers', () => {
  assert.equal(normalizeAlbumTitle('Dopethrone (Deluxe Edition)'), 'dopethrone');
  assert.equal(normalizeAlbumTitle('Nevermind - Remastered'), 'nevermind');
  assert.equal(normalizeAlbumTitle('OK Computer'), 'ok computer');
});

test('every SERVICE_HOSTS value has a matching EXTRACTORS entry (catches drift automatically)', () => {
  const services = new Set(SERVICE_HOSTS.values());
  assert.ok(services.size > 0);
  for (const service of services) {
    assert.equal(typeof EXTRACTORS[service], 'function', `no extractor registered for service "${service}"`);
  }
});

// ── albumRequest ────────────────────────────────────────────────────────────

const noCache = { get: async () => null, put: async () => {} };
const failFetch = () => { throw new Error('fetch should not be called'); };

const okText = (text) => ({ ok: true, status: 200, text: async () => text, body: null });
const noMatch = { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }), body: null };

// A minimal Spotify /embed/album/<id> page — the real one is a full Next.js
// document; only the __NEXT_DATA__ script tag is load-bearing here.
function spotifyEmbedPage({ title = 'Global Warming', artist = 'Pitbull', releaseDate = '2012-11-16' } = {}) {
  const blob = { props: { pageProps: { state: { data: { entity: {
    title, subtitle: artist, releaseDate,
    visualIdentity: { image: [
      { url: 'https://i.scdn.co/image/small.jpg', maxWidth: 300 },
      { url: 'https://i.scdn.co/image/big.jpg', maxWidth: 640 },
    ] },
  } } } } } };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(blob)}</script></body></html>`;
}

test('albumRequest: OPTIONS preflight → 204 with CORS', async () => {
  const r = await albumRequest({
    method: 'OPTIONS', origin: 'https://groovepede.gregolsky.pl',
    url: SPOTIFY, token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://groovepede.gregolsky.pl');
});

test('albumRequest: missing/invalid token → 403', async () => {
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.body, { _error: 'forbidden' });
});

test('albumRequest: unsupported host → 400 (even with a valid token)', async () => {
  const bad = 'https://evil.example/album/1';
  const r = await albumRequest({
    method: 'GET', origin: '', url: bad,
    token: makeToken(bad), cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body, { _error: 'unsupported url' });
});

test('albumRequest: Amazon Music and SoundCloud are not in the host allowlist', async () => {
  for (const bad of ['https://music.amazon.com/albums/B08XYZ1234', 'https://soundcloud.com/artist/sets/album']) {
    const r = await albumRequest({
      method: 'GET', origin: '', url: bad,
      token: makeToken(bad), cache: noCache, fetchImpl: failFetch,
    });
    assert.equal(r.statusCode, 400, bad);
  }
});

test('albumRequest: cache hit returns cached body, no upstream fetch', async () => {
  const cached = { id: 'spotify:abc', service: 'spotify', title: 'X', artist: 'Y', links: {} };
  const cache = { get: async () => cached, put: async () => { throw new Error('no put on hit'); } };
  const r = await albumRequest({
    method: 'GET', origin: 'https://groovepede.gregolsky.pl', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, cached);
});

test('albumRequest: cache miss extracts from Spotify embed, cross-links Deezer + Apple, caches', async () => {
  let putKey = null, putBody = null;
  const cache = { get: async () => null, put: async (k, b) => { putKey = k; putBody = b; } };
  const fetchImpl = async (url) => {
    if (url.includes('open.spotify.com/embed/')) return okText(spotifyEmbedPage());
    if (url.includes('api.deezer.com/search/album')) {
      return okText(JSON.stringify({ data: [{ id: 302, title: 'Global Warming', link: 'https://www.deezer.com/album/302', artist: { name: 'Pitbull' } }] }));
    }
    if (url.includes('itunes.apple.com/search')) {
      return okText(JSON.stringify({ results: [{ artistName: 'Pitbull', collectionName: 'Global Warming', collectionViewUrl: 'https://music.apple.com/us/album/global-warming/999' }] }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: 'https://groovepede.gregolsky.pl', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'Global Warming');
  assert.equal(r.body.artist, 'Pitbull');
  assert.equal(r.body.year, '2012');
  assert.equal(r.body.cover, 'https://i.scdn.co/image/big.jpg'); // largest image wins
  assert.equal(r.body.id, 'spotify:0c0hlchA9Q66PcL7xlPPfp');
  assert.equal(r.body.links.spotify.url, SPOTIFY);
  assert.equal(r.body.links.spotify.nativeUri, 'spotify:album:0c0hlchA9Q66PcL7xlPPfp');
  assert.equal(r.body.links.deezer.url, 'https://www.deezer.com/album/302');
  assert.equal(r.body.links.apple.url, 'https://music.apple.com/us/album/global-warming/999');
  assert.equal(putKey, 'album:v1:' + normalizeUrl(SPOTIFY));
  assert.equal(putBody.title, 'Global Warming');
});

test('albumRequest: cross-linking is skipped for the source service itself', async () => {
  const DEEZER_URL = 'https://www.deezer.com/album/302127';
  let deezerSearchCalled = false;
  const fetchImpl = async (url) => {
    if (url.includes('api.deezer.com/album/302127')) {
      return okText(JSON.stringify({ title: 'Discovery', artist: { name: 'Daft Punk' }, cover_xl: 'https://cdn/cover.jpg', release_date: '2001-03-07', genres: { data: [{ name: 'Dance' }] } }));
    }
    if (url.includes('api.deezer.com/search/album')) { deezerSearchCalled = true; return noMatch; }
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'Discovery');
  assert.equal(r.body.tags[0], 'Dance');
  assert.equal(r.body.links.deezer.url, DEEZER_URL); // the source link, not a cross-link
  assert.equal(deezerSearchCalled, false); // never asked Deezer to cross-link to itself
});

test('albumRequest: cross-link rejects a real but wrong candidate — strict match, not "any result"', async () => {
  // Deezer/iTunes search is fuzzy and can return a plausible-looking but wrong
  // hit (different artist, or a same-named album by someone else). Only an
  // exact normalised artist+title match should be accepted — a non-empty but
  // wrong result set must behave the same as no match at all.
  const fetchImpl = async (url) => {
    if (url.includes('open.spotify.com/embed/')) return okText(spotifyEmbedPage());
    if (url.includes('api.deezer.com/search/album')) {
      return okText(JSON.stringify({ data: [
        { id: 1, title: 'Global Warming', link: 'https://www.deezer.com/album/1', artist: { name: 'Some Other Artist' } },
      ] }));
    }
    if (url.includes('itunes.apple.com/search')) {
      return okText(JSON.stringify({ results: [
        { artistName: 'Pitbull', collectionName: 'A Completely Different Album', collectionViewUrl: 'https://music.apple.com/us/album/different/1' },
      ] }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.links.deezer, undefined);
  assert.equal(r.body.links.apple, undefined);
});

test('albumRequest: cross-linking failure is non-fatal — record still returns', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('open.spotify.com/embed/')) return okText(spotifyEmbedPage());
    if (url.includes('api.deezer.com/search/album')) throw new Error('deezer is down');
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'Global Warming');
  assert.equal(r.body.links.deezer, undefined);
  assert.equal(r.body.links.apple, undefined);
});

test('albumRequest: caches with a short TTL when a cross-link job actually failed (not just found nothing)', async () => {
  let putTtl = null;
  const cache = { get: async () => null, put: async (k, b, ttl) => { putTtl = ttl; } };
  const fetchImpl = async (url) => {
    if (url.includes('open.spotify.com/embed/')) return okText(spotifyEmbedPage());
    if (url.includes('api.deezer.com/search/album')) throw new Error('deezer is down');
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache, fetchImpl,
  });
  assert.equal(putTtl, core.PARTIAL_TTL_S);
});

test('albumRequest: caches with the full TTL when cross-linking simply found no match (no failure)', async () => {
  let putTtl = null;
  const cache = { get: async () => null, put: async (k, b, ttl) => { putTtl = ttl; } };
  const fetchImpl = async (url) => {
    if (url.includes('open.spotify.com/embed/')) return okText(spotifyEmbedPage());
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache, fetchImpl,
  });
  assert.equal(putTtl, core.ALBUM_TTL_S);
});

test('albumRequest: cross-link query strips embedded quotes so the Deezer field syntax is not corrupted', async () => {
  const TIDAL_URL = 'https://tidal.com/album/88888888';
  // Artist name contains a literal quote — unstripped, this would break out
  // of the artist:"..." field early and corrupt the rest of the query.
  const html = `<html><head>
    <meta property="og:title" content='Guns N" Roses - Very Special Christmas'>
  </head></html>`;
  let deezerQueryUrl = null;
  const fetchImpl = async (url) => {
    if (url === TIDAL_URL) return okText(html);
    if (url.includes('api.deezer.com/search/album')) { deezerQueryUrl = url; return noMatch; }
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: TIDAL_URL,
    token: makeToken(TIDAL_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  const decodedQuery = decodeURIComponent(new URL(deezerQueryUrl).searchParams.get('q'));
  assert.equal(decodedQuery, 'artist:"Guns N Roses" album:"Very Special Christmas"');
});

test('albumRequest: cross-link prefers a real album over a same-named single/EP when both match', async () => {
  const DEEZER_URL = 'https://www.deezer.com/album/555';
  const fetchImpl = async (url) => {
    if (url.includes('api.deezer.com/album/555')) {
      return okText(JSON.stringify({ title: 'Reputation', artist: { name: 'Taylor Swift' }, release_date: '2017-11-10' }));
    }
    if (url.includes('itunes.apple.com/search')) {
      return okText(JSON.stringify({ results: [
        { artistName: 'Taylor Swift', collectionName: 'Reputation - Single', collectionViewUrl: 'https://music.apple.com/us/album/reputation-single/1' },
        { artistName: 'Taylor Swift', collectionName: 'Reputation', collectionViewUrl: 'https://music.apple.com/us/album/reputation/2' },
      ] }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.links.apple.url, 'https://music.apple.com/us/album/reputation/2');
});

// ── Spotify Client Credentials cross-linking ────────────────────────────────

test('crossLinkSpotify: no-ops (no fetch, no error) when SPOTIFY_CLIENT_ID/SECRET are unset', async () => {
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  _resetSpotifyToken();
  const DEEZER_URL = 'https://www.deezer.com/album/302127';
  const fetchImpl = async (url) => {
    if (url.includes('api.deezer.com/album/302127')) {
      return okText(JSON.stringify({ title: 'Discovery', artist: { name: 'Daft Punk' }, release_date: '2001-03-07' }));
    }
    if (url.includes('itunes.apple.com/search')) return noMatch;
    if (url.includes('accounts.spotify.com') || url.includes('api.spotify.com')) {
      throw new Error('should never call Spotify when unconfigured: ' + url);
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.links.spotify, undefined);
});

test('crossLinkSpotify: mints a Client Credentials token and finds the album, caching the token across calls', async () => {
  process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
  process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
  _resetSpotifyToken();
  const DEEZER_URL = 'https://www.deezer.com/album/302127';
  let tokenMints = 0;
  const fetchImpl = async (url, opts) => {
    if (url.includes('api.deezer.com/album/302127')) {
      return okText(JSON.stringify({ title: 'Discovery', artist: { name: 'Daft Punk' }, release_date: '2001-03-07' }));
    }
    if (url.includes('itunes.apple.com/search')) return noMatch;
    if (url.includes('accounts.spotify.com/api/token')) {
      tokenMints++;
      assert.equal(opts.method, 'POST');
      assert.match(opts.headers.Authorization, /^Basic /);
      return okText(JSON.stringify({ access_token: 'app-token-abc', expires_in: 3600 }));
    }
    if (url.includes('api.spotify.com/v1/search')) {
      assert.equal(opts.headers.Authorization, 'Bearer app-token-abc');
      return okText(JSON.stringify({ albums: { items: [
        { name: 'Discovery', album_type: 'album', id: '2noRn2Aes5aoNVsU6iWThc',
          artists: [{ name: 'Daft Punk' }], external_urls: { spotify: 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc' } },
      ] } }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.links.spotify.url, 'https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc');
  assert.equal(r.body.links.spotify.nativeUri, 'spotify:album:2noRn2Aes5aoNVsU6iWThc');
  assert.equal(tokenMints, 1);

  // A second request should reuse the cached in-memory token, not re-mint.
  const r2 = await albumRequest({
    method: 'GET', origin: '', url: 'https://www.deezer.com/album/999999999',
    token: makeToken('https://www.deezer.com/album/999999999'), cache: noCache,
    fetchImpl: async (url, opts) => {
      if (url.includes('api.deezer.com/album/999999999')) {
        return okText(JSON.stringify({ title: 'Homework', artist: { name: 'Daft Punk' }, release_date: '1997-01-20' }));
      }
      if (url.includes('itunes.apple.com/search')) return noMatch;
      if (url.includes('api.spotify.com/v1/search')) {
        assert.equal(opts.headers.Authorization, 'Bearer app-token-abc');
        return okText(JSON.stringify({ albums: { items: [] } }));
      }
      if (url.includes('accounts.spotify.com')) throw new Error('should reuse cached token, not re-mint');
      throw new Error('unexpected fetch: ' + url);
    },
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(tokenMints, 1);

  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
  _resetSpotifyToken();
});

test('albumRequest: extraction failure (fetched fine, no album found) → 422, non-retryable', async () => {
  const fetchImpl = async () => okText('<html><body>not an album page</body></html>');
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 422);
  assert.deepEqual(r.body, { _error: 'extraction-failed' });
});

test('albumRequest: upstream 5xx is passed through as a retryable error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body, { _error: 503 });
});

test('albumRequest: upstream 429 is passed through as a retryable error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 429);
  assert.deepEqual(r.body, { _error: 429 });
});

test('albumRequest: upstream 404 is remapped to our own 422 (not passed through raw, so it never trips the 404 ban jail)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => '' });
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 422);
  assert.deepEqual(r.body, { _error: 'not-found' });
});

test('albumRequest: upstream network error → 503 network', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await albumRequest({
    method: 'GET', origin: '', url: SPOTIFY,
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body, { _error: 'network' });
});

// ── Per-service extraction (through albumRequest) ───────────────────────────

test('albumRequest: Apple — extracts via iTunes lookup, upscales artwork, keeps the genre', async () => {
  const APPLE_URL = 'https://music.apple.com/us/album/ok-computer/1097861328';
  const fetchImpl = async (url) => {
    if (url.includes('itunes.apple.com/lookup')) {
      return okText(JSON.stringify({ results: [{
        wrapperType: 'collection', collectionType: 'Album', collectionId: 1097861328,
        artistName: 'Radiohead', collectionName: 'OK Computer',
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg',
        releaseDate: '1997-05-21T00:00:00Z', primaryGenreName: 'Alternative',
      }] }));
    }
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: APPLE_URL,
    token: makeToken(APPLE_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'OK Computer');
  assert.equal(r.body.artist, 'Radiohead');
  assert.equal(r.body.year, '1997');
  assert.equal(r.body.cover, 'https://is1-ssl.mzstatic.com/image/thumb/abc/600x600bb.jpg');
  assert.deepEqual(r.body.tags, ['Alternative']);
  assert.equal(r.body.id, 'apple:1097861328');
});

test('albumRequest: Apple — numeric album title picks the LAST numeric path segment as the id', async () => {
  // "/album/1984/1440833608" — a numerically-titled album. The id must be
  // 1440833608 (the last segment), not 1984 (the title, which happens to
  // also be numeric).
  const APPLE_URL = 'https://music.apple.com/us/album/1984/1440833608';
  const fetchImpl = async (url) => {
    if (url.includes('itunes.apple.com/lookup')) {
      assert.match(url, /id=1440833608/);
      return okText(JSON.stringify({ results: [{
        wrapperType: 'collection', collectionType: 'Album', collectionId: 1440833608,
        artistName: 'David Bowie', collectionName: '1984',
      }] }));
    }
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: APPLE_URL,
    token: makeToken(APPLE_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, '1984');
  assert.equal(r.body.id, 'apple:1440833608');
});

test('albumRequest: Apple — rejects a lookup result whose collectionId does not match the requested id', async () => {
  const APPLE_URL = 'https://music.apple.com/us/album/some-album/123456';
  const fetchImpl = async (url) => {
    if (url.includes('itunes.apple.com/lookup')) {
      // iTunes /lookup can return unrelated results for a stale/bad id.
      return okText(JSON.stringify({ results: [{
        wrapperType: 'collection', collectionType: 'Album', collectionId: 999999,
        artistName: 'Someone Else', collectionName: 'Unrelated Album',
      }] }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: APPLE_URL,
    token: makeToken(APPLE_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 422);
});

test('albumRequest: Tidal — extracts artist/title from og:title, splitting on the first " - "', async () => {
  const TIDAL_URL = 'https://tidal.com/album/77640617';
  const html = `<html><head>
    <meta property="og:title" content="U2 - Achtung Baby">
    <meta property="og:image" content="https://resources.tidal.com/images/cover.jpg">
  </head></html>`;
  const fetchImpl = async (url) => {
    if (url === TIDAL_URL) return okText(html);
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: TIDAL_URL,
    token: makeToken(TIDAL_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.artist, 'U2');
  assert.equal(r.body.title, 'Achtung Baby');
  assert.equal(r.body.cover, 'https://resources.tidal.com/images/cover.jpg');
  assert.equal(r.body.id, 'tidal:77640617');
});

test('albumRequest: Tidal — og:title survives an unescaped apostrophe in the content attribute', async () => {
  // A naive [^"']* content regex truncates at the apostrophe inside "N'".
  const TIDAL_URL = 'https://tidal.com/album/11111111';
  const html = `<html><head>
    <meta property="og:title" content="Guns N' Roses - Appetite for Destruction">
    <meta property="og:image" content="https://resources.tidal.com/images/cover2.jpg">
  </head></html>`;
  const fetchImpl = async (url) => {
    if (url === TIDAL_URL) return okText(html);
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: TIDAL_URL,
    token: makeToken(TIDAL_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.artist, "Guns N' Roses");
  assert.equal(r.body.title, 'Appetite for Destruction');
});

test('albumRequest: YouTube — extracts via oEmbed, strips the " - Topic" channel suffix', async () => {
  const YT_URL = 'https://music.youtube.com/playlist?list=OLAK5uy_abc123';
  const fetchImpl = async (url) => {
    if (url.includes('youtube.com/oembed')) {
      return okText(JSON.stringify({ title: 'Global Warming', author_name: 'Pitbull - Topic', thumbnail_url: 'https://i.ytimg.com/thumb.jpg' }));
    }
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: YT_URL,
    token: makeToken(YT_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'Global Warming');
  assert.equal(r.body.artist, 'Pitbull');
  assert.equal(r.body.id, 'youtube:OLAK5uy_abc123');
});

test('albumRequest: Pandora — splits og:title on "<Title> by <Artist>"', async () => {
  const PANDORA_URL = 'https://www.pandora.com/artist/daft-punk/discovery/AL123';
  const html = `<meta property="og:title" content="Discovery by Daft Punk">`;
  const fetchImpl = async (url) => {
    if (url === PANDORA_URL) return okText(html);
    if (url.includes('api.deezer.com/search/album')) return noMatch;
    if (url.includes('itunes.apple.com/search')) return noMatch;
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: PANDORA_URL,
    token: makeToken(PANDORA_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.title, 'Discovery');
  assert.equal(r.body.artist, 'Daft Punk');
});

test('albumRequest: Deezer extraction errors when the API returns an error body (not a real album)', async () => {
  const DEEZER_URL = 'https://www.deezer.com/album/999999999';
  const fetchImpl = async (url) => {
    if (url.includes('api.deezer.com/album/999999999')) return okText(JSON.stringify({ error: { message: 'no data' } }));
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 422);
});

test('albumRequest: Deezer quota-exceeded (error.code 4) is retryable, not a permanent 422', async () => {
  const DEEZER_URL = 'https://www.deezer.com/album/1234';
  const fetchImpl = async (url) => {
    if (url.includes('api.deezer.com/album/1234')) {
      return okText(JSON.stringify({ error: { code: 4, message: 'Quota limit exceeded' } }));
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const r = await albumRequest({
    method: 'GET', origin: '', url: DEEZER_URL,
    token: makeToken(DEEZER_URL), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 429);
  assert.deepEqual(r.body, { _error: 429 });
});

// ── Artist images ───────────────────────────────────────────────────────────

const PIC = 'https://cdn-images.dzcdn.net/images/artist/09bbbb9b4f4cab65db1e69a7d4005aec/1000x1000-000000-80-0-0.jpg';

test('isBlankArtistImage: both Deezer placeholder forms are treated as absent', () => {
  // Empty id segment, and the MD5 of the empty string — both observed live.
  assert.equal(isBlankArtistImage('https://cdn-images.dzcdn.net/images/artist//1000x1000.jpg'), true);
  assert.equal(isBlankArtistImage('https://cdn-images.dzcdn.net/images/artist/d41d8cd98f00b204e9800998ecf8427e/500x500.jpg'), true);
  assert.equal(isBlankArtistImage(''), true);
  assert.equal(isBlankArtistImage(null), true);
  assert.equal(isBlankArtistImage(PIC), false);
});

test('pickArtistImage: exact normalised name match wins', () => {
  const got = pickArtistImage([{ name: 'Bölzer', picture_xl: PIC }], 'Bolzer');
  assert.equal(got, PIC);
});

test('pickArtistImage: rejects a near-miss rather than showing the wrong artist', () => {
  // Deezer's real top hit for "Black Limbo" is "Black Bomb A".
  const got = pickArtistImage([{ name: 'Black Bomb A', picture_xl: PIC }], 'Black Limbo');
  assert.equal(got, null);
});

test('pickArtistImage: match with only a placeholder image → null', () => {
  const blank = 'https://cdn-images.dzcdn.net/images/artist//1000x1000.jpg';
  const got = pickArtistImage([{ name: 'Betwixt The Stars', picture_xl: blank }], 'Betwixt The Stars');
  assert.equal(got, null);
});

const artistToken = (name, albumId = '') => makeToken(`artist:${name}|${albumId}`);

test('artistRequest: missing/invalid token → 403', async () => {
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Bölzer', albumId: '',
    token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 403);
});

test('artistRequest: token bound to a different artist is rejected', async () => {
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Bölzer', albumId: '',
    token: artistToken('Someone Else'), cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 403);
});

test('artistRequest: non-numeric albumId → 400 (never reaches the URL path)', async () => {
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Bölzer', albumId: '../../evil',
    token: artistToken('Bölzer', '../../evil'), cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body, { _error: 'bad albumId' });
});

test('artistRequest: albumId path is exact — no search call is made', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return okText(JSON.stringify({ artist: { picture_xl: PIC } }));
  };
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Witch Club Satan', albumId: '542142182',
    token: artistToken('Witch Club Satan', '542142182'), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC, genres: [] }); // response has no genres field — defaults to []
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/album\/542142182$/);
});

test('artistRequest: returns genres from the same Deezer album response used for the image', async () => {
  const fetchImpl = async () => okText(JSON.stringify(
    { artist: { picture_xl: PIC }, genres: { data: [{ name: 'Rock' }, { name: 'Alternative' }] } }
  ));
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Radiohead', albumId: '302127',
    token: artistToken('Radiohead', '302127'), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC, genres: ['Rock', 'Alternative'] });
});

test('artistRequest: falls back to strict search when the album lookup yields nothing (Stage 2 has no genres)', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/album/')) return okText(JSON.stringify({ artist: {} }));
    return okText(JSON.stringify({ data: [{ name: 'Hamulec', picture_xl: PIC }] }));
  };
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Hamulec', albumId: '1',
    token: artistToken('Hamulec', '1'), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC, genres: [] });
  assert.equal(calls.length, 2);
});

test('artistRequest: no match → image null, and the negative is cached (with empty genres)', async () => {
  let putKey = null, putBody = null;
  const cache = { get: async () => null, put: async (k, b) => { putKey = k; putBody = b; } };
  const fetchImpl = async () => okText(JSON.stringify({ data: [{ name: 'Black Bomb A', picture_xl: PIC }] }));
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Black Limbo', albumId: '',
    token: artistToken('Black Limbo'), cache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: null, genres: [] });
  assert.equal(putKey, 'artist:black limbo');
  assert.deepEqual(putBody, { image: null, genres: [] });
});

test('artistRequest: cache hit short-circuits the Deezer call, incl. a pre-genres cached entry', async () => {
  // Simulates an entry cached before the genres field existed (30-day TTL) —
  // it must be returned as-is, with no genres key, not backfilled or crashed on.
  const cache = { get: async () => ({ image: PIC }), put: async () => { throw new Error('no put on hit'); } };
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Bölzer', albumId: '',
    token: artistToken('Bölzer'), cache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC });
});

test('artistRequest: OPTIONS preflight → 204 with CORS, no token needed', async () => {
  const r = await artistRequest({
    method: 'OPTIONS', origin: 'https://groovepede.gregolsky.pl',
    name: '', albumId: '', token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://groovepede.gregolsky.pl');
});

test('artistRequest: unknown origin gets no CORS headers', async () => {
  const fetchImpl = async () => okText(JSON.stringify({ data: [] }));
  const r = await artistRequest({
    method: 'GET', origin: 'https://evil.example', name: 'Bölzer', albumId: '',
    token: artistToken('Bölzer'), cache: noCache, fetchImpl,
  });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});
