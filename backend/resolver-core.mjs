/**
 * Groovepede Resolver — shared core (transport- and cache-agnostic).
 *
 * Pure Node, zero external dependencies. Imported by server.mjs (node:http
 * adapter, node:sqlite cache) — kept transport-agnostic since this module
 * previously also backed an AWS Lambda adapter (retired; see git history).
 *
 * The adapter does transport + cache; this module owns the actual work: token
 * verification, CORS, input/host validation, per-service metadata extraction,
 * cross-service link discovery, and cache orchestration via an injected
 * `cache` adapter.
 *
 * Odesli's public API was deprecated (401 PUBLIC_API_ACCESS_DEPRECATED,
 * 2026-08) — this module used to proxy it wholesale (see git history for
 * resolveRequest/ODESLI_BASE). It's replaced by /v1/album: fetch the pasted
 * album page ourselves, extract {title, artist, cover, year} with a small
 * per-service routine, then look up the exact album on the two services that
 * offer free keyless search (Deezer, Apple/iTunes) to rebuild cross-service
 * links. Everything else — Amazon Music, SoundCloud — turned out to be a pure
 * client-rendered JS shell with no server-rendered metadata at all (verified
 * live), so neither is extractable and both were dropped from the registry.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { NOOP_LOGGER } from './logger.mjs';

export const UA            = 'Groovepede-Resolver/1.0 (+https://groovepede.gregolsky.pl)';
export const ALBUM_TTL_S   = 60 * 60 * 24 * 60;             // 60 days — album metadata is near-static
export const PARTIAL_TTL_S = 60 * 60;                       // 1 hour — used when cross-linking partially failed, so a retry isn't frozen out for 60 days
export const DEEZER_BASE   = 'https://api.deezer.com';
export const ITUNES_BASE   = 'https://itunes.apple.com';
export const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
export const SPOTIFY_API_BASE      = 'https://api.spotify.com/v1';
export const ARTIST_TTL_S  = 60 * 60 * 24 * 30;            // 30 days — artist photos are near-static
export const TRACKS_TTL_S  = 60 * 60 * 24 * 30;            // 30 days — tracklists are as near-static as artist photos

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
 * Same check as verifyToken, plus a machine-readable reason for a failure —
 * used only for logging at the request-handler call sites (verifyToken
 * itself only ever needed the boolean, so it stays as-is for callers/tests
 * that don't care why).
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

/**
 * Verify a signed request token: "<ts>.<base64url_ieee_p1363_sig>"
 * Signed payload: UTF-8 of `${ts}\n${url}` (URL-bound to prevent cross-request replay).
 * Returns true only when the signature is valid and the token is within the window.
 */
export function verifyToken(token, url) {
  return verifyTokenDetailed(token, url).ok;
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

// ── Input allowlist (SSRF hygiene) ──────────────────────────────────────────
// Hosts we are willing to fetch on the paste-er's behalf, mapped straight to
// the internal service slug — also doubles as "which extractor to run".
// Amazon Music and SoundCloud are deliberately absent: both album pages are
// pure client-rendered JS shells with no og:/JSON-LD server-rendered at all
// (verified live), and SoundCloud's oEmbed endpoint 404s outright — nothing
// here could ever extract metadata from either, so neither is in the registry.

export const SERVICE_HOSTS = new Map([
  ['open.spotify.com',   'spotify'],
  ['music.apple.com',    'apple'],
  ['deezer.com',         'deezer'],
  ['www.deezer.com',     'deezer'],
  ['tidal.com',          'tidal'],
  ['listen.tidal.com',   'tidal'],
  ['music.youtube.com',  'youtube'],
  ['youtube.com',        'youtube'],
  ['www.youtube.com',    'youtube'],
  ['pandora.com',        'pandora'],
  ['www.pandora.com',    'pandora'],
]);

/** Resolve a URL's hostname to a service slug, trying the www-stripped form too. */
function serviceForHost(hostname) {
  return SERVICE_HOSTS.get(hostname) || SERVICE_HOSTS.get(hostname.replace(/^www\./, '')) || null;
}

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

// ── Name folding for exact cross-service matching ───────────────────────────

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

/**
 * Same fold as normalizeArtist, plus stripping the edition/reissue qualifiers
 * services routinely disagree on ("Deluxe Edition", "Remastered", …) before
 * comparing titles across services. Mirrors normalizeAlbumStr in the frontend
 * (frontend/src/js/api.js) — kept as its own copy for the same reason.
 */
export function normalizeAlbumTitle(s) {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[-–—:]\s*(single|ep|album|remaster(?:ed)?|deluxe(?:\s+edition)?|expanded(?:\s+edition)?|bonus\s+tracks?|anniversary\s+edition|special\s+edition)\s*$/i, '')
    .replace(/\s*\((?:deluxe|remaster(?:ed)?|expanded|bonus\s+tracks?|anniversary|special|edition|version)[^)]*\)/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Upstream fetch helper ────────────────────────────────────────────────────
// Every extractor fetches exactly one upstream URL (a service's own album page,
// or a free keyless JSON API) through this, so the timeout, UA, and response
// size cap live in one place rather than N near-duplicates.

const FETCH_TIMEOUT_MS = 8_000;   // under nginx's 10s proxy_read_timeout for /v1/album
const MAX_RESPONSE_BYTES = 512 * 1024; // album pages run 25-800KB in practice; well clear of that

/** Thrown when the upstream fetch itself failed (network/timeout/non-2xx) — as
 * opposed to a successful fetch whose body just didn't contain what we wanted.
 * The distinction matters: the former should be retryable by the client
 * (isRetryableResolveError in frontend/src/js/storage.js), the latter shouldn't. */
export class UpstreamFetchError extends Error {
  constructor(status, cause) {
    // `cause` carries the real fetch failure (DNS, TLS, abort, …) that would
    // otherwise be discarded — see fetchUpstream below. Standard Error
    // chaining (Node >= 16.9), so err.cause?.message is always safe to log.
    super(`upstream fetch failed (${status || 'network'})`, cause !== undefined ? { cause } : undefined);
    this.status = status; // 0/undefined = network/timeout, else the upstream's HTTP status
  }
}

/** Read a Response body up to maxBytes, streaming when the runtime supports it
 * (real fetch/undici) and falling back to res.text() for test fixtures that
 * don't implement a streamable .body. */
async function readLimitedText(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    out += decoder.decode(value, { stream: true });
    if (total > maxBytes) { reader.cancel().catch(() => {}); break; }
  }
  return out;
}

