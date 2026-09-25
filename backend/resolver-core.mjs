/**
 * Groovepede Resolver — the request handlers, and the one module server.mjs
 * and the tests import. Transport- and cache-agnostic: the adapter
 * (server.mjs: node:http + node:sqlite) does transport and cache; this owns
 * the work, split by concern:
 *
 *   auth.mjs        token verification, CORS
 *   upstream.mjs    fetchUpstream / resolveRedirect, UpstreamFetchError, base URLs
 *   extractors.mjs  host allowlist, per-service album-page extraction
 *   crosslink.mjs   cross-service links by exact name match, Spotify app token
 *   this file       cache TTLs, the shared request pipeline, the four endpoints
 *
 * Everything the others export is re-exported here, so callers keep a single
 * import. History: this replaced a wholesale Odesli proxy when Odesli's public
 * API was deprecated (2026-08) — see git history for resolveRequest/ODESLI_BASE.
 * Amazon Music and SoundCloud album pages turned out to be pure client-rendered
 * shells with no metadata, so neither is extractable.
 */

import { NOOP_LOGGER } from './logger.mjs';
import { corsHeaders, verifyTokenDetailed } from './auth.mjs';
import { DEEZER_BASE, UpstreamFetchError, fetchUpstream } from './upstream.mjs';
import { EXTRACTORS, serviceForHost, normalizeUrl, slugFromPath } from './extractors.mjs';
import { normalizeArtist, crossLinkDeezer, crossLinkApple, crossLinkSpotify } from './crosslink.mjs';

export * from './auth.mjs';
export * from './upstream.mjs';
export * from './extractors.mjs';
export * from './crosslink.mjs';

export const ALBUM_TTL_S   = 60 * 60 * 24 * 60;             // 60 days — album metadata is near-static
export const PARTIAL_TTL_S = 60 * 60;                       // 1 hour — used when cross-linking partially failed, so a retry isn't frozen out for 60 days
export const ARTIST_TTL_S  = 60 * 60 * 24 * 30;            // 30 days — artist photos are near-static
export const TRACKS_TTL_S  = 60 * 60 * 24 * 30;            // 30 days — tracklists are as near-static as artist photos

// ── Shared request pipeline ──────────────────────────────────────────────────

/**
 * The steps every signed JSON endpoint (/v1/album, /v1/artist, /v1/tracks)
 * shares, in the one order they must run: CORS and the OPTIONS preflight →
 * token check (403, logged) → input validation (400) → cache read → compute →
 * cache write. Cache errors are logged and never fatal. Each endpoint supplies
 * only what differs. Transport-agnostic: adapters pass parsed inputs plus a
 * cache adapter and translate the returned {statusCode, headers, body}.
 *
 * @param {object}   p
 * @param {string}   p.route          for log lines, e.g. '/v1/album'
 * @param {string}   p.signedPayload  the string the client signed for this request
 * @param {() => string|null} p.validate  an _error string for a 400, or null
 * @param {() => string}      p.cacheKey  only called once validate() passed
 * @param {() => Promise<{status:number, body:any, ttlS?:number}>} p.compute
 *        a 200 with ttlS is cached for that long; without ttlS it isn't.
 */
async function signedJsonEndpoint({ method, origin, token, cache, logger, route, signedPayload, validate, cacheKey, compute }) {
  const cors = corsHeaders(origin || '');
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: null };

  const headers = { 'content-type': 'application/json', ...cors };
  const reply = (statusCode, body) => ({ statusCode, headers, body });

  const auth = verifyTokenDetailed(token || '', signedPayload);
  if (!auth.ok) {
    logger.warn({ route, reason: auth.reason }, 'forbidden');
    return reply(403, { _error: 'forbidden' });
  }
  const invalid = validate();
  if (invalid) return reply(400, { _error: invalid });

  const key = cacheKey();
  try {
    const hit = await cache.get(key);
    if (hit) return reply(200, hit);
  } catch (err) {
    logger.warn({ route, key, err: err.message }, 'cache get error (non-fatal)');
  }

  const { status, body, ttlS } = await compute();
  if (status === 200 && ttlS) {
    try {
      await cache.put(key, body, ttlS);
    } catch (err) {
      logger.warn({ route, key, err: err.message }, 'cache put error (non-fatal)');
    }
  }
  return reply(status, body);
}

