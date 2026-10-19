import { LASTFM_KEY, RESOLVER_BASE, MUSICBRAINZ_BASE, COVERART_BASE, AUDIODB_BASE, THROTTLE } from './config.js';
import { signRequestToken } from './sign.js';
import { signedPayload } from './signed-payloads.js';
import { extractAlbumId } from '../domain/links.js';
import { createThrottle } from '../lib/throttle.js';
import { cleanTags } from '../domain/tags.js';
import { primaryArtistOf, deezerAlbumId } from '../domain/albums.js';
import { reportFailure } from './beacon.js';
import { apiError, isApiError } from '../lib/api-error.js';

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';

// Last.fm returns a single item as an object instead of a 1-element array.
const asArray = v => Array.isArray(v) ? v : v == null ? [] : [v];

// ── Per-service throttlers ────────────────────────────────────────────────────
// One throttler per rate-limited endpoint — owns global pacing + 429 cooldown.
// Raw API functions are "just calls"; throttling is applied at the choke points
// below so all call sites automatically respect rate limits.

const is429        = r => r?._error === 429;
const retryAfterMs = r => r?._retryAfter != null ? r._retryAfter * 1000 : null;

/**
 * The error shape every rate-limited response returns. `_retryAfter` (seconds,
 * from the server's Retry-After header) is only present when the server sent a
 * usable one — the throttler treats its absence as "escalate our own backoff".
 */
function rateLimitError(res) {
  const raw = res.headers?.get?.('retry-after');
  const retryAfter = raw ? (parseInt(raw, 10) || null) : null;
  return apiError(429, retryAfter != null ? { _retryAfter: retryAfter } : undefined);
}

/** The ApiError for a non-ok response; a 429 carries the server's Retry-After. */
function statusError(res) {
  return res.status === 429 ? rateLimitError(res) : apiError(res.status);
}

function makeThrottles() {
  return {
    resolver:    createThrottle({ ...THROTTLE.resolver,    isRateLimited: is429, retryAfterOf: retryAfterMs }),
    musicbrainz: createThrottle({ ...THROTTLE.musicbrainz, isRateLimited: is429, retryAfterOf: retryAfterMs }),
    lastfm:      createThrottle({ ...THROTTLE.lastfm }),  // rarely rate-limits; pace only
    audiodb:     createThrottle({ ...THROTTLE.audiodb }), // shared free key; pace only
    deezer:      createThrottle({ ...THROTTLE.deezer,     isRateLimited: is429, retryAfterOf: retryAfterMs }),
  };
}

let throttles = makeThrottles();

/** Override throttles (tests only) — inject no-op / fake-clock instances. */
export function _setThrottles(t) { throttles = { ...throttles, ...t }; }

// ── Failure reporting ─────────────────────────────────────────────────────────
// The rule for every touch point in this file: a failure is either returned
// to a caller that reports it, or reported here before being swallowed — a
// call that fails with nobody told is the one kind of failure that's never
// debuggable. What gets reported is a transport failure: network, timeout,
// 5xx, 429, a malformed body. An expected answer (a 404, "no such artist") is
// data, not a failure, and isn't. Reports go to the resolver's logs via the
// beacon (beacon.js), which dedupes per session.

/** Why a fetch() or res.json() call threw. */
function rejectionReason(err) {
  if (err?.name === 'AbortError') return 'timeout';        // our own deadline
  if (err instanceof SyntaxError) return 'bad-response';   // res.json() on a non-JSON body
  return 'network';
}

/** True for a status meaning the service is failing, as opposed to answering "no". */
const isTransportStatus = status => status === 429 || status >= 500;

function reportApiFailure(route, reason) {
  // The route goes into msg too: the beacon dedupes on kind|msg, and the same
  // reason from two different services is two different problems.
  reportFailure('api-failed', { route, msg: `${route} ${reason}` });
}

/** Report why a fetch()/res.json() call threw, and return that as an ApiError. */
function reportRejection(route, err) {
  const reason = rejectionReason(err);
  reportApiFailure(route, reason);
  return apiError(reason);
}

/** Report `res` if it's a transport failure; returns res.ok for convenience. */
function checkResponse(route, res) {
  if (!res.ok && isTransportStatus(res.status)) reportApiFailure(route, res.status);
  return res.ok;
}