/**
 * Fetch one upstream URL and return its body as text.
 * Throws UpstreamFetchError on timeout, network failure, or a non-2xx status
 * — callers let that propagate up to the request handler, which maps it to a
 * retryable {_error}. A successful-but-empty/unparseable body is the caller's
 * problem (extraction genuinely failed), not this helper's.
 */
export async function fetchUpstream(url, fetchImpl = fetch, opts = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': UA, 'Accept': '*/*', ...opts.headers },
        body: opts.body,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new UpstreamFetchError(0, err);
    }
    if (!res.ok) throw new UpstreamFetchError(res.status);
    try {
      // Read inside the same try/finally as the fetch itself, so the abort
      // timer covers the body read too — a slow/stalled body would otherwise
      // hang past FETCH_TIMEOUT_MS since the timer was cleared right after
      // headers arrived.
      return await readLimitedText(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      throw new UpstreamFetchError(0, err); // aborted mid-read = same as a timeout
    }
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-service metadata extraction ─────────────────────────────────────────
// Each extractor takes the parsed album URL and returns either:
//   - { serviceAlbumId, title, artist, cover, year, tags } on success
//   - null when the fetch succeeded but the page/response didn't look like an
//     album (markup changed, or it wasn't actually an album URL) — non-retryable
// A failed *fetch* (network/timeout/non-2xx) throws UpstreamFetchError instead,
// which the caller treats as retryable.

function metaTag(html, prop) {
  // Tolerant of attribute order and single/double quotes — property/content
  // can appear in either order in the wild. The quote character is captured
  // and back-referenced so an unescaped apostrophe/quote inside the content
  // (e.g. "Guns N' Roses") can't prematurely close the match.
  let m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=(["'])(.*?)\\1`, 'i'));
  if (m) return decodeHtmlEntities(m[2]);
  m = html.match(new RegExp(`<meta[^>]*content=(["'])(.*?)\\1[^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decodeHtmlEntities(m[2]) : null;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // must decode last — otherwise "&amp;quot;" double-decodes to a literal quote
}

async function extractSpotify(urlObj, fetchImpl) {
  const id = urlObj.pathname.match(/\/album\/([A-Za-z0-9]+)/)?.[1];
  if (!id) return null;
  // The main open.spotify.com page is a bare client-rendered shell (verified
  // live — no title, no og: tags beyond og:site_name). The /embed variant is
  // server-rendered with a Next.js __NEXT_DATA__ blob carrying the full entity.
  const text = await fetchUpstream(`https://open.spotify.com/embed/album/${id}`, fetchImpl);
  const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let entity;
  try { entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity; } catch { return null; }
  if (!entity?.title) return null;
  const images = entity.visualIdentity?.image || [];
  const cover  = images.slice().sort((a, b) => (b.maxWidth || 0) - (a.maxWidth || 0))[0]?.url || null;
  const year   = typeof entity.releaseDate === 'string' ? entity.releaseDate.slice(0, 4) : null;
  return {
    serviceAlbumId: id,
    title:  entity.title || null,
    artist: entity.subtitle || null,
    cover,
    year:   year || null,
    tags:   [],
  };
}

async function extractApple(urlObj, fetchImpl) {
  // Apple album URLs can carry more than one numeric segment (e.g. a track
  // anchor "?i=123" alongside the album id, or a numeric album title like
  // "/album/1984/..."). The album id is always the LAST numeric path segment.
  const matches = [...urlObj.pathname.matchAll(/\/(\d+)(?=\/|$)/g)];
  const id = matches.length ? matches[matches.length - 1][1] : null;
  if (!id) return null;
  const text = await fetchUpstream(`${ITUNES_BASE}/lookup?id=${id}&entity=album`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  // Validate the lookup actually returned the id we asked for — iTunes'
  // /lookup can return unrelated results when the id doesn't match an album.
  const item = (data?.results || []).find(r =>
    r.wrapperType === 'collection' && r.collectionType === 'Album' && String(r.collectionId) === id);
  if (!item?.collectionName) return null;
  const cover = item.artworkUrl100 ? item.artworkUrl100.replace(/\d+x\d+bb\.(jpg|png)$/, '600x600bb.$1') : null;
  return {
    serviceAlbumId: id,
    title:  item.collectionName || null,
    artist: item.artistName || null,
    cover,
    year:   item.releaseDate ? item.releaseDate.slice(0, 4) : null,
    tags:   item.primaryGenreName ? [item.primaryGenreName] : [],
  };
}

async function extractDeezer(urlObj, fetchImpl) {
  const id = urlObj.pathname.match(/\/album\/(\d+)/)?.[1];
  if (!id) return null;
  const text = await fetchUpstream(`${DEEZER_BASE}/album/${id}`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (data?.error) {
    // Deezer reports quota-exceeded as an HTTP-200 envelope (error.code === 4),
    // not a real 429 — treat it as retryable rather than "this isn't an album".
    if (data.error.code === 4) throw new UpstreamFetchError(429);
    return null;
  }
  if (!data?.title) return null;
  return {
    serviceAlbumId: id,
    title:  data.title || null,
    artist: data.artist?.name || null,
    cover:  data.cover_xl || data.cover_big || null,
    year:   data.release_date ? data.release_date.slice(0, 4) : null,
    tags:   (data.genres?.data || []).map(g => g.name).filter(Boolean),
  };
}

async function extractTidal(urlObj, fetchImpl) {
  const id   = urlObj.pathname.match(/\/album\/(\d+)/)?.[1] || null;
  const text = await fetchUpstream(urlObj.toString(), fetchImpl);
  const ogTitle = metaTag(text, 'og:title');
  if (!ogTitle) return null;
  // Observed live: "<Artist> - <Album>". Split on the first " - " only, since
  // either half can itself legitimately contain a hyphen.
  const sep = ogTitle.indexOf(' - ');
  return {
    serviceAlbumId: id,
    title:  (sep > -1 ? ogTitle.slice(sep + 3) : ogTitle).trim() || null,
    artist: sep > -1 ? ogTitle.slice(0, sep).trim() : null,
    cover:  metaTag(text, 'og:image'),
    year:   null,
    tags:   [],
  };
}

async function extractYoutube(urlObj, fetchImpl) {
  const text = await fetchUpstream(`https://www.youtube.com/oembed?url=${encodeURIComponent(urlObj.toString())}&format=json`, fetchImpl);
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.title) return null;
  // Auto-generated "topic" channels (the common case for an album playlist)
  // suffix the artist name with " - Topic" — not part of the artist's name.
  const artist = (data.author_name || '').replace(/\s*-\s*Topic$/i, '').trim() || null;
  return {
    serviceAlbumId: urlObj.searchParams.get('list') || urlObj.pathname.match(/\/browse\/([\w-]+)/)?.[1] || null,
    title:  data.title || null,
    artist,
    cover:  data.thumbnail_url || null,
    year:   null,
    tags:   [],
  };
}

async function extractPandora(urlObj, fetchImpl) {
  const text = await fetchUpstream(urlObj.toString(), fetchImpl);
  const ogTitle = metaTag(text, 'og:title');
  if (!ogTitle) return null;
  // UNVERIFIED — Pandora is US-geofenced and every probe from a non-US host
  // during development came back geo-blocked, so this pattern ("<Title> by
  // <Artist>", the shape Pandora's own og:title used historically) could not
  // be confirmed against a live page. Falls through to a title-only record
  // rather than guessing at an artist split that might be wrong. If Pandora
  // never actually extracts in production (the Pi itself may face the same
  // geo-block), that's a real gap — see the production smoke suite.
  const m = ogTitle.match(/^(.*)\s+by\s+(.*)$/i);
  return {
    serviceAlbumId: null,
    title:  (m ? m[1] : ogTitle).trim() || null,
    artist: m ? m[2].trim() : null,
    cover:  metaTag(text, 'og:image'),
    year:   null,
    tags:   [],
  };
}

// Exported (not just internal) so a test can assert every SERVICE_HOSTS value
// has a matching entry here — catches drift automatically if a host is added
// without its extractor, or vice versa.
export const EXTRACTORS = {
  spotify: extractSpotify,
  apple:   extractApple,
  deezer:  extractDeezer,
  tidal:   extractTidal,
  youtube: extractYoutube,
  pandora: extractPandora,
};

function slugFromPath(pathname) {
  return pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'unknown';
}

// ── Cross-service link discovery ────────────────────────────────────────────
// Given the {artist, title} just extracted from the pasted page, look up the
// exact album on the two services with a free keyless search API. Best-effort:
// any failure here just means one fewer link on the record, never a failed add.

// Deezer's query syntax uses double quotes as field delimiters; a literal "
// inside the artist/title would prematurely close the field, corrupting the
// query for every field after it.
const stripQuotes = s => s.replace(/"/g, '');

async function crossLinkDeezer(artist, title, fetchImpl) {
  const q = `artist:"${stripQuotes(artist)}" album:"${stripQuotes(title)}"`;
  const text = await fetchUpstream(`${DEEZER_BASE}/search/album?q=${encodeURIComponent(q)}&limit=5`, fetchImpl);
  const data = JSON.parse(text);
  if (data?.error) throw new UpstreamFetchError(data.error.code === 4 ? 429 : 502);
  const wantArtist = normalizeArtist(artist);
  const wantTitle  = normalizeAlbumTitle(title);
  const candidates = (data?.data || []).filter(it =>
    normalizeArtist(it.artist?.name) === wantArtist && normalizeAlbumTitle(it.title) === wantTitle);
  // Prefer a real album over a single/EP that happens to share the exact
  // normalised title (e.g. a title-track single released ahead of the LP).
  const match = candidates.find(it => it.record_type !== 'single' && it.record_type !== 'ep') || candidates[0];
  if (!match) return null;
  return { url: match.link || `https://www.deezer.com/album/${match.id}` };
}

async function crossLinkApple(artist, title, fetchImpl) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const text = await fetchUpstream(`${ITUNES_BASE}/search?term=${term}&entity=album&limit=5`, fetchImpl);
  const data = JSON.parse(text);
  const wantArtist = normalizeArtist(artist);
  const wantTitle  = normalizeAlbumTitle(title);
  const candidates = (data?.results || []).filter(it =>
    normalizeArtist(it.artistName) === wantArtist && normalizeAlbumTitle(it.collectionName) === wantTitle);
  // iTunes suffixes single/EP releases in the title itself (already stripped
  // by normalizeAlbumTitle) — fall back to the raw collectionName to tell
  // them apart when more than one candidate ties on the normalised name.
  const match = candidates.find(it => !/-\s*(single|ep)$/i.test(it.collectionName || '')) || candidates[0];
  if (!match?.collectionViewUrl) return null;
  return { url: match.collectionViewUrl };
}

// ── Spotify Client Credentials (app-only auth) ──────────────────────────────
// App-only OAuth: no user, no consent screen, and can only ever read
// Spotify's public catalog (search, browse) — never a user's library or
// playlists. There is no other Spotify auth flow anywhere in this app — the
// whole app is login-free. Exists purely so the resolver can cross-link to
// Spotify the same way it already does for Deezer/Apple. Entirely optional:
// when SPOTIFY_CLIENT_ID/SECRET aren't set, crossLinkSpotify just no-ops.

let _spotifyToken = null;        // { value, expiresAt } — in-memory only, never persisted
let _spotifyTokenPromise = null; // in-flight mint, so concurrent requests share one token fetch

async function getSpotifyAppToken(fetchImpl) {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (_spotifyToken && _spotifyToken.expiresAt > Date.now() + 10_000) {
    return _spotifyToken.value;
  }
  if (!_spotifyTokenPromise) {
    _spotifyTokenPromise = (async () => {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const text = await fetchUpstream(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, fetchImpl, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      const data = JSON.parse(text);
      _spotifyToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
      return _spotifyToken.value;
    })();
    try {
      return await _spotifyTokenPromise;
    } finally {
      _spotifyTokenPromise = null;
    }
  }
  return _spotifyTokenPromise;
}

/** Test hook — clears the cached app token so a fresh mint is exercised. */
export function _resetSpotifyToken() { _spotifyToken = null; _spotifyTokenPromise = null; }

async function crossLinkSpotify(artist, title, fetchImpl) {
  const token = await getSpotifyAppToken(fetchImpl);
  if (!token) return null; // not configured — inert, not a failure

  const q = encodeURIComponent(`album:${title} artist:${artist}`);
  const text = await fetchUpstream(`${SPOTIFY_API_BASE}/search?type=album&limit=5&q=${q}`, fetchImpl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = JSON.parse(text);

  const wantArtist = normalizeArtist(artist);
  const wantTitle  = normalizeAlbumTitle(title);
  const candidates = (data?.albums?.items || []).filter(it =>
    normalizeAlbumTitle(it.name) === wantTitle &&
    (it.artists || []).some(a => normalizeArtist(a.name) === wantArtist));
  const match = candidates.find(it => it.album_type === 'album') || candidates[0];
  if (!match) return null;
  return { url: match.external_urls?.spotify || null, nativeUri: `spotify:album:${match.id}` };
}

// ── Core: /v1/album ──────────────────────────────────────────────────────────

/**
 * Resolve one album request. Transport-agnostic: adapters pass parsed inputs
 * and a cache adapter, and translate the returned shape onto their wire format.
 *
 * @param {object}   p
 * @param {string}   p.method   HTTP method ('GET' | 'OPTIONS' | …)
 * @param {string}   p.origin   Origin request header (for CORS)
 * @param {string}   p.url      ?url= query value — the pasted album page
 * @param {string}   p.token    x-gp-token header, signed over `url` (unchanged
 *                              from the retired /v1/resolve — same binding string)
 * @param {{get(k):Promise<any>, put(k,body,ttlS):Promise<void>}} p.cache
 * @param {typeof fetch} [p.fetchImpl]  injectable for tests
 * @param {object} [p.logger]  pino-shaped logger ({debug,info,warn,error}); defaults
 *                             to a no-op so importing/testing this module stays silent
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 */
export async function albumRequest({ method, origin, url, token, cache, fetchImpl = fetch, logger = NOOP_LOGGER }) {
  const cors = corsHeaders(origin || '');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const jsonHeaders = { 'content-type': 'application/json', ...cors };

  const auth = verifyTokenDetailed(token || '', url || '');
  if (!auth.ok) {
    logger.warn({ route: '/v1/album', reason: auth.reason }, 'forbidden');
    return { statusCode: 403, headers: jsonHeaders, body: { _error: 'forbidden' } };
  }
  if (!url) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'missing url' } };
  }

  let parsed;
  try { parsed = new URL(url); } catch { return { statusCode: 400, headers: jsonHeaders, body: { _error: 'bad url' } }; }

  const service = serviceForHost(parsed.hostname);
  if (!service) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'unsupported url' } };
  }

  const k = `album:v1:${normalizeUrl(url)}`;

  try {
    const hit = await cache.get(k);
    if (hit) return { statusCode: 200, headers: jsonHeaders, body: hit };
  } catch (err) {
    logger.warn({ route: '/v1/album', err: err.message }, 'cache get error (non-fatal)');
  }

  let extracted;
  try {
    extracted = await EXTRACTORS[service](parsed, fetchImpl);
  } catch (err) {
    if (err instanceof UpstreamFetchError) {
      const status = err.status;
      logger.warn({ route: '/v1/album', service, status, err: err.message, cause: err.cause?.message },
        'upstream fetch failed');
      if (!status) return { statusCode: 503, headers: jsonHeaders, body: { _error: 'network' } };
      if (status === 429 || status >= 500) {
        // Transient upstream failure — worth a client-side retry.
        return { statusCode: status, headers: jsonHeaders, body: { _error: status } };
      }
      // Permanent upstream failure (404/403/400/…) — report as our own 422,
      // never the raw upstream status. Passing a bare 404 through would trip
      // fail2ban's gp-scanner jail (bans any IP producing 3 HTTP 404s), which
      // is meant to catch scanners hitting unknown paths on OUR server, not
      // real users whose pasted link happens to 404 upstream.
      return { statusCode: 422, headers: jsonHeaders, body: { _error: 'not-found' } };
    }
    logger.warn({ route: '/v1/album', service, err: err.message }, 'extraction error (treated as failed extraction)');
    extracted = null;
  }

  if (!extracted?.title) {
    // Fetched fine, but couldn't find an album in the response — markup
    // changed, or this wasn't really an album URL. Not worth retrying.
    return { statusCode: 422, headers: jsonHeaders, body: { _error: 'extraction-failed' } };
  }

  const serviceAlbumId = extracted.serviceAlbumId || slugFromPath(parsed.pathname);
  const links = { [service]: { url } };
  if (service === 'spotify') links.spotify.nativeUri = `spotify:album:${serviceAlbumId}`;

  // Tracks whether any cross-link job actually threw (network/quota/etc.), as
  // opposed to running fine and finding no match — the two need different
  // cache TTLs (see the cache.put call below): a real failure deserves a
  // quick retry, a genuine no-match doesn't need re-checking for 60 days.
  let crossLinkHadFailure = false;
  // Named per target (not one shared onFail) so a failed Deezer cross-link —
  // the sole cause of a missing tracklist later, since /v1/tracks has no
  // other source — is distinguishable in logs from a failed Apple/Spotify one.
  const onCrossLinkFail = target => err => {
    crossLinkHadFailure = true;
    logger.warn({ route: '/v1/album', service, crossLink: target, err: err?.message }, 'cross-link failed');
  };
  if (extracted.artist && extracted.title) {
    const jobs = [];
    if (service !== 'deezer') {
      jobs.push(crossLinkDeezer(extracted.artist, extracted.title, fetchImpl)
        .then(r => { if (r) links.deezer = r; }).catch(onCrossLinkFail('deezer')));
    }
    if (service !== 'apple') {
      jobs.push(crossLinkApple(extracted.artist, extracted.title, fetchImpl)
        .then(r => { if (r) links.apple = r; }).catch(onCrossLinkFail('apple')));
    }
    if (service !== 'spotify') {
      jobs.push(crossLinkSpotify(extracted.artist, extracted.title, fetchImpl)
        .then(r => { if (r) links.spotify = r; }).catch(onCrossLinkFail('spotify')));
    }
    await Promise.all(jobs);
  }

  const body = {
    id:     `${service}:${serviceAlbumId}`,
    service,
    title:  extracted.title,
    artist: extracted.artist || null,
    cover:  extracted.cover || null,
    year:   extracted.year || null,
    tags:   extracted.tags || [],
    links,
  };

  try {
    await cache.put(k, body, crossLinkHadFailure ? PARTIAL_TTL_S : ALBUM_TTL_S);
  } catch (err) {
    logger.warn({ route: '/v1/album', err: err.message }, 'cache put error (non-fatal)');
  }

  return { statusCode: 200, headers: jsonHeaders, body };
}

