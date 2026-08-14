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
  resolveRequest, verifyToken, normalizeUrl, corsHeaders, _resetPublicKey,
  artistRequest, normalizeArtist, isBlankArtistImage, pickArtistImage,
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

// ── resolveRequest ──────────────────────────────────────────────────────────

const noCache = { get: async () => null, put: async () => {} };
const failFetch = () => { throw new Error('fetch should not be called'); };

test('resolveRequest: OPTIONS preflight → 204 with CORS', async () => {
  const r = await resolveRequest({
    method: 'OPTIONS', origin: 'https://groovepede.gregolsky.pl',
    url: SPOTIFY, cc: 'US', token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'https://groovepede.gregolsky.pl');
});

test('resolveRequest: missing/invalid token → 403', async () => {
  const r = await resolveRequest({
    method: 'GET', origin: '', url: SPOTIFY, cc: 'US',
    token: '', cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.body, { _error: 'forbidden' });
});

test('resolveRequest: unsupported host → 400 (even with a valid token)', async () => {
  const bad = 'https://evil.example/album/1';
  const r = await resolveRequest({
    method: 'GET', origin: '', url: bad, cc: 'US',
    token: makeToken(bad), cache: noCache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body, { _error: 'unsupported url' });
});

test('resolveRequest: cache hit returns cached body, no Odesli call', async () => {
  const cached = { entityUniqueId: 'X', linksByPlatform: { spotify: {} } };
  const cache = { get: async () => cached, put: async () => { throw new Error('no put on hit'); } };
  const r = await resolveRequest({
    method: 'GET', origin: 'https://groovepede.gregolsky.pl', url: SPOTIFY, cc: 'US',
    token: makeToken(SPOTIFY), cache, fetchImpl: failFetch,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, cached);
});

test('resolveRequest: cache miss fetches Odesli, caches, returns body', async () => {
  const odesli = { entityUniqueId: 'Y', linksByPlatform: { spotify: {}, appleMusic: {} } };
  let putKey = null, putBody = null;
  const cache = { get: async () => null, put: async (k, b) => { putKey = k; putBody = b; } };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => odesli, headers: { get: () => null } });
  const r = await resolveRequest({
    method: 'GET', origin: 'https://groovepede.gregolsky.pl', url: SPOTIFY, cc: 'US',
    token: makeToken(SPOTIFY), cache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, odesli);
  assert.equal(putBody && putBody.entityUniqueId, 'Y');
  assert.match(putKey, /^links:US:/);
});

test('resolveRequest: Odesli non-200 is passed through with _error + _retryAfter', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429, json: async () => ({}),
    headers: { get: (h) => (h === 'retry-after' ? '30' : null) },
  });
  const r = await resolveRequest({
    method: 'GET', origin: '', url: SPOTIFY, cc: 'US',
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 429);
  assert.deepEqual(r.body, { _error: 429, _retryAfter: 30 });
});

test('resolveRequest: Odesli network error → 503 network', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await resolveRequest({
    method: 'GET', origin: '', url: SPOTIFY, cc: 'US',
    token: makeToken(SPOTIFY), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body, { _error: 'network' });
});

// ── Artist images ───────────────────────────────────────────────────────────

const PIC = 'https://cdn-images.dzcdn.net/images/artist/09bbbb9b4f4cab65db1e69a7d4005aec/1000x1000-000000-80-0-0.jpg';

test('normalizeArtist folds diacritics, case and punctuation', () => {
  assert.equal(normalizeArtist('Bölzer'), 'bolzer');
  assert.equal(normalizeArtist('Vígundr'), 'vigundr');
  assert.equal(normalizeArtist('Zeal & Ardor'), 'zeal ardor');
  assert.equal(normalizeArtist('  MASTER  BOOT   RECORD '), 'master boot record');
  assert.equal(normalizeArtist(''), '');
});

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
    return { ok: true, status: 200, json: async () => ({ artist: { picture_xl: PIC } }) };
  };
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Witch Club Satan', albumId: '542142182',
    token: artistToken('Witch Club Satan', '542142182'), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/album\/542142182$/);
});

test('artistRequest: falls back to strict search when the album lookup yields nothing', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/album/')) return { ok: true, status: 200, json: async () => ({ artist: {} }) };
    return { ok: true, status: 200, json: async () => ({ data: [{ name: 'Hamulec', picture_xl: PIC }] }) };
  };
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Hamulec', albumId: '1',
    token: artistToken('Hamulec', '1'), cache: noCache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: PIC });
  assert.equal(calls.length, 2);
});

test('artistRequest: no match → image null, and the negative is cached', async () => {
  let putKey = null, putBody = null;
  const cache = { get: async () => null, put: async (k, b) => { putKey = k; putBody = b; } };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ name: 'Black Bomb A', picture_xl: PIC }] }) });
  const r = await artistRequest({
    method: 'GET', origin: '', name: 'Black Limbo', albumId: '',
    token: artistToken('Black Limbo'), cache, fetchImpl,
  });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { image: null });
  assert.equal(putKey, 'artist:black limbo');
  assert.deepEqual(putBody, { image: null });
});

test('artistRequest: cache hit short-circuits the Deezer call', async () => {
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
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const r = await artistRequest({
    method: 'GET', origin: 'https://evil.example', name: 'Bölzer', albumId: '',
    token: artistToken('Bölzer'), cache: noCache, fetchImpl,
  });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});
