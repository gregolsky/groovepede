import { LASTFM_KEY, RESOLVER_BASE, MUSICBRAINZ_BASE, COVERART_BASE, AUDIODB_BASE, THROTTLE } from './config.js';
import { signRequestToken } from './sign.js';
import { loadAlbums, updateAlbum, extractAlbumId } from './storage.js';
import { createThrottle } from './throttle.js';
import { reportFailure } from './beacon.js';

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
  return { _error: 429, ...(retryAfter != null && { _retryAfter: retryAfter }) };
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
 * GET one of our resolver's endpoints. `signedPayload` is what the resolver
 * reconstructs and verifies for that route (see backend/resolver-core.mjs):
 * the album URL for /v1/album, `tracks:<id>`, `artist:<name>|<albumId>`.
 */
async function resolverGet(path, params, signedPayload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithTimeout(`${RESOLVER_BASE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'x-gp-token': await signRequestToken(signedPayload) },
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
    const res = await resolverGet('/v1/album', { url: inputUrl }, inputUrl, ALBUM_TIMEOUT_MS);
    if (!res.ok) {
      if (res.status === 429) return rateLimitError(res);
      return { _error: res.status };
    }
    const data = await res.json();

    return {
      id:            data.id,
      sourceUrl:     inputUrl,
      title:         data.title || null,
      artist:        data.artist || null,
      cover:         data.cover || null,
      year:          data.year || null,
      tags:          data.tags || [],
      addedAt:       new Date().toISOString(),
      links:         data.links || {},
    };
  } catch {
    return { _error: 'network' };
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
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.genres || []).map(g => g.name).filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve a single URL via MusicBrainz. Returns album record or { _error }. */
export async function resolveAlbumMusicBrainz(sourceUrl, service) {
  try {
    const params = new URLSearchParams({ resource: sourceUrl, inc: 'release-rels+artist-credits', fmt: 'json' });
    const res = await fetchWithTimeout(`${MUSICBRAINZ_BASE}/url?${params}`);
    if (!res.ok) return { _error: res.status };
    const data = await res.json();
    const rec  = parseMbRelease(data, sourceUrl, service);
    if (!rec) return { _error: 'not-found' };
    rec.tags = await fetchMbReleaseGenres(rec.id.slice(3)); // strip the 'mb:' prefix back to the raw mbid
    return rec;
  } catch {
    return { _error: 'network' };
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
    lastResolverErr = { _error: 429 }; // cooldown active = effectively rate-limited
  }
  // MusicBrainz fallback (throttled independently)
  const mbRec = await throttles.musicbrainz.run(() => resolveAlbumMusicBrainz(sourceUrl, service));
  if (!mbRec._error) return mbRec;
  return lastResolverErr; // both failed — caller leaves stub pending
}

/** Concatenate tag lists, keeping the first occurrence of each tag, in order. */
const mergeUnique = (...lists) => [...new Set(lists.flat())];

// Fetch Last.fm tags in the background and update the saved album.
// onUpdate() is called after storage is written so the caller can re-render.
export async function enrichWithLastfm(albumId, artistName, albumTitle, onUpdate) {
  if (!artistName) return; // extraction can succeed with a title but no artist
  const primaryArtist = artistName.split(',')[0].trim();

  // Fetch artist + album tags in parallel; artist tags take priority
  const [artistTags, albumData] = await Promise.all([
    fetchArtistTags(primaryArtist),
    fetchLastfmAlbum(primaryArtist, albumTitle),
  ]);

  // Read-only snapshot: only used to decide which further lookups are worth
  // making. It is never written back — see the commit at the end.
  const snapshot = loadAlbums().find(x => x.id === albumId);
  if (!snapshot) return; // left the queue while Last.fm was answering

  // The album's existing (resolver-supplied) tags come first — they're already
  // curated per-album — then artist tags, then album tags. This is an
  // enrichment pass, not a replacement: Last.fm coverage is spotty, and
  // overwriting a resolver-supplied genre with a thinner Last.fm result would
  // be a regression, not enrichment.
  let tags = mergeUnique(snapshot.tags || [], artistTags, albumData.tags);

  // Fall back to similar artists if we still have nothing at all
  if (!tags.length) tags = await fetchTagsFromSimilarArtists(primaryArtist);

  // Last.fm coverage thins out fast for obscure artists. Deezer's own (coarser)
  // genre labels fill that gap — but only when Last.fm came up thin, so a
  // well-tagged mainstream album isn't diluted with broad Deezer categories.
  const deezerId = deezerAlbumId(snapshot);
  if (tags.length < 3 && deezerId) {
    const deezerData = await fetchDeezerArtistData(primaryArtist, deezerId);
    if (deezerData?.genres?.length) {
      tags = mergeUnique(tags, cleanTags(deezerData.genres.map(name => ({ name })), primaryArtist));
    }
  }

  if (!tags.length) return;
  // Commit in one synchronous step against the record as it is NOW, not the
  // snapshot: the awaits above can take seconds under throttling, and the
  // queue may have changed meanwhile (updateAlbum is a no-op if it's gone).
  const saved = updateAlbum(albumId, a => { a.tags = mergeUnique(a.tags || [], tags).slice(0, 7); });
  if (saved) onUpdate?.();
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

async function _lfmGet(params) {
  const p = new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  try {
    const res = await fetchWithTimeout(LASTFM + '?' + p, {}, 8000);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function lfmGet(params) {
  return throttles.lastfm.run(() => _lfmGet(params));
}

export async function fetchLastfmAlbum(artist, album) {
  const data = await lfmGet({ method: 'album.getinfo', artist, album, autocorrect: '1' });
  const tags = cleanTags(asArray(data?.album?.tags?.tag).slice(0, 5), artist);
  return { tags };
}

const BIO_MAX_CHARS = 900;

// 4-digit years ("1990") and 2-digit decades ("90s") are both common Last.fm
// crowd tags and neither is a genre.
const YEAR_RE = /^\d{2,4}s?$/;

// Crowd-tag noise that isn't a genre: possession/format tags and bare
// opinion tags. Not exhaustive by design — extend as more noise turns up.
const JUNK_TAGS = new Set([
  'seen live', 'favorites', 'favourite', 'under 2000 listeners',
  'albums i own', 'vinyl', 'cd', 'digital', 'owned', 'wishlist',
  'awesome', 'amazing', 'love', 'favourite song',
]);

// Near-duplicate spellings Last.fm's crowd tagging produces often enough to
// be worth collapsing into one canonical form before dedup. Not a general
// genre-taxonomy normalizer — just the handful of variants seen in practice.
const CANON_MAP = {
  'hip hop':     'hip-hop',
  'hiphop':      'hip-hop',
  'lofi':        'lo-fi',
  'lo fi':       'lo-fi',
  'synthpop':    'synth-pop',
  'postpunk':    'post-punk',
  'post punk':   'post-punk',
  'postrock':    'post-rock',
  'drum n bass': 'drum and bass',
  'dnb':         'drum and bass',
  'd&b':         'drum and bass',
};

function normalizeForCompare(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Lowercase, canonicalize near-duplicate spellings, drop junk/year tags and
 * duplicates, and drop a tag that's just the artist's own name (Last.fm
 * frequently self-tags an artist). `artistName` is the artist these specific
 * raw tags came from — the primary artist for fetchArtistTags/
 * fetchLastfmAlbum, or each similar artist in fetchTagsFromSimilarArtists.
 */
export function cleanTags(rawTags, artistName) {
  const artistNorm = artistName ? normalizeForCompare(artistName) : null;
  const seen = new Set();
  const out = [];
  for (const raw of rawTags) {
    let t = raw.name.toLowerCase();
    t = CANON_MAP[t] || t;
    if (t.length <= 1 || t.length > 25) continue;
    if (YEAR_RE.test(t) || JUNK_TAGS.has(t)) continue;
    if (artistNorm && normalizeForCompare(t) === artistNorm) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function fetchArtistTags(artist) {
  const data = await lfmGet({ method: 'artist.gettoptags', artist, autocorrect: '1' });
  return cleanTags(asArray(data?.toptags?.tag).filter(t => t.count >= 5).slice(0, 5), artist);
}

async function fetchTagsFromSimilarArtists(artist) {
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
 * - Strip all non-alphanumeric, collapse whitespace, lowercase
 */
export function normalizeAlbumStr(s) {
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

/**
 * Sentinel returned by fetchAlbumTracks on failure — distinct from `[]` (a
 * genuinely track-less album, e.g. no Deezer cross-link) and from
 * `undefined` (not fetched yet), so callers can tell "empty" from "broken"
 * apart and offer a retry instead of rendering identical blank space for
 * both. A single frozen object rather than e.g. `null`, so `trackCache[id]
 * === TRACKS_ERROR` is an unambiguous identity check.
 */
export const TRACKS_ERROR = Object.freeze({ _tracksError: true });

/**
 * A Deezer album's tracklist via our resolver (api.deezer.com sends no CORS
 * header, so the browser can't call it directly). `albumId` is Deezer's own
 * numeric album id — see deezerAlbumId() below.
 *
 * Returns an array (possibly empty) on success, or TRACKS_ERROR on any
 * failure — never throws, and never returns the throttle's raw `{_error:429}`
 * marker (that object used to be stored directly in trackCache, where its
 * truthiness permanently blocked any retry after a single transient 429).
 * Every failure is also reported through the client beacon (see
 * frontend/src/js/beacon.js) with the real status, so "why didn't this
 * tracklist load" is answerable from the resolver's own logs.
 */
export async function fetchAlbumTracks(albumId) {
  if (!albumId) return [];
  // Fail fast instead of queueing behind an active cooldown — this throttle
  // is shared with artist-image fetches, so without this check a cooldown
  // triggered by an unrelated call could leave "Loading tracks…" on screen
  // for up to 5 minutes (see THROTTLE.deezer's maxCooldownMs in config.js).
  if (throttles.deezer.coolingDown()) return TRACKS_ERROR;

  const result = await throttles.deezer.run(async () => {
    try {
      const res = await resolverGet('/v1/tracks', { albumId }, `tracks:${albumId}`);
      if (!res.ok) return res.status === 429 ? rateLimitError(res) : { _httpError: res.status };
      const data = await res.json();
      return data?.tracks || [];
    } catch (err) {
      return { _networkError: err?.name === 'AbortError' ? 'timeout' : 'network' };
    }
  });

  if (Array.isArray(result)) return result;
  // The throttle above already saw the raw {_error:429} shape it needs to
  // manage cooldown (is429/retryAfterOf read the direct return of run()'s
  // callback) — everything past this point sanitizes into one failure shape.
  const status = is429(result) ? 429 : (result?._httpError || result?._networkError || 'unknown');
  reportFailure('tracklist-fetch-failed', { msg: String(status), albumId, route: '/v1/tracks' });
  return TRACKS_ERROR;
}

export async function fetchLastfmArtist(artistName) {
  const [infoData, similarData, tags] = await Promise.all([
    lfmGet({ method: 'artist.getinfo',    artist: artistName, autocorrect: '1' }),
    lfmGet({ method: 'artist.getsimilar', artist: artistName, limit: '6', autocorrect: '1' }),
    fetchArtistTags(artistName),
  ]);

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
// Order: Spotify (caller, when connected — explicitly licensed and already
// attributed) → TheAudioDB (browser-direct, CORS-enabled, free) → Deezer via
// our resolver (best coverage, but api.deezer.com sends no CORS header).
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
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  });
  const want  = normalizeAlbumStr(artistName);
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
 * Returns `{ image: string|null, genres: string[] }`, a rate-limit error
 * object (`{ _error: 429, ... }`), or `null` on failure.
 */
export async function fetchDeezerArtistData(artistName, albumId) {
  return throttles.deezer.run(async () => {
    try {
      const params = albumId ? { name: artistName, albumId } : { name: artistName };
      const res = await resolverGet('/v1/artist', params, `artist:${artistName}|${albumId || ''}`);
      if (!res.ok) return res.status === 429 ? rateLimitError(res) : null;
      const data = await res.json();
      return { image: isBlankImage(data?.image) ? null : data.image, genres: data?.genres || [] };
    } catch { return null; }
  });
}

/** Deezer's numeric album id out of a links.deezer url, or null. */
export function deezerAlbumId(album) {
  const url = album?.links?.deezer?.url;
  return url ? (url.match(/\/album\/(\d+)/)?.[1] || null) : null;
}

/**
 * Artist image for an album, trying the free browser-direct source first and
 * only falling back to our resolver. Returns a URL or null.
 */
export async function fetchArtistImage(album) {
  const artist = (album?.artist || '').split(',')[0].trim();
  if (!artist) return null;

  const fromAudiodb = await fetchAudiodbArtistImage(artist);
  if (fromAudiodb) return fromAudiodb;

  const fromDeezer = await fetchDeezerArtistData(artist, deezerAlbumId(album));
  return typeof fromDeezer?.image === 'string' ? fromDeezer.image : null;
}