// ── Artist images ───────────────────────────────────────────────────────────
// Deezer is the only source with usable coverage for the long tail (Last.fm
// serves one placeholder for every artist since 2019), but api.deezer.com sends
// no Access-Control-Allow-Origin, so the browser can't call it — hence this
// endpoint. `albumId` is Deezer's own numeric album id, which /v1/album hands
// the client for free in links.deezer.url whenever cross-linking found a match.
//
// Only the image URL is ever returned. Image bytes are never fetched, stored,
// or re-served here: the browser hotlinks Deezer's CDN directly, the same way
// it already does for album covers.

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
 * Resolve an artist image URL. Same contract as albumRequest: adapters pass
 * parsed inputs plus a cache adapter and translate the return shape.
 *
 * Two-stage lookup:
 *   1. albumId (a Deezer album id) → /album/{id} → artist.picture_xl. Exact —
 *      no name matching at all.
 *   2. otherwise → /search/artist → strict normalised-name match.
 *
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 *          body is `{ image: string|null }`.
 */
export async function artistRequest({ method, origin, name, albumId, token, cache, fetchImpl = fetch, logger = NOOP_LOGGER }) {
  const cors = corsHeaders(origin || '');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const jsonHeaders = { 'content-type': 'application/json', ...cors };

  // Signature is bound to the same canonical string the client signed.
  const auth = verifyTokenDetailed(token || '', `artist:${name || ''}|${albumId || ''}`);
  if (!auth.ok) {
    logger.warn({ route: '/v1/artist', reason: auth.reason }, 'forbidden');
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
    logger.warn({ route: '/v1/artist', err: err.message }, 'cache get error (non-fatal)');
  }

  let image  = null;
  let genres = [];

  // Stage 1 — exact, via the Deezer album id. Genres ride along for free:
  // this is the same /album/{id} response already being fetched for the
  // artist image, and Deezer includes genres.data[].name on it. Stage 2
  // (search/artist) has no genre data, so genres stay [] unless Stage 1 ran.
  // Routed through fetchUpstream (same as albumRequest's extractors) so both
  // calls share its timeout and response-size cap instead of running unbounded.
  if (albumId) {
    try {
      const text = await fetchUpstream(`${DEEZER_BASE}/album/${albumId}`, fetchImpl);
      const data = JSON.parse(text);
      const pic  = data?.artist?.picture_xl || data?.artist?.picture_big || null;
      if (!isBlankArtistImage(pic)) image = pic;
      genres = (data?.genres?.data || []).map(g => g.name).filter(Boolean);
    } catch (err) {
      logger.warn({ route: '/v1/artist', stage: 'albumId-lookup', albumId, err: err.message },
        'deezer lookup failed (non-fatal, falling through to search)');
    }
  }

  // Stage 2 — strict name match.
  if (!image) {
    try {
      const q    = new URLSearchParams({ q: name, limit: '5' });
      const text = await fetchUpstream(`${DEEZER_BASE}/search/artist?${q}`, fetchImpl);
      const data = JSON.parse(text);
      image = pickArtistImage(data?.data, name);
    } catch (err) {
      logger.warn({ route: '/v1/artist', stage: 'search', name, err: err.message }, 'deezer search failed');
      return { statusCode: 503, headers: jsonHeaders, body: { _error: 'network' } };
    }
  }

  const body = { image: image || null, genres };

  // Cache negatives too — an artist Deezer doesn't have won't appear next week
  // either, and re-asking on every explore would be pure waste.
  try {
    await cache.put(k, body, ARTIST_TTL_S);
  } catch (err) {
    logger.warn({ route: '/v1/artist', err: err.message }, 'cache put error (non-fatal)');
  }

  return { statusCode: 200, headers: jsonHeaders, body };
}

