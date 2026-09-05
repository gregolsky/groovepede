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
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { albumRequest, artistRequest, tracksRequest, logRequest, LOG_MAX_BODY_BYTES } from './resolver-core.mjs';
import { log, NOOP_LOGGER } from './logger.mjs';

const PORT    = parseInt(process.env.PORT || '8787', 10);
const DB_PATH = process.env.DB_PATH || '/data/cache.db';

// ── SQLite cache ────────────────────────────────────────────────────────────

/**
 * Build a { get, put } cache adapter backed by node:sqlite. `dbPath` may be a
 * filesystem path or ':memory:' (used by tests to avoid touching disk).
 */
export function createSqliteCache(dbPath, logger = NOOP_LOGGER) {
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
    try { sweepStmt.run(now()); } catch (err) { logger.warn({ err: err.message }, 'cache sweep error'); }
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
 * Read a request body up to maxBytes, rejecting (rather than silently
 * truncating) if the stream exceeds it — nginx's client_max_body_size is the
 * primary defence (see backend/nginx/app.conf.template), this is defense in
 * depth for anything that reaches the resolver directly.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('body too large')); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Route one request to the right resolver-core function and write the
 * response. Decoupled from the listening socket so tests can call it with
 * mock req/res objects.
 * `req` needs: method, url, headers (and, for POST bodies, be a real/mock
 * Node.js Readable so readBody's `.on()` calls work). `res` needs:
 * writeHead(code, headers), end(body).
 */
export async function handleRequest(req, res, { cache, port = PORT, logger = NOOP_LOGGER }) {
  const start = Date.now();
  const reqId = randomUUID().slice(0, 8);
  const rlog  = typeof logger.child === 'function' ? logger.child({ reqId }) : logger;

  // Capture the status code as each route sets it, instead of duplicating a
  // status value at every return point below — this is the one access-log
  // line per request that was missing entirely before this change.
  let statusCode = null;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (code, headers) => { statusCode = code; return origWriteHead(code, headers); };

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
        logger: rlog,
      });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body == null ? '' : JSON.stringify(r.body));
      return;
    }

    if (u.pathname === '/v1/tracks') {
      const r = await tracksRequest({
        method:  req.method,
        origin:  req.headers.origin || '',
        albumId: u.searchParams.get('albumId') || '',
        token:   req.headers['x-gp-token'] || '',
        cache,
        logger: rlog,
      });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body == null ? '' : JSON.stringify(r.body));
      return;
    }

    if (u.pathname === '/v1/log') {
      let body = '';
      if (req.method === 'POST') {
        try {
          body = await readBody(req, LOG_MAX_BODY_BYTES);
        } catch {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end('{"_error":"payload too large"}');
          return;
        }
      }
      // navigator.sendBeacon (the frontend's preferred path — see
      // frontend/src/js/beacon.js — chosen because it can fire reliably even
      // as the page unloads) can't set custom headers, so it puts the signed
      // token in ?token= instead; the header is still checked first.
      const r = await logRequest({
        method: req.method,
        origin: req.headers.origin || '',
        body,
        token:  req.headers['x-gp-token'] || u.searchParams.get('token') || '',
        logger: rlog,
      });
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body == null ? '' : JSON.stringify(r.body));
      return;
    }

    // The only album-metadata endpoint — matches what the PWA calls.
    if (u.pathname !== '/v1/album') {
      // These are the hits fail2ban's gp-scanner jail is watching for.
      rlog.warn({ path: u.pathname }, 'not found');
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"_error":"not found"}');
      return;
    }

    const r = await albumRequest({
      method: req.method,
      origin: req.headers.origin || '',
      url:    u.searchParams.get('url') || '',
      token:  req.headers['x-gp-token'] || '',
      cache,
      logger: rlog,
    });

    res.writeHead(r.statusCode, r.headers);
    res.end(r.body == null ? '' : JSON.stringify(r.body));
  } catch (err) {
    rlog.error({ err: err.message, stack: err.stack }, 'handler error');
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"_error":"internal"}');
  } finally {
    rlog.info({ method: req.method, path: req.url, status: statusCode, ms: Date.now() - start }, 'request');
  }
}

// ── Run as main ─────────────────────────────────────────────────────────────
// Guarded so importing this module (e.g. from server.test.mjs) never opens
// the real cache file or binds a port as a side effect of import.

if (import.meta.url === `file://${process.argv[1]}`) {
  const cache = createSqliteCache(DB_PATH, log);
  const server = createServer((req, res) => handleRequest(req, res, { cache, logger: log }));
  server.listen(PORT, '0.0.0.0', () => {
    log.info({ port: PORT, dbPath: DB_PATH }, 'gp-resolver-pi listening');
  });

  // node runs as PID 1 in the container (no init, see Dockerfile) so it
  // receives SIGTERM directly — without this, a `docker compose stop`/restart
  // looked identical to a crash in the logs: no shutdown line, just silence.
  const shutdown = signal => {
    log.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    // In case a connection never drains (shouldn't happen behind nginx's
    // short proxy timeouts, but this is the failure mode a missing timeout
    // here would look like: a restart that never completes).
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
