/**
 * Groovepede Resolver — self-hosted HTTP adapter (Raspberry Pi / arm64).
 *
 * Thin node:http server over the shared resolver-core, backed by a node:sqlite
 * cache. Runs behind nginx (TLS + per-IP rate limiting), so it binds inside
 * the compose network only and does no rate limiting itself.
 *
 * Requires Node >= 22.5 run with --experimental-sqlite (see Dockerfile).
 */

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { resolveRequest, TTL_S } from './resolver-core.mjs';

const PORT    = parseInt(process.env.PORT || '8787', 10);
const DB_PATH = process.env.DB_PATH || '/data/cache.db';

// ── SQLite cache ────────────────────────────────────────────────────────────

const db = new DatabaseSync(DB_PATH);
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

const cache = {
  async get(k) {
    const row = getStmt.get(k, now());
    return row ? JSON.parse(row.body) : null;
  },
  async put(k, body, ttlS) {
    putStmt.run(k, JSON.stringify(body), now() + ttlS);
  },
};

// Periodic sweep of expired rows (lazy expiry already handled on read).
setInterval(() => {
  try { sweepStmt.run(now()); } catch (err) { console.warn('cache sweep error:', err.message); }
}, 6 * 60 * 60 * 1000).unref();

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);

    if (u.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // Match the same endpoint the PWA calls (/v1/resolve); keep /links as an alias.
    if (u.pathname !== '/v1/resolve' && u.pathname !== '/links') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"_error":"not found"}');
      return;
    }

    const { statusCode, headers, body } = await resolveRequest({
      method: req.method,
      origin: req.headers.origin || '',
      url:    u.searchParams.get('url') || '',
      cc:     u.searchParams.get('userCountry') || 'US',
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`gp-resolver-pi listening on :${PORT} (cache: ${DB_PATH})`);
});