// ── Fetch with a deadline ─────────────────────────────────────────────────────
// Every outbound call gets one. Without it a stalled connection never settles,
// and whatever awaits it — the Add button's spinner, a throttle slot that
// every later call queues behind — waits forever.

// /v1/album can legitimately take ~24s (short-link redirect + page fetch +
// cross-linking; see nginx's proxy_read_timeout for `location /`), so the
// client waits a little longer than that: on a slow upstream, nginx's own
// answer arrives before we give up.
const ALBUM_TIMEOUT_MS   = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * fetch(), aborted after `timeoutMs`. Resolves to the Response or rejects
 * (network failure, or an AbortError on timeout) exactly like fetch() —
 * callers keep their own mapping of a rejection to their failure shape.
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET one of our resolver's endpoints. `payload` is the string signed into
 * x-gp-token — always built with signedPayload (signed-payloads.js), whose
 * formats the resolver's contract test checks against the server side.
 */
async function resolverGet(path, params, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithTimeout(`${RESOLVER_BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'x-gp-token': await signRequestToken(payload) },
  }, timeoutMs);
}

// ── Resolver (album-page extraction + cross-service links) ───────────────────

/**
 * Resolve a pasted album URL to a full record. The resolver (backend/) fetches
 * the album page itself (browsers can't — CORS), extracts title/artist/cover/
 * year with a per-service routine, and cross-links the two services with a
 * free keyless search API (Deezer, Apple). Returns the resolver's record with
 * sourceUrl/addedAt layered on, or `{ _error }` on failure.
 */
export async function resolveAlbum(inputUrl) {
  try {
    const res = await resolverGet('/v1/album', { url: inputUrl }, signedPayload.album(inputUrl), ALBUM_TIMEOUT_MS);
    // A 4xx is the caller's to report, as the add outcome.
    if (!checkResponse('/v1/album', res)) return statusError(res);
    const data = await res.json();
    // Every stored record needs an id (dedupe, updates, card ids all key on
    // it). A 200 without one is a broken response — retryable, so the link is
    // kept as a pending stub rather than saved id-less.
    if (!data?.id) {
      reportApiFailure('/v1/album', 'bad-response');
      return apiError('network');
    }

    return {
      id:            data.id,
      sourceUrl:     inputUrl,
      title:         data.title || null,
      artist:        data.artist || null,
      cover:         data.cover || null,
      year:          data.year || null,
      tags:          cleanTags((data.tags || []).map(name => ({ name })), data.artist),
      addedAt:       new Date().toISOString(),
      links:         data.links || {},
    };
  } catch (err) {
    reportApiFailure('/v1/album', rejectionReason(err));
    return apiError('network');
  }
}

// ── Resilient resolver (our resolver + MusicBrainz fallback) ─────────────────

/**
 * Map a MusicBrainz url-lookup response to an album record.
 * Returns null when no release relation is present.
 */
export function parseMbRelease(data, sourceUrl, service) {
  const rel = (data?.relations || []).find(r => r['target-type'] === 'release' && r.release);
  if (!rel) return null;
  const release = rel.release;
  const mbid    = release.id;
  const title   = release.title || null;
  const year    = (release.date || '').slice(0, 4) || null;
  const credits = release['artist-credit'] || [];
  const artist  = credits.map(c => typeof c === 'string' ? c : (c.name || c.artist?.name || '')).join('').trim() || null;

  const cover = mbid ? `${COVERART_BASE}/release/${mbid}/front-500` : null;

  // Reconstruct service link from sourceUrl
  const links = {};
  if (service) {
    const nativeUri = service === 'spotify'
      ? (extractAlbumId(sourceUrl) ? `spotify:album:${extractAlbumId(sourceUrl)}` : null)
      : null;
    links[service] = { url: sourceUrl, nativeUri };
  }

  return {
    id:            'mb:' + mbid,
    sourceUrl,
    title,
    artist,
    cover,
    year,
    tags:          [],
    addedAt:       new Date().toISOString(),
    links,
  };
}

/**
 * Genres for an already-known MusicBrainz release. MB's `/url` lookup (used
 * to find the release in the first place) doesn't support `inc=genres` — only
 * relationship includes — so this is a second, separate request. Only called
 * for records MusicBrainz itself resolved (our resolver already failed on them), so
 * it's not a cost paid on every album. Runs inside the same throttled slot as
 * the release lookup that found `mbid` (see resolveAlbumMusicBrainz) rather
 * than taking its own throttles.musicbrainz.run() — nesting a second call
 * into that per-service throttle would queue behind itself and deadlock,
 * since only one operation runs through it at a time. Degrades to [] on any
 * failure so a slow/rate-limited genre lookup never fails the resolve itself.
 */
async function fetchMbReleaseGenres(mbid) {
  try {
    const params = new URLSearchParams({ inc: 'genres', fmt: 'json' });
    const res = await fetchWithTimeout(`${MUSICBRAINZ_BASE}/release/${mbid}?${params}`);
    if (!checkResponse('musicbrainz:release', res)) return [];
    const data = await res.json();
    return data?.genres || [];
  } catch (err) {
    reportApiFailure('musicbrainz:release', rejectionReason(err));
    return [];
  }
}

/** Resolve a single URL via MusicBrainz. Returns album record or { _error }. */
export async function resolveAlbumMusicBrainz(sourceUrl, service) {
  try {
    const params = new URLSearchParams({ resource: sourceUrl, inc: 'release-rels+artist-credits', fmt: 'json' });
    const res = await fetchWithTimeout(`${MUSICBRAINZ_BASE}/url?${params}`);
    // Reported here, not by the caller: resolveAlbumResilient returns the
    // resolver's error when both fail, so MusicBrainz's own would be lost.
    if (!checkResponse('musicbrainz:url', res)) return statusError(res);
    const data = await res.json();
    const rec  = parseMbRelease(data, sourceUrl, service);
    if (!rec) return apiError('not-found');
    rec.tags = cleanTags(await fetchMbReleaseGenres(rec.id.slice(3)), rec.artist); // strip the 'mb:' prefix back to the raw mbid
    return rec;
  } catch (err) {
    reportApiFailure('musicbrainz:url', rejectionReason(err));
    return apiError('network');
  }
}

/**
 * Resolve via our resolver (throttled), falling back to MusicBrainz (throttled).
 * Skips the resolver entirely when its throttler is in cooldown.
 * Returns a resolved record or the last error (stub stays pending for next pass).
 */
export async function resolveAlbumResilient(sourceUrl, { service } = {}) {
  let lastResolverErr;
  if (!throttles.resolver.coolingDown()) {
    lastResolverErr = await throttles.resolver.run(() => resolveAlbum(sourceUrl));
    if (!lastResolverErr._error) return lastResolverErr;
  } else {
    lastResolverErr = apiError(429); // cooldown active = effectively rate-limited
  }
  // MusicBrainz fallback (throttled independently)
  const mbRec = await throttles.musicbrainz.run(() => resolveAlbumMusicBrainz(sourceUrl, service));
  if (!mbRec._error) return mbRec;
  return lastResolverErr; // both failed — caller leaves stub pending
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

async function _lfmGet(params) {
  const p = new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  const route = `lastfm:${params.method}`;
  try {
    const res = await fetchWithTimeout(LASTFM + '?' + p, {}, 8000);
    if (!checkResponse(route, res)) return apiError(res.status);
    return await res.json();
  } catch (err) {
    return reportRejection(route, err);
  }
}

function lfmGet(params) {
  return throttles.lastfm.run(() => _lfmGet(params));
}

export async function fetchLastfmAlbum(artist, album) {
  const data = await lfmGet({ method: 'album.getinfo', artist, album, autocorrect: '1' });
  if (isApiError(data)) return data;
  const tags = cleanTags(asArray(data?.album?.tags?.tag).slice(0, 5), artist);
  return { tags };
}

const BIO_MAX_CHARS = 900;

export async function fetchArtistTags(artist) {
  const data = await lfmGet({ method: 'artist.gettoptags', artist, autocorrect: '1' });
  return cleanTags(asArray(data?.toptags?.tag).filter(t => t.count >= 5).slice(0, 5), artist);
}

export async function fetchTagsFromSimilarArtists(artist) {
  const simData = await lfmGet({ method: 'artist.getsimilar', artist, limit: '4', autocorrect: '1' });
  const simArtists = asArray(simData?.similarartists?.artist).slice(0, 4);
  const counts = {};
  const results = await Promise.all(
    simArtists.map(a => lfmGet({ method: 'artist.gettoptags', artist: a.name, autocorrect: '1' }))
  );
  results.forEach((data, i) => {
    const tags = cleanTags(asArray(data?.toptags?.tag).filter(t => t.count >= 15).slice(0, 5), simArtists[i]?.name);
    for (const name of tags) counts[name] = (counts[name] || 0) + 1;
  });
  // Keep tags that appear in at least 2 similar artists
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

/**
 * Normalise an album/artist string for fuzzy matching:
 * - Unicode NFKD + strip combining diacritics
 * - Drop common edition/parenthetical noise
 * - Keep only letters and digits (any script), collapse whitespace, lowercase
 */
export function normalizeAlbumStr(s) {
  if (!s) return '';
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[-–—:]\s*(single|ep|album|remaster(?:ed)?|deluxe(?:\s+edition)?|expanded(?:\s+edition)?|bonus\s+tracks?|anniversary\s+edition|special\s+edition)\s*$/i, '')
    .replace(/\s*\((?:deluxe|remaster(?:ed)?|expanded|bonus\s+tracks?|anniversary|special|edition|version)[^)]*\)/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A Deezer album's tracklist via our resolver (api.deezer.com sends no CORS
 * header, so the browser can't call it directly). `albumId` is Deezer's own
 * numeric album id — see deezerAlbumId() below.
 *
 * Returns an array (possibly empty — a genuinely track-less album, e.g. no
 * Deezer cross-link) on success, or an ApiError (isApiError()) on any
 * failure — never throws. Callers use the array/ApiError distinction to tell
 * "empty" from "broken" apart and offer a retry instead of rendering
 * identical blank space for both; `undefined` (never fetched) is the third
 * state, entirely the caller's (trackCache starts empty).
 * Every failure is also reported through the client beacon (see
 * frontend/src/js/infra/beacon.js) with the real status, so "why didn't this
 * tracklist load" is answerable from the resolver's own logs.
 */
export async function fetchAlbumTracks(albumId) {
  if (!albumId) return [];
  // Fail fast instead of queueing behind an active cooldown — this throttle
  // is shared with artist-image fetches, so without this check a cooldown
  // triggered by an unrelated call could leave "Loading tracks…" on screen
  // for up to 5 minutes (see THROTTLE.deezer's maxCooldownMs in config.js).
  // Silent (no reportFailure): whatever tripped the cooldown already reported it.
  if (throttles.deezer.coolingDown()) return apiError(429);

  const result = await throttles.deezer.run(async () => {
    try {
      const res = await resolverGet('/v1/tracks', { albumId }, signedPayload.tracks(albumId));
      if (!res.ok) return statusError(res);
      const data = await res.json();
      return data?.tracks || [];
    } catch (err) {
      return apiError(rejectionReason(err));
    }
  });

  if (Array.isArray(result)) return result;
  // result is already an ApiError — the same shape the throttle itself read
  // (is429/retryAfterOf) to manage cooldown, so no translation layer needed.
  reportFailure('tracklist-fetch-failed', { msg: String(result._error), albumId, route: '/v1/tracks' });
  return result;
}

export async function fetchLastfmArtist(artistName) {
  const [infoData, similarData, tags] = await Promise.all([
    lfmGet({ method: 'artist.getinfo',    artist: artistName, autocorrect: '1' }),
    lfmGet({ method: 'artist.getsimilar', artist: artistName, limit: '6', autocorrect: '1' }),
    fetchArtistTags(artistName),
  ]);

  // Only surface a failure when BOTH calls that carry the bio/similar data
  // failed to run — either one succeeding (even with a thin or "not found"
  // answer) is a genuine result worth showing, not a failure to retry.
  if (isApiError(infoData) && isApiError(similarData)) return infoData;

  // Strip the Last.fm "Read more" link, then all remaining markup.
  let bio = infoData?.artist?.bio?.content || infoData?.artist?.bio?.summary || '';
  bio = bio.replace(/<a href="https:\/\/www\.last\.fm[^"]*"[^>]*>.*?<\/a>/gi, '').trim();
  bio = bio.replace(/<[^>]+>/g, '').trim();

  // Truncate for the explore panel. `content` is unbounded — Last.fm returns
  // 62 000 characters for Miles Davis, which rendered as a 15 000 px wall of
  // text before this was capped.
  if (bio.length > BIO_MAX_CHARS) bio = bio.slice(0, BIO_MAX_CHARS).replace(/\s+\S*$/, '') + '…';

  const similar = asArray(similarData?.similarartists?.artist)
    .slice(0, 6)
    .map(a => ({ name: a.name, url: a.url }));

  const lastfmUrl = infoData?.artist?.url || null;

  return { bio, similar, tags, lastfmUrl };
}

// ── Artist images ─────────────────────────────────────────────────────────────
// Deliberately NOT from Last.fm: artist.getinfo has returned the same
// placeholder image for every artist since Last.fm dropped artist photos in
// 2019 (album.getinfo images are still real — it's artist images specifically).
// Album-page extraction carries no artist imagery either, only album covers.
//
// Order: TheAudioDB (browser-direct, CORS-enabled, free) → Deezer via our
// resolver (best coverage, but api.deezer.com sends no CORS header).
// Only URLs are handled anywhere in this chain; the browser loads the image
// itself straight from the source's CDN.

/** Deezer's "no photo" placeholders, and TheAudioDB's empty values. */
function isBlankImage(url) {
  if (!url) return true;
  return url.includes('/artist//') || url.includes('d41d8cd98f00b204e9800998ecf8427e');
}

/**
 * TheAudioDB artist thumbnail, or null. Strict name match — their search is
 * fuzzy and a wrong artist's face is worse than no face.
 * Coverage skews mainstream; the Deezer fallback catches the long tail.
 */
export async function fetchAudiodbArtistImage(artistName) {
  const data = await throttles.audiodb.run(async () => {
    try {
      const res = await fetchWithTimeout(`${AUDIODB_BASE}/search.php?s=${encodeURIComponent(artistName)}`);
      if (!checkResponse('audiodb:search', res)) return apiError(res.status);
      return await res.json();
    } catch (err) {
      return reportRejection('audiodb:search', err);
    }
  });
  if (isApiError(data)) return data;
  const want  = normalizeAlbumStr(artistName);
  if (!want) return null; // folds to '' — would "match" any other such name
  const match = (data?.artists || []).find(a => normalizeAlbumStr(a?.strArtist) === want);
  // Their CDN serves https fine even though some records store an http:// URL,
  // and a mixed-content image would be blocked outright on our https origin.
  const img = (match?.strArtistThumb || match?.strArtistWideThumb || '').replace(/^http:/, 'https:');
  return isBlankImage(img) ? null : img;
}

/**
 * Deezer artist image + genres via our resolver, in a single call. `albumId`
 * (Deezer's own album id, which /v1/album hands us for free in links.deezer
 * whenever cross-linking found a match) makes the lookup exact; without it the
 * resolver falls back to a strict name match and returns no genres (Deezer's
 * search endpoint doesn't carry them).
 * Returns `{ image: string|null, genres: string[] }` on success, or an
 * ApiError (isApiError()) on any failure, including a 429.
 */
export async function fetchDeezerArtistData(artistName, albumId) {
  return throttles.deezer.run(async () => {
    try {
      const params = albumId ? { name: artistName, albumId } : { name: artistName };
      const res = await resolverGet('/v1/artist', params, signedPayload.artist(artistName, albumId));
      if (!checkResponse('/v1/artist', res)) return statusError(res);
      const data = await res.json();
      return { image: isBlankImage(data?.image) ? null : data.image, genres: data?.genres || [] };
    } catch (err) {
      return reportRejection('/v1/artist', err);
    }
  });
}

/**
 * Artist image for an album, trying the free browser-direct source first and
 * only falling back to our resolver. Returns a URL, `null` when neither
 * source has a photo, or an ApiError only when BOTH sources failed to run —
 * either one running fine and simply finding no image is a genuine "no
 * photo", not a failure worth retrying.
 */
export async function fetchArtistImage(album) {
  const artist = primaryArtistOf(album?.artist);
  if (!artist) return null;

  const fromAudiodb = await fetchAudiodbArtistImage(artist);
  if (typeof fromAudiodb === 'string') return fromAudiodb;

  const fromDeezer = await fetchDeezerArtistData(artist, deezerAlbumId(album));
  if (typeof fromDeezer?.image === 'string') return fromDeezer.image;

  return (isApiError(fromAudiodb) && isApiError(fromDeezer)) ? fromDeezer : null;
}
