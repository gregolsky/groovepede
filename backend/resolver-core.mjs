/**
 * Groovepede Resolver — shared core (transport- and cache-agnostic).
 *
 * Pure Node, zero external dependencies. Imported by server.mjs (node:http
 * adapter, node:sqlite cache) — kept transport-agnostic since this module
 * previously also backed an AWS Lambda adapter (retired; see git history).
 *
 * The adapter does transport + cache; this module owns the actual work:
 * token verification, CORS, input/host validation, the Odesli call, and
 * cache orchestration via an injected `cache` adapter.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const UA          = 'Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)';
export const TTL_S       = 60 * 60 * 24 * 60;              // 60 days
export const ODESLI_BASE = 'https://api.song.link/v1-alpha.1';

export const DEEZER_BASE   = 'https://api.deezer.com';
export const ARTIST_TTL_S  = 60 * 60 * 24 * 30;            // 30 days — artist photos are near-static

const TOKEN_WINDOW_S = 300; // 5-minute replay window

// ── Token verification ──────────────────────────────────────────────────────
// Public key is loaded lazily from GP_PUBLIC_KEY (base64 SPKI DER) on first use
// and cached. Lazy init keeps the module import side-effect-free (tests can set
// the env var, then call _resetPublicKey()).

let _publicKey;
let _publicKeyInit = false;

function getPublicKey() {
  if (_publicKeyInit) return _publicKey;
  _publicKeyInit = true;
  const raw = process.env.GP_PUBLIC_KEY;
  if (!raw) { _publicKey = null; return null; }
  try {
    _publicKey = createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  } catch {
    console.error('GP_PUBLIC_KEY is set but could not be parsed as SPKI DER');
    _publicKey = null;
  }
  return _publicKey;
}

/** Test hook — clears the cached public key so a new GP_PUBLIC_KEY is picked up. */
export function _resetPublicKey() { _publicKeyInit = false; _publicKey = undefined; }

/**
 * Verify a signed request token: "<ts>.<base64url_ieee_p1363_sig>"
 * Signed payload: UTF-8 of `${ts}\n${url}` (URL-bound to prevent cross-request replay).
 * Returns true only when the signature is valid and the token is within the window.
 */
