/**
 * Tests for server.mjs — run with: node --test
 * (Uses the built-in node:test runner; no external deps.)
 *
 * These exercise handleRequest() and createSqliteCache() directly, with mock
 * req/res objects and an in-memory ':memory:' database — no real socket, no
 * real cache file, matching resolver-core.test.mjs's style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

// Same throwaway-keypair pattern as resolver-core.test.mjs — resolver-core's
// public key is read lazily on first use, so it must be set before the first
// verifyToken() call inside handleRequest.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.GP_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const { createSqliteCache, handleRequest } = await import('./server.mjs');
const { _resetPublicKey } = await import('./resolver-core.mjs');
_resetPublicKey();

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

function makeToken(payload, ts = Math.floor(Date.now() / 1000)) {
  const sig = cryptoSign('sha256', Buffer.from(`${ts}\n${payload}`), {
    key: privateKey, dsaEncoding: 'ieee-p1363',
  });
  return `${ts}.${b64url(sig)}`;
}

// ── mock req/res ────────────────────────────────────────────────────────────

function mockReq({ method = 'GET', url, headers = {}, body = null }) {
  // EventEmitter-shaped so readBody()'s req.on('data'/'end'/'error') works for
  // POST routes (/v1/log) like a real http.IncomingMessage. readBody
  // registers 'data' before 'end', so firing each callback synchronously at
  // registration time (rather than modeling a real async stream) delivers
  // the whole body before 'end' resolves the read — no timing games needed.
  return {
    method, url, headers,
    destroy() {}, // readBody() calls this on an oversized body — no-op is enough for a mock
    on(event, cb) {
      if (event === 'data' && body != null) cb(Buffer.from(body));
      if (event === 'end') cb();
      return this;
    },
  };
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
    end(body) { res.body = body; },
  };
  return res;
}

const noCache = { get: async () => null, put: async () => {} };

// ── routing ─────────────────────────────────────────────────────────────────

test('handleRequest: /healthz → 200 with ok + commit', async () => {
  const req = mockReq({ url: '/healthz' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, commit: 'unknown' });
});

test('handleRequest: /healthz reports GIT_SHA when set', async (t) => {
  process.env.GIT_SHA = 'abc123';
  t.after(() => { delete process.env.GIT_SHA; });
  const req = mockReq({ url: '/healthz' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.deepEqual(JSON.parse(res.body), { ok: true, commit: 'abc123' });
});

test('handleRequest: /v1/album delegates to albumRequest with parsed params', async () => {
  const url = 'https://www.deezer.com/album/302127';
  const token = makeToken(url);
  const req = mockReq({
    url: `/v1/album?url=${encodeURIComponent(url)}`,
    headers: { 'x-gp-token': token, origin: 'https://groovepede.gregolsky.pl' },
  });
  const res = mockRes();
  const deezerAlbum = { title: 'Discovery', artist: { name: 'Daft Punk' }, cover_xl: 'https://cdn/x.jpg', release_date: '2001-03-07' };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(deezerAlbum) });
  // albumRequest defaults fetchImpl to global fetch — stub it globally for this one call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handleRequest(req, res, { cache: noCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).title, 'Discovery');
});

test('handleRequest: /v1/artist delegates to artistRequest with parsed params', async () => {
  const token = makeToken('artist:Bölzer|');
  const req = mockReq({
    url: `/v1/artist?name=${encodeURIComponent('Bölzer')}`,
    headers: { 'x-gp-token': token },
  });
  const res = mockRes();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }), body: null });
  try {
    await handleRequest(req, res, { cache: noCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { image: null, genres: [] });
});

test('handleRequest: /v1/tracks delegates to tracksRequest with parsed params', async () => {
  const token = makeToken('tracks:302127');
  const req = mockReq({
    url: '/v1/tracks?albumId=302127',
    headers: { 'x-gp-token': token },
  });
  const res = mockRes();
  const deezerAlbum = { tracks: { data: [{ track_position: 1, title: 'Airbag', duration: 284 }] } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(deezerAlbum), body: null });
  try {
    await handleRequest(req, res, { cache: noCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { tracks: [{ number: 1, name: 'Airbag', duration_ms: 284000 }] });
});

test('handleRequest: POST /v1/log delegates to logRequest and always answers 204', async () => {
  const token = makeToken('log');
  const body = JSON.stringify({ kind: 'tracklist-empty', msg: 'got 422', albumId: '302127' });
  const req = mockReq({
    method: 'POST', url: '/v1/log',
    headers: { 'x-gp-token': token },
    body,
  });
  const res = mockRes();
  const warnings = [];
  const logger = {
    child: () => logger,
    warn:  (fields, msg) => warnings.push({ fields, msg }),
    info:  () => {}, error: () => {}, debug: () => {},
  };
  await handleRequest(req, res, { cache: noCache, logger });
  assert.equal(res.statusCode, 204);
  assert.ok(warnings.some(w => w.msg === 'client-reported failure' && w.fields.albumId === '302127'));
});

test('handleRequest: POST /v1/log accepts the token via ?token= (sendBeacon can\'t set headers)', async () => {
  const token = makeToken('log');
  const req = mockReq({
    method: 'POST', url: `/v1/log?token=${encodeURIComponent(token)}`,
    body: JSON.stringify({ kind: 'x', msg: 'y' }),
  });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 204);
});

test('handleRequest: POST /v1/log with a body over LOG_MAX_BODY_BYTES → 413, not passed to logRequest', async () => {
  const { LOG_MAX_BODY_BYTES } = await import('./resolver-core.mjs');
  const token = makeToken('log');
  const body = JSON.stringify({ kind: 'x', msg: 'A'.repeat(LOG_MAX_BODY_BYTES) });
  const req = mockReq({ method: 'POST', url: '/v1/log', headers: { 'x-gp-token': token }, body });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 413);
});

test('handleRequest: every response is followed by exactly one "request" access-log line with method/path/status/ms', async () => {
  const lines = [];
  const logger = {
    child: () => logger,
    info:  (fields, msg) => lines.push({ fields, msg }),
    warn: () => {}, error: () => {}, debug: () => {},
  };
  const req = mockReq({ url: '/healthz' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache, logger });
  const accessLines = lines.filter(l => l.msg === 'request');
  assert.equal(accessLines.length, 1);
  assert.equal(accessLines[0].fields.method, 'GET');
  assert.equal(accessLines[0].fields.path, '/healthz');
  assert.equal(accessLines[0].fields.status, 200);
  assert.equal(typeof accessLines[0].fields.ms, 'number');
});

test('handleRequest: a 404 is logged at warn — these are the hits fail2ban watches for', async () => {
  const warnings = [];
  const logger = { child: () => logger, warn: (f, m) => warnings.push({ f, m }), info: () => {}, error: () => {}, debug: () => {} };
  const req = mockReq({ url: '/nonexistent-path' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache, logger });
  assert.equal(res.statusCode, 404);
  assert.ok(warnings.some(w => w.m === 'not found' && w.f.path === '/nonexistent-path'));
});

test('handleRequest: unknown path → 404 {"_error":"not found"}', async () => {
  const req = mockReq({ url: '/v1/does-not-exist' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, '{"_error":"not found"}');
});

test('handleRequest: root path also 404s', async () => {
  const req = mockReq({ url: '/' });
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 404);
});

test('handleRequest: cache/fetch errors degrade gracefully, not a 500', async () => {
  // albumRequest itself catches both cache errors (non-fatal, logged) and
  // fetch errors (→ 503 {_error:'network'}) — this confirms the whole chain
  // degrades gracefully rather than reaching handleRequest's own catch-all.
  const throwingCache = { get: async () => { throw new Error('db is on fire'); }, put: async () => {} };
  const url = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
  const req = mockReq({
    url: `/v1/album?url=${encodeURIComponent(url)}`,
    headers: { 'x-gp-token': makeToken(url) },
  });
  const res = mockRes();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('also on fire'); };
  try {
    await handleRequest(req, res, { cache: throwingCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { _error: 'network' });
});

test('handleRequest: a malformed request URL is caught by the top-level handler → 500', async () => {
  // Nothing inside resolver-core runs for this case — `new URL(req.url, ...)`
  // throws before routing even happens, which is what handleRequest's own
  // try/catch exists to catch.
  const req = mockReq({ url: 'http://[::1' }); // unparseable — unterminated IPv6 literal
  const res = mockRes();
  await handleRequest(req, res, { cache: noCache });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, '{"_error":"internal"}');
});

// ── createSqliteCache ───────────────────────────────────────────────────────

test('createSqliteCache: put then get round-trips a value', async () => {
  const cache = createSqliteCache(':memory:');
  await cache.put('k1', { hello: 'world' }, 60);
  assert.deepEqual(await cache.get('k1'), { hello: 'world' });
  cache._close();
});

test('createSqliteCache: get on a missing key returns null', async () => {
  const cache = createSqliteCache(':memory:');
  assert.equal(await cache.get('nope'), null);
  cache._close();
});

test('createSqliteCache: an expired entry reads back as null (lazy expiry)', async () => {
  const cache = createSqliteCache(':memory:');
  await cache.put('k1', { hello: 'world' }, -1); // already expired
  assert.equal(await cache.get('k1'), null);
  cache._close();
});

test('createSqliteCache: sweep deletes expired rows', async () => {
  const cache = createSqliteCache(':memory:');
  await cache.put('expired', { a: 1 }, -1);
  await cache.put('fresh', { a: 2 }, 60);
  cache._sweepNow();
  assert.equal(await cache.get('expired'), null);
  assert.deepEqual(await cache.get('fresh'), { a: 2 });
  cache._close();
});

test('createSqliteCache: put overwrites an existing key (upsert)', async () => {
  const cache = createSqliteCache(':memory:');
  await cache.put('k1', { v: 1 }, 60);
  await cache.put('k1', { v: 2 }, 60);
  assert.deepEqual(await cache.get('k1'), { v: 2 });
  cache._close();
});
