/**
 * Groovepede Resolver Proxy — Lambda handler
 *
 * Receives: GET /links?url=<music-url>&userCountry=<cc>
 * Returns:  verbatim Odesli JSON (200) or { _error: <status|"missing url"|"bad url"> }
 *
 * Security:
 *  - x-gp-token header is checked by WAF at the CloudFront edge before this handler runs.
 *  - Function URL AuthType: AWS_IAM means only CloudFront OAC can invoke us.
 *  - Input is further validated here (allowlist + url parse) for SSRF hygiene.
 *
 * CORS:
 *  - Origin-based allowlist, same pattern as Odesli uses for its own frontends.
 *  - Only ALLOWED_ORIGINS get Access-Control-Allow-Origin; all others get no ACAO header.
 *  - OPTIONS preflight handled natively here (no separate CloudFront config needed).
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// ── Config ────────────────────────────────────────────────────────────────────

const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CACHE_TABLE;
const UA    = 'Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)';
const TTL_S = 60 * 60 * 24 * 60; // 60 days

const ODESLI_BASE = 'https://api.song.link/v1-alpha.1';

// ── Token verification ────────────────────────────────────────────────────────
// Public key loaded once at cold-start from GP_PUBLIC_KEY (base64 SPKI DER).
// Matches the ECDSA-P256 private key whose signed tokens the browser sends.

const PUBLIC_KEY = (() => {
  const raw = process.env.GP_PUBLIC_KEY;
  if (!raw) return null;
  try {
    return createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  } catch {
    console.error('GP_PUBLIC_KEY is set but could not be parsed as SPKI DER');
    return null;
  }
})();

const TOKEN_WINDOW_S = 300; // 5-minute replay window

/**
 * Verify a signed request token: "<ts>.<base64url_ieee_p1363_sig>"
 * Signed payload: UTF-8 of `${ts}\n${url}` (URL-bound to prevent cross-request replay).
 * Returns true only when signature is valid and token is within the time window.
 */
function verifyToken(token, url) {
  if (!PUBLIC_KEY || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const tsStr  = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TOKEN_WINDOW_S) return false;

  try {
    const sig = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const msg = Buffer.from(`${tsStr}\n${url}`);
    return cryptoVerify('sha256', msg, { key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

/** Origins the browser is allowed to call us from. */
const ALLOWED_ORIGINS = new Set([
  'https://groovepede.gregolsky.pl',
  'http://localhost:5173',
]);

/**
 * Hosts we are willing to proxy to Odesli.
 * Prevents the Lambda from being used as an open SSRF vector.
 */
const ALLOWED_HOSTS = new Set([
  'open.spotify.com',
  'music.apple.com',
  'music.youtube.com',
  'youtube.com',
  'www.youtube.com',
  'deezer.com',
  'www.deezer.com',
  'tidal.com',
  'listen.tidal.com',
  'music.amazon.com',
  'music.amazon.co.uk',
  'music.amazon.de',
  'music.amazon.fr',
  'music.amazon.co.jp',
  'pandora.com',
  'www.pandora.com',
  'soundcloud.com',
  'www.soundcloud.com',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip tracking params (si=, utm_*) while preserving service-specific params.
 * Returns the normalised URL string used as the DynamoDB cache key.
 */
function normalizeUrl(rawUrl) {
  const u = new URL(rawUrl);
  for (const k of [...u.searchParams.keys()]) {
    if (k === 'si' || k.startsWith('utm_')) u.searchParams.delete(k);
  }
  return u.toString();
}

/**
 * Return CORS response headers for an allowed origin, or {} for unknown origins.
 * Mirrors Odesli's behaviour: only allowlisted origins get Access-Control-Allow-Origin.
 */
function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'x-gp-token, content-type',
    'access-control-max-age':       '86400',
    'vary':                         'Origin',
  };
}

/** Build a Lambda Function URL response, always including CORS headers. */
const respond = (statusCode, body, cors = {}) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...cors },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  // Lambda Function URL sends headers as lowercase keys.
  const origin = event.headers?.origin ?? '';
  const cors   = corsHeaders(origin);
  const method = event.requestContext?.http?.method ?? 'GET';

  // ── OPTIONS preflight ──────────────────────────────────────────────────────
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  const q   = event.queryStringParameters || {};
  const url = q.url ?? '';
  const cc  = q.userCountry || 'US';

  // ── Token verification ─────────────────────────────────────────────────────
  // Signature is bound to `url`, so a sniffed token is only valid for that album
  // and only within the 5-minute replay window. On cache hits this code is never
  // reached (CloudFront serves the cached response directly).

  const token = event.headers?.['x-gp-token'] ?? '';
  if (!verifyToken(token, url)) {
    return respond(403, { _error: 'forbidden' }, cors);
  }

  // ── Input validation ───────────────────────────────────────────────────────

  if (!url) {
    return respond(400, { _error: 'missing url' }, cors);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return respond(400, { _error: 'bad url' }, cors);
  }

  const host = parsed.hostname.replace(/^www\./, '');
  if (!ALLOWED_HOSTS.has(parsed.hostname) && !ALLOWED_HOSTS.has(host)) {
    return respond(400, { _error: 'unsupported url' }, cors);
  }

  // ── DynamoDB cache ─────────────────────────────────────────────────────────

  const k = `links:${cc}:${normalizeUrl(url)}`;

  try {
    const hit = await ddb.send(new GetCommand({ TableName: TABLE, Key: { k } }));
    if (hit.Item?.body) {
      return respond(200, hit.Item.body, cors);
    }
  } catch (err) {
    // Cache miss on error — fall through to Odesli
    console.warn('DynamoDB get error (non-fatal):', err.message);
  }

  // ── Odesli call ────────────────────────────────────────────────────────────

  const params = new URLSearchParams({ url, userCountry: cc });
  if (process.env.ODESLI_KEY) params.set('key', process.env.ODESLI_KEY);

  let odesliRes;
  try {
    odesliRes = await fetch(`${ODESLI_BASE}/links?${params}`, {
      headers: {
        'User-Agent': UA,
        'Accept':     'application/json',
      },
    });
  } catch {
    // Network error reaching Odesli — retryable from the app's perspective
    return respond(503, { _error: 'network' }, cors);
  }

  if (!odesliRes.ok) {
    // Pass through Odesli's error status so the app's isRetryableResolveError
    // handles 429 / 5xx correctly.
    const retryAfter = odesliRes.headers.get('retry-after');
    const body = { _error: odesliRes.status };
    if (retryAfter) body._retryAfter = parseInt(retryAfter, 10) || null;
    return respond(odesliRes.status, body, cors);
  }

  const data = await odesliRes.json();

  // ── Write to cache (best-effort) ───────────────────────────────────────────

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        k,
        body: data,
        exp: Math.floor(Date.now() / 1000) + TTL_S,
      },
    }));
  } catch (err) {
    console.warn('DynamoDB put error (non-fatal):', err.message);
  }

  return respond(200, data, cors);
};