export function verifyToken(token, url) {
  const key = getPublicKey();
  if (!key || !token) return false;
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
    return cryptoVerify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

// ── CORS ────────────────────────────────────────────────────────────────────
// Origin-based allowlist (same pattern Odesli uses for its own frontends).
// Defaults cover prod + local dev; extra origins can be added via ALLOWED_ORIGINS
// (comma-separated) — used by the self-hosted Pi deployment.

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

// ── Input allowlist (SSRF hygiene) ──────────────────────────────────────────
// Hosts we are willing to proxy to Odesli. Keeps the resolver from being used
// as an open proxy to arbitrary URLs.

export const ALLOWED_HOSTS = new Set([
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

/**
 * Strip tracking params (si=, utm_*) while preserving service-specific params.
 * Returns the normalised URL string used as the cache key.
 */
export function normalizeUrl(rawUrl) {
  const u = new URL(rawUrl);
  for (const k of [...u.searchParams.keys()]) {
    if (k === 'si' || k.startsWith('utm_')) u.searchParams.delete(k);
  }
  return u.toString();
}

// ── Core resolve ────────────────────────────────────────────────────────────

/**
 * Resolve one request. Transport-agnostic: adapters pass parsed inputs and a
 * cache adapter, and translate the returned shape onto their wire format.
 *
 * @param {object}   p
 * @param {string}   p.method   HTTP method ('GET' | 'OPTIONS' | …)
 * @param {string}   p.origin   Origin request header (for CORS)
 * @param {string}   p.url      ?url= query value
 * @param {string}   p.cc       ?userCountry= (defaults to 'US')
 * @param {string}   p.token    x-gp-token header
 * @param {{get(k):Promise<any>, put(k,body,ttlS):Promise<void>}} p.cache
 * @param {typeof fetch} [p.fetchImpl]  injectable for tests
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 *          body is a JS value (object) or null; adapters JSON-stringify it.
 */
export async function resolveRequest({ method, origin, url, cc, token, cache, fetchImpl = fetch }) {
  const cors = corsHeaders(origin || '');

  // OPTIONS preflight — handled natively (no separate edge config needed).
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const jsonHeaders = { 'content-type': 'application/json', ...cors };
  const country = cc || 'US';

  // Token verification (signature is bound to `url`).
  if (!verifyToken(token || '', url || '')) {
    return { statusCode: 403, headers: jsonHeaders, body: { _error: 'forbidden' } };
  }

  // Input validation.
  if (!url) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'missing url' } };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'bad url' } };
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (!ALLOWED_HOSTS.has(parsed.hostname) && !ALLOWED_HOSTS.has(host)) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'unsupported url' } };
  }

  const k = `links:${country}:${normalizeUrl(url)}`;

  // Cache read (non-fatal on error).
  try {
    const hit = await cache.get(k);
    if (hit) return { statusCode: 200, headers: jsonHeaders, body: hit };
  } catch (err) {
    console.warn('cache get error (non-fatal):', err.message);
  }

  // Odesli call.
  const params = new URLSearchParams({ url, userCountry: country });
  if (process.env.ODESLI_KEY) params.set('key', process.env.ODESLI_KEY);

  let res;
  try {
    res = await fetchImpl(`${ODESLI_BASE}/links?${params}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
  } catch {
    return { statusCode: 503, headers: jsonHeaders, body: { _error: 'network' } };
  }

  if (!res.ok) {
    // Pass Odesli's status through so the app's retry logic handles 429 / 5xx.
    const retryAfter = res.headers.get('retry-after');
    const body = { _error: res.status };
    if (retryAfter) body._retryAfter = parseInt(retryAfter, 10) || null;
    return { statusCode: res.status, headers: jsonHeaders, body };
  }

  const data = await res.json();

  // Cache write (best-effort).
  try {
    await cache.put(k, data, TTL_S);
  } catch (err) {
    console.warn('cache put error (non-fatal):', err.message);
  }

  return { statusCode: 200, headers: jsonHeaders, body: data };
}

// ── Artist images ───────────────────────────────────────────────────────────
// Deezer is the only source with usable coverage for the long tail (Last.fm
// serves one placeholder for every artist since 2019; Odesli carries no artist
// imagery at all), but api.deezer.com sends no Access-Control-Allow-Origin, so
// the browser can't call it — hence this endpoint.
//
// Only the image URL is ever returned. Image bytes are never fetched, stored,
// or re-served here: the browser hotlinks Deezer's CDN directly, the same way
// it already does for Odesli-supplied album covers.

/**
 * Normalise an artist name for exact matching: NFKD, strip diacritics, drop
 * non-alphanumerics, collapse whitespace, lowercase. Mirrors normalizeAlbumStr
 * in the frontend (frontend/src/js/api.js) — kept as its own small copy rather
 * than shared, since this module has no build step and no frontend imports.
 */
export function normalizeArtist(s) {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deezer serves a generic blank for artists with no photo. Two forms observed:
// an empty id segment, and the MD5 of the empty string.
const DEEZER_BLANK = ['/artist//', 'd41d8cd98f00b204e9800998ecf8427e'];

/** True when a Deezer picture URL is really Deezer's "no image" placeholder. */
export function isBlankArtistImage(url) {
  if (!url) return true;
  return DEEZER_BLANK.some(marker => url.includes(marker));
}

/**
 * Pick the artist image from a Deezer /search/artist response, accepting a
 * candidate ONLY when its normalised name equals the normalised query.
 * Deezer's search is fuzzy — "Black Limbo" returns "Black Bomb A" as the top
 * hit — and showing the wrong artist's face is worse than showing none.
 */
export function pickArtistImage(candidates, name) {
  const want = normalizeArtist(name);
  if (!want) return null;
  const match = (candidates || []).find(c => normalizeArtist(c?.name) === want);
  const pic = match?.picture_xl || match?.picture_big || null;
  return isBlankArtistImage(pic) ? null : pic;
}

/**
 * Resolve an artist image URL. Same contract as resolveRequest: adapters pass
 * parsed inputs plus a cache adapter and translate the return shape.
 *
 * Two-stage lookup:
 *   1. albumId (a Deezer album id, which Odesli hands us for free on resolve)
 *      → /album/{id} → artist.picture_xl. Exact — no name matching at all.
 *   2. otherwise → /search/artist → strict normalised-name match.
 *
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 *          body is `{ image: string|null }`.
 */
export async function artistRequest({ method, origin, name, albumId, token, cache, fetchImpl = fetch }) {
  const cors = corsHeaders(origin || '');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const jsonHeaders = { 'content-type': 'application/json', ...cors };

  // Signature is bound to the same canonical string the client signed.
  if (!verifyToken(token || '', `artist:${name || ''}|${albumId || ''}`)) {
    return { statusCode: 403, headers: jsonHeaders, body: { _error: 'forbidden' } };
  }

  if (!name) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'missing name' } };
  }
  // albumId goes straight into a URL path; only ever a Deezer numeric id.
  if (albumId && !/^\d+$/.test(albumId)) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'bad albumId' } };
  }

  const k = `artist:${normalizeArtist(name)}`;

  try {
    const hit = await cache.get(k);
    if (hit) return { statusCode: 200, headers: jsonHeaders, body: hit };
  } catch (err) {
    console.warn('cache get error (non-fatal):', err.message);
  }

  const opts = { headers: { 'User-Agent': UA, 'Accept': 'application/json' } };
  let image  = null;
  let genres = [];

  // Stage 1 — exact, via the Deezer album id. Genres ride along for free:
  // this is the same /album/{id} response already being fetched for the
  // artist image, and Deezer includes genres.data[].name on it. Stage 2
  // (search/artist) has no genre data, so genres stay [] unless Stage 1 ran.
  if (albumId) {
    try {
      const res = await fetchImpl(`${DEEZER_BASE}/album/${albumId}`, opts);
      if (res.ok) {
        const data = await res.json();
        const pic  = data?.artist?.picture_xl || data?.artist?.picture_big || null;
        if (!isBlankArtistImage(pic)) image = pic;
        genres = (data?.genres?.data || []).map(g => g.name).filter(Boolean);
      }
    } catch { /* fall through to search */ }
  }

  // Stage 2 — strict name match.
  if (!image) {
    try {
      const q   = new URLSearchParams({ q: name, limit: '5' });
      const res = await fetchImpl(`${DEEZER_BASE}/search/artist?${q}`, opts);
      if (res.ok) {
        const data = await res.json();
        image = pickArtistImage(data?.data, name);
      }
    } catch {
      return { statusCode: 503, headers: jsonHeaders, body: { _error: 'network' } };
    }
  }

  const body = { image: image || null, genres };

  // Cache negatives too — an artist Deezer doesn't have won't appear next week
  // either, and re-asking on every explore would be pure waste.
  try {
    await cache.put(k, body, ARTIST_TTL_S);
  } catch (err) {
    console.warn('cache put error (non-fatal):', err.message);
  }

  return { statusCode: 200, headers: jsonHeaders, body };
}
