/**
 * Request authentication for the resolver: verification of the client's
 * signed x-gp-token (ECDSA P-256, bound to each request's payload), and the
 * CORS headers for the allowed origins. See frontend/src/js/sign.js for the
 * signing side and the payload each route binds.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const TOKEN_WINDOW_S = 300; // 5-minute replay window

// ── Token verification ──────────────────────────────────────────────────────
// Public key is loaded lazily from GP_PUBLIC_KEY (base64 SPKI DER) on first use
// and cached. Lazy init keeps the module import side-effect-free (tests can set
// the env var, then call _resetPublicKey()).

let _publicKey;
let _publicKeyStatus;   // 'ok' | 'missing' | 'invalid' — see publicKeyStatus()
let _publicKeyInit = false;

function getPublicKey() {
  if (_publicKeyInit) return _publicKey;
  _publicKeyInit = true;
  const raw = process.env.GP_PUBLIC_KEY;
  if (!raw) { _publicKey = null; _publicKeyStatus = 'missing'; return null; }
  try {
    _publicKey = createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
    _publicKeyStatus = 'ok';
  } catch {
    _publicKey = null;
    _publicKeyStatus = 'invalid';
  }
  return _publicKey;
}

/**
 * How token verification is configured: 'ok', 'missing' or 'invalid'. Every
 * signed request is rejected with 403 unless it's 'ok', so server.mjs logs
 * this once at startup through the structured logger. It used to be a
 * console.error on first request, outside the log stream, and a missing key
 * wasn't reported at all.
 */
export function publicKeyStatus() {
  getPublicKey();
  return _publicKeyStatus;
}

/** Test hook — clears the cached public key so a new GP_PUBLIC_KEY is picked up. */
export function _resetPublicKey() { _publicKeyInit = false; _publicKey = undefined; _publicKeyStatus = undefined; }

/**
 * Verify a signed x-gp-token against the payload the request should be bound
 * to. Returns { ok: true } or { ok: false, reason } — the reason is only for
 * the request handlers' 'forbidden' log lines.
 */
export function verifyTokenDetailed(token, url) {
  const key = getPublicKey();
  if (!key) return { ok: false, reason: 'no-public-key' };
  if (!token) return { ok: false, reason: 'missing-token' };
  const dot = token.indexOf('.');
  if (dot < 0) return { ok: false, reason: 'malformed' };
  const tsStr  = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' };
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TOKEN_WINDOW_S) return { ok: false, reason: 'expired' };

  try {
    const sig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const msg = Buffer.from(`${tsStr}\n${url}`);
    const ok  = cryptoVerify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig);
    return { ok, reason: ok ? null : 'bad-signature' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}


// ── CORS ────────────────────────────────────────────────────────────────────
// Origin-based allowlist. Defaults cover prod + local dev; extra origins can be
// added via ALLOWED_ORIGINS (comma-separated) — used by the self-hosted Pi deployment.

const DEFAULT_ORIGINS = ['https://groovepede.gregolsky.pl', 'http://localhost:5173'];

export const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : []),
]);

/** CORS headers for an allowed origin, or {} for unknown origins. */
export function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'x-gp-token, content-type',
    'access-control-max-age':       '86400',
    'vary':                         'Origin',
  };
}