// ── Tracklists ──────────────────────────────────────────────────────────────
// Same problem as artistRequest: api.deezer.com sends no CORS header, so the
// browser can't call it directly. albumId is Deezer's own numeric album id
// (the client already has it for free in links.deezer.url whenever
// cross-linking found a match, via deezerAlbumId() in frontend/src/js/api.js).
// This used to be sourced from the Spotify Web API with a user's OAuth token
// (frontend/src/js/auth.js, retired) — moving it here means it works for every
// album, not only ones a logged-in user had linked to Spotify.

/**
 * Resolve a Deezer album's tracklist.
 *
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 *          body is `{ tracks: Array<{number, name, duration_ms}> }`.
 */
export async function tracksRequest({ method, origin, albumId, token, cache, fetchImpl = fetch, logger = NOOP_LOGGER }) {
  const cors = corsHeaders(origin || '');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const jsonHeaders = { 'content-type': 'application/json', ...cors };

  const auth = verifyTokenDetailed(token || '', `tracks:${albumId || ''}`);
  if (!auth.ok) {
    logger.warn({ route: '/v1/tracks', reason: auth.reason }, 'forbidden');
    return { statusCode: 403, headers: jsonHeaders, body: { _error: 'forbidden' } };
  }

  if (!albumId) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'missing albumId' } };
  }
  // albumId goes straight into a URL path; only ever a Deezer numeric id.
  if (!/^\d+$/.test(albumId)) {
    return { statusCode: 400, headers: jsonHeaders, body: { _error: 'bad albumId' } };
  }

  const k = `tracks:${albumId}`;

  try {
    const hit = await cache.get(k);
    if (hit) return { statusCode: 200, headers: jsonHeaders, body: hit };
  } catch (err) {
    logger.warn({ route: '/v1/tracks', albumId, err: err.message }, 'cache get error (non-fatal)');
  }

  // Fetch and parse are separate try/catches on purpose: an UpstreamFetchError
  // (network/timeout/non-2xx) and a JSON.parse failure on a 200 body (Deezer
  // returning HTML, a truncated body past MAX_RESPONSE_BYTES, a captive
  // portal) both used to fall into one catch and become an unlogged, identical
  // 422 — indistinguishable from "this album genuinely has no tracks".
  let text;
  try {
    text = await fetchUpstream(`${DEEZER_BASE}/album/${albumId}`, fetchImpl);
  } catch (err) {
    if (err instanceof UpstreamFetchError) {
      const status = err.status;
      logger.warn({ route: '/v1/tracks', albumId, status, err: err.message, cause: err.cause?.message },
        'upstream fetch failed');
      if (!status) return { statusCode: 503, headers: jsonHeaders, body: { _error: 'network' } };
      if (status === 429 || status >= 500) {
        return { statusCode: status, headers: jsonHeaders, body: { _error: status } };
      }
      // Same fail2ban-safety remap as albumRequest — never pass a bare
      // upstream 404/403/400 through as our own HTTP status.
      return { statusCode: 422, headers: jsonHeaders, body: { _error: 'not-found' } };
    }
    logger.warn({ route: '/v1/tracks', albumId, err: err.message }, 'unexpected fetch error');
    return { statusCode: 422, headers: jsonHeaders, body: { _error: 'not-found' } };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    logger.warn({ route: '/v1/tracks', albumId, bodyLen: text.length, err: err.message },
      'tracks response unparseable');
    return { statusCode: 422, headers: jsonHeaders, body: { _error: 'not-found' } };
  }

  if (data?.error) {
    // Deezer reports quota-exceeded as an HTTP-200 envelope (error.code === 4),
    // not a real 429 — treat it as retryable rather than "no such album".
    if (data.error.code === 4) return { statusCode: 429, headers: jsonHeaders, body: { _error: 429 } };
    logger.warn({ route: '/v1/tracks', albumId, deezerErrorCode: data.error.code }, 'deezer error envelope');
    return { statusCode: 422, headers: jsonHeaders, body: { _error: 'not-found' } };
  }

  const tracks = (data?.tracks?.data || []).map(t => ({
    number:      t.track_position ?? null,
    name:        t.title || null,
    duration_ms: typeof t.duration === 'number' ? t.duration * 1000 : null,
  }));

  if (!tracks.length) {
    logger.warn({ route: '/v1/tracks', albumId, hasTracksField: !!data?.tracks }, 'tracks empty');
  }

  const body = { tracks };

  try {
    // An empty result gets a short TTL (same one albumRequest uses for a
    // partial cross-link) rather than the full 30-day TRACKS_TTL_S — a bad
    // Deezer response used to poison the album for a month with no way to
    // retry short of the cache expiring.
    await cache.put(k, body, tracks.length ? TRACKS_TTL_S : PARTIAL_TTL_S);
  } catch (err) {
    logger.warn({ route: '/v1/tracks', albumId, err: err.message }, 'cache put error (non-fatal)');
  }

  return { statusCode: 200, headers: jsonHeaders, body };
}

