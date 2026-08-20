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

function mockReq({ method = 'GET', url, headers = {} }) {
  return { method, url, headers };
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

test('handleRequest: /v1/resolve delegates to resolveRequest with parsed params', async () => {
  const url = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
  const token = makeToken(url);
  const req = mockReq({
    url: `/v1/resolve?url=${encodeURIComponent(url)}&userCountry=GB`,
    headers: { 'x-gp-token': token, origin: 'https://groovepede.gregolsky.pl' },
  });
  const res = mockRes();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ entityUniqueId: 'X' }), headers: { get: () => null } });
  // resolveRequest defaults fetchImpl to global fetch — stub it globally for this one call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await handleRequest(req, res, { cache: noCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { entityUniqueId: 'X' });
});

test('handleRequest: /v1/artist delegates to artistRequest with parsed params', async () => {
  const token = makeToken('artist:Bölzer|');
  const req = mockReq({
    url: `/v1/artist?name=${encodeURIComponent('Bölzer')}`,
    headers: { 'x-gp-token': token },
  });
  const res = mockRes();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  try {
    await handleRequest(req, res, { cache: noCache });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { image: null, genres: [] });
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
  // resolveRequest itself catches both cache errors (non-fatal, logged) and
  // fetch errors (→ 503 {_error:'network'}) — this confirms the whole chain
  // degrades gracefully rather than reaching handleRequest's own catch-all.
  const throwingCache = { get: async () => { throw new Error('db is on fire'); }, put: async () => {} };
  const url = 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy';
  const req = mockReq({
    url: `/v1/resolve?url=${encodeURIComponent(url)}`,
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
