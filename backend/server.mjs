/**
 * Groovepede Resolver — self-hosted HTTP adapter (Raspberry Pi / arm64).
 *
 * Thin node:http server over the shared resolver-core, backed by a node:sqlite
 * cache. Runs behind nginx (TLS + per-IP rate limiting), so it binds inside
 * the compose network only and does no rate limiting itself.
 *
 * Requires Node >= 22.5 run with --experimental-sqlite (see Dockerfile).
 *
 * `createSqliteCache` and `handleRequest` are exported (rather than only run
 * inline below) so server.test.mjs can exercise routing and the cache adapter
 * directly, without opening a real port or touching the filesystem — pass
 * ':memory:' to createSqliteCache for tests, the same way node:sqlite's
 * standard sqlite3-compatible DatabaseSync already supports.
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { albumRequest, artistRequest } from './resolver-core.mjs';

const PORT    = parseInt(process.env.PORT || '8787', 10);
const DB_PATH = process.env.DB_PATH || '/data/cache.db';

// ── SQLite cache ────────────────────────────────────────────────────────────

/**
 * Build a { get, put } cache adapter backed by node:sqlite. `dbPath` may be a
 * filesystem path or ':memory:' (used by tests to avoid touching disk).
 */
export function createSqliteCache(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      k    TEXT PRIMARY KEY,
      body TEXT    NOT NULL,
      exp  INTEGER NOT NULL
    );
  `);

  const getStmt = db.prepare('SELECT body FROM cache WHERE k = ? AND exp > ?');
  const putStmt = db.prepare(
    'INSERT INTO cache (k, body, exp) VALUES (?, ?, ?) ' +
    'ON CONFLICT(k) DO UPDATE SET body = excluded.body, exp = excluded.exp'
  );
  const sweepStmt = db.prepare('DELETE FROM cache WHERE exp <= ?');

  const now = () => Math.floor(Date.now() / 1000);

  // Periodic sweep of expired rows (lazy expiry already handled on read).
  // unref'd so it never keeps the process (or a test run) alive on its own.
  const sweepTimer = setInterval(() => {
    try { sweepStmt.run(now()); } catch (err) { console.warn('cache sweep error:', err.message); }
  }, 6 * 60 * 60 * 1000);
  sweepTimer.unref?.();

  return {
    async get(k) {
      const row = getStmt.get(k, now());
      return row ? JSON.parse(row.body) : null;
    },
    async put(k, body, ttlS) {
      putStmt.run(k, JSON.stringify(body), now() + ttlS);
    },
    // Test-only escape hatches — not used by the request-handling path.
    _sweepNow: () => sweepStmt.run(now()),
    _close: () => { clearInterval(sweepTimer); db.close(); },
  };
}

// ── HTTP routing ────────────────────────────────────────────────────────────

/**
 * Route one request to the right resolver-core function and write the
 * response. Decoupled from the listening socket so tests can call it with
 * mock req/res objects.
 * `req` needs: method, url, headers. `res` needs: writeHead(code, headers),
 * end(body).
 */
export async function handleRequest(req, res, { cache, port = PORT }) {
  try {
    const u = new URL(req.url, `http://localhost:${port}`);

    if (u.pathname === '/healthz') {
      // `commit` lets a deploy verify THIS build is live, not just that some
      // server answered — see .github/workflows/deploy-backend.yml.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, commit: process.env.GIT_SHA || 'unknown' }));
      return;
    }

    if (u.pathname === '/v1/artist') {
      const r = await artistRequest({
        method:  req.method,
        origin:  req.headers.origin || '',
        name:    u.searchParams.get('name') || '',
        albumId: u.searchParams.get('albumId') || '',
        token:   req.headers['x-gp-token'] || '',
        cache,
      });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body == null ? '' : JSON.stringify(r.body));
      return;
    }

    // The only album-metadata endpoint — matches what the PWA calls.
    if (u.pathname !== '/v1/album') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"_error":"not found"}');
      return;
    }

    const { statusCode, headers, body } = await albumRequest({
      method: req.method,
      origin: req.headers.origin || '',
      url:    u.searchParams.get('url') || '',
      token:  req.headers['x-gp-token'] || '',
      cache,
    });

    res.writeHead(statusCode, headers);
    res.end(body == null ? '' : JSON.stringify(body));
  } catch (err) {
    console.error('handler error:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"_error":"internal"}');
  }
}

// ── Run as main ─────────────────────────────────────────────────────────────
// Guarded so importing this module (e.g. from server.test.mjs) never opens
// the real cache file or binds a port as a side effect of import.

if (import.meta.url === `file://${process.argv[1]}`) {
  const cache = createSqliteCache(DB_PATH);
  const server = createServer((req, res) => handleRequest(req, res, { cache }));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`gp-resolver-pi listening on :${PORT} (cache: ${DB_PATH})`);
  });
}