/**
 * Map a failed upstream fetch to our reply, logging it (every UpstreamFetchError
 * is logged):
 *   - network/timeout → 503, retryable by the client
 *   - upstream 429/5xx → passed through, retryable
 *   - any other upstream status (404/403/400/…) → our own 400 not-found. Never
 *     the raw upstream status: a bare 404 would trip fail2ban's gp-scanner jail
 *     (3 × 404 → 24h ban), which exists to catch scanners hitting unknown paths
 *     on OUR server, not users whose pasted link happens to 404 upstream.
 */
function upstreamFailure(err, logger, logFields) {
  const status = err.status;
  logger.warn({ ...logFields, status, err: err.message, cause: err.cause?.message }, 'upstream fetch failed');
  if (!status) return { status: 503, body: { _error: 'network' } };
  if (status === 429 || status >= 500) return { status, body: { _error: status } };
  return { status: 400, body: { _error: 'not-found' } };
}

// ── /v1/album ───────────────────────────────────────────────────────────────

/**
 * Resolve one pasted album URL: extract it from its own service, then
 * cross-link it to the others.
 *
 * @param {object}   p
 * @param {string}   p.method   HTTP method ('GET' | 'OPTIONS' | …)
 * @param {string}   p.origin   Origin request header (for CORS)
 * @param {string}   p.url      ?url= query value — the pasted album page
 * @param {string}   p.token    x-gp-token header, signed over `url`
 * @param {{get(k):Promise<any>, put(k,body,ttlS):Promise<void>}} p.cache
 * @param {typeof fetch} [p.fetchImpl]  injectable for tests
 * @param {object} [p.logger]  pino-shaped logger ({debug,info,warn,error}); defaults
 *                             to a no-op so importing/testing this module stays silent
 * @returns {Promise<{statusCode:number, headers:object, body:any}>}
 */
export async function albumRequest({ method, origin, url, token, cache, fetchImpl = fetch, logger = NOOP_LOGGER }) {
  let parsed, service;
  return signedJsonEndpoint({
    method, origin, token, cache, logger,
    route: '/v1/album',
    signedPayload: url || '',
    validate: () => {
      if (!url) return 'missing url';
      try { parsed = new URL(url); } catch { return 'bad url'; }
      service = serviceForHost(parsed.hostname);
      return service ? null : 'unsupported url';
    },
    cacheKey: () => `album:v1:${normalizeUrl(url)}`,
    compute: () => computeAlbum({ url, parsed, service, fetchImpl, logger }),
  });
}

async function computeAlbum({ url, parsed, service, fetchImpl, logger }) {
  let extracted;
  try {
    extracted = await EXTRACTORS[service](parsed, fetchImpl);
  } catch (err) {
    if (err instanceof UpstreamFetchError) return upstreamFailure(err, logger, { route: '/v1/album', service });
    logger.warn({ route: '/v1/album', service, err: err.message }, 'extraction error (treated as failed extraction)');
    extracted = null;
  }

  if (!extracted?.title) {
    // Fetched fine, but couldn't find an album in the response — markup
    // changed, or this wasn't really an album URL. Not worth retrying.
    logger.warn({ route: '/v1/album', service, url }, 'extraction found no album');
    return { status: 400, body: { _error: 'extraction-failed' } };
  }

  const serviceAlbumId = extracted.serviceAlbumId || slugFromPath(parsed.pathname);
  // A short link (canonicalUrl set by extractSpotify) is opaque and can expire
  // — store the real album page instead of the code the user happened to paste.
  const links = { [service]: { url: extracted.canonicalUrl || url } };
  if (service === 'spotify') links.spotify.nativeUri = `spotify:album:${serviceAlbumId}`;

  // Tracks whether any cross-link job actually threw (network/quota/etc.), as
  // opposed to running fine and finding no match — the two need different
  // cache TTLs (see the return below): a real failure deserves a quick retry,
  // a genuine no-match doesn't need re-checking for 60 days.
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
  return { status: 200, body, ttlS: crossLinkHadFailure ? PARTIAL_TTL_S : ALBUM_TTL_S };
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
  return signedJsonEndpoint({
    method, origin, token, cache, logger,
    route: '/v1/artist',
    // Bound to the same canonical string the client signed.
    signedPayload: `artist:${name || ''}|${albumId || ''}`,
    validate: () => {
      if (!name) return 'missing name';
      // albumId goes straight into a URL path; only ever a Deezer numeric id.
      if (albumId && !/^\d+$/.test(albumId)) return 'bad albumId';
      return null;
    },
    cacheKey: () => `artist:${normalizeArtist(name)}`,
    compute: () => computeArtist({ name, albumId, fetchImpl, logger }),
  });
}