// ── Client error beacon ──────────────────────────────────────────────────────
// Everything above this line can fail silently in a user's own browser: a
// resolve, a tracklist fetch, an uncaught render error. This endpoint exists
// solely to get a line about that failure into OUR OWN logs — it never
// answers the caller with anything beyond 204/403, and the body it receives
// is never echoed back or stored anywhere but the log stream.
//
// No per-request meaning is bound into the signed payload (unlike /v1/album
// or /v1/tracks, where the token is bound to the resource being requested):
// the token here only proves "a legitimate build of the app sent this",
// which is all a diagnostic beacon needs — nginx's own strict rate-limit zone
// (see backend/nginx/app.conf.template) is the real defence against abuse.

export const LOG_MAX_BODY_BYTES = 4096;
const LOG_FIELD_MAX = 500;

function truncateField(v, max) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Accept one client-reported failure and re-emit it into the same structured
 * log stream as the server's own lines (tagged src:'client'), truncated and
 * defensively parsed.
 *
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.origin
 * @param {string} p.body    raw request body (already size-capped by the caller)
 * @param {string} p.token   x-gp-token header, signed over the fixed string 'log'
 * @param {object} [p.logger]
 * @returns {Promise<{statusCode:number, headers:object, body:null}>}
 */
export async function logRequest({ method, origin, body, token, logger = NOOP_LOGGER }) {
  const cors = corsHeaders(origin || '');

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: null };
  }

  const auth = verifyTokenDetailed(token || '', 'log');
  if (!auth.ok) {
    logger.warn({ route: '/v1/log', reason: auth.reason }, 'forbidden');
    return { statusCode: 403, headers: cors, body: null };
  }

  let parsed = null;
  if (typeof body === 'string' && body.length > 0 && body.length <= LOG_MAX_BODY_BYTES) {
    try { parsed = JSON.parse(body); } catch { parsed = null; }
  }

  if (parsed && typeof parsed === 'object') {
    logger.warn({
      route:       '/v1/log',
      src:         'client',
      kind:        truncateField(parsed.kind || 'error', 40),
      msg:         truncateField(parsed.msg || '', LOG_FIELD_MAX),
      stack:       truncateField(parsed.stack || '', LOG_FIELD_MAX),
      clientRoute: truncateField(parsed.route || '', 100),
      albumId:     truncateField(parsed.albumId || '', 40),
      service:     truncateField(parsed.service || '', 40),
      ua:          truncateField(parsed.ua || '', 200),
    }, 'client-reported failure');
  }

  // Always 204, even on an unparseable/oversized body — this endpoint must
  // never become a probe surface, and a bad beacon payload is the client's
  // bug to fix, not something worth telling it about.
  return { statusCode: 204, headers: cors, body: null };
}