async function computeArtist({ name, albumId, fetchImpl, logger }) {
  let image  = null;
  let genres = [];

  // Stage 1 — exact, via the Deezer album id. Genres ride along for free:
  // this is the same /album/{id} response already being fetched for the
  // artist image, and Deezer includes genres.data[].name on it. Stage 2
  // (search/artist) has no genre data, so genres stay [] unless Stage 1 ran.
  // Routed through fetchUpstream (same as the album extractors) so both calls
  // share its timeout and response-size cap instead of running unbounded.
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
      return { status: 503, body: { _error: 'network' } };
    }
  }

  // Cached even when there's no image — an artist Deezer doesn't have won't
  // appear next week either, and re-asking on every explore would be waste.
  return { status: 200, body: { image: image || null, genres }, ttlS: ARTIST_TTL_S };
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
  return signedJsonEndpoint({
    method, origin, token, cache, logger,
    route: '/v1/tracks',
    signedPayload: `tracks:${albumId || ''}`,
    validate: () => {
      if (!albumId) return 'missing albumId';
      // albumId goes straight into a URL path; only ever a Deezer numeric id.
      return /^\d+$/.test(albumId) ? null : 'bad albumId';
    },
    cacheKey: () => `tracks:${albumId}`,
    compute: () => computeTracks({ albumId, fetchImpl, logger }),
  });
}

async function computeTracks({ albumId, fetchImpl, logger }) {
  // Fetch and parse are separate try/catches on purpose: an UpstreamFetchError
  // (network/timeout/non-2xx) and a JSON.parse failure on a 200 body (Deezer
  // returning HTML, a truncated body past MAX_RESPONSE_BYTES, a captive
  // portal) both used to fall into one catch and become an unlogged, identical
  // not-found — indistinguishable from "this album genuinely has no tracks".
  // Permanent failures answer 400, the same as /v1/album: the client treats
  // every non-2xx here alike, and one status per meaning across endpoints is
  // one less thing to keep in sync (fail2ban only bans 404s, never these).
  let text;
  try {
    text = await fetchUpstream(`${DEEZER_BASE}/album/${albumId}`, fetchImpl);
  } catch (err) {
    if (err instanceof UpstreamFetchError) return upstreamFailure(err, logger, { route: '/v1/tracks', albumId });
    logger.warn({ route: '/v1/tracks', albumId, err: err.message }, 'unexpected fetch error');
    return { status: 400, body: { _error: 'not-found' } };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    logger.warn({ route: '/v1/tracks', albumId, bodyLen: text.length, err: err.message },
      'tracks response unparseable');
    return { status: 400, body: { _error: 'not-found' } };
  }

  if (data?.error) {
    // Deezer reports quota-exceeded as an HTTP-200 envelope (error.code === 4),
    // not a real 429 — treat it as retryable rather than "no such album".
    if (data.error.code === 4) return { status: 429, body: { _error: 429 } };
    logger.warn({ route: '/v1/tracks', albumId, deezerErrorCode: data.error.code }, 'deezer error envelope');
    return { status: 400, body: { _error: 'not-found' } };
  }

  const tracks = (data?.tracks?.data || []).map(t => ({
    number:      t.track_position ?? null,
    name:        t.title || null,
    duration_ms: typeof t.duration === 'number' ? t.duration * 1000 : null,
  }));

  if (!tracks.length) {
    logger.warn({ route: '/v1/tracks', albumId, hasTracksField: !!data?.tracks }, 'tracks empty');
  }

  // An empty result gets a short TTL (the same one /v1/album uses for a
  // partial cross-link) rather than the full 30-day TRACKS_TTL_S — a bad
  // Deezer response used to poison the album for a month with no way to
  // retry short of the cache expiring.
  return { status: 200, body: { tracks }, ttlS: tracks.length ? TRACKS_TTL_S : PARTIAL_TTL_S };
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
