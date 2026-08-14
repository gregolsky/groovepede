import { LASTFM_KEY, ODESLI_BASE, MUSICBRAINZ_BASE, COVERART_BASE, AUDIODB_BASE, THROTTLE } from './config.js';
import { signRequestToken } from './sign.js';
import { getToken, refreshAccessToken } from './auth.js';
import { loadAlbums, saveAlbums, extractAlbumId } from './storage.js';
import { ODESLI_KEY_MAP } from './services.js';
import { createThrottle } from './throttle.js';

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
    odesli:      createThrottle({ ...THROTTLE.odesli,      isRateLimited: is429, retryAfterOf: retryAfterMs }),
    musicbrainz: createThrottle({ ...THROTTLE.musicbrainz, isRateLimited: is429, retryAfterOf: retryAfterMs }),
    lastfm:      createThrottle({ ...THROTTLE.lastfm }),  // rarely rate-limits; pace only
    spotify:     createThrottle({ ...THROTTLE.spotify,    isRateLimited: is429, retryAfterOf: retryAfterMs }),
    audiodb:     createThrottle({ ...THROTTLE.audiodb }), // shared free key; pace only
    deezer:      createThrottle({ ...THROTTLE.deezer,     isRateLimited: is429, retryAfterOf: retryAfterMs }),
  };
}

let throttles = makeThrottles();

/** Override throttles (tests only) — inject no-op / fake-clock instances. */
export function _setThrottles(t) { throttles = { ...throttles, ...t }; }

// ── Odesli (universal resolver) ───────────────────────────────────────────────

export async function resolveAlbum(inputUrl) {
  try {
    const params = new URLSearchParams({ url: inputUrl, userCountry: 'US' });
    const res = await fetch(`${ODESLI_BASE}/v1/resolve?${params}`, {
      headers: { 'x-gp-token': await signRequestToken(inputUrl) },
    });
    if (!res.ok) {
      if (res.status === 429) return rateLimitError(res);
      return { _error: res.status };
    }
    const data = await res.json();

    const primary = data.entitiesByUniqueId?.[data.entityUniqueId] || {};

    // Build normalized links map
    const links = {};
    for (const [oKey, entry] of Object.entries(data.linksByPlatform || {})) {
      const slug = ODESLI_KEY_MAP[oKey];
      if (!slug) continue;
      if (links[slug]) continue; // youtube wins over youtubeMusic
      links[slug] = {
        url: entry.url,
        nativeUri: entry.nativeAppUriMobile || entry.nativeAppUriDesktop || null,
      };
    }

    return {
      id:            data.entityUniqueId,
      sourceUrl:     inputUrl,
      title:         primary.title || null,
      artist:        primary.artistName || null,
      cover:         primary.thumbnailUrl || null,
      year:          null, // Odesli doesn't return release year; enriched separately
      tags:          [],
      addedAt:       new Date().toISOString(),
      links,
      firstTrackUri: null, // fetched lazily from Spotify (by add flow / sync.js) when a spotify link exists
    };
  } catch {
    return { _error: 'network' };
  }
}

// ── Resilient resolver (Odesli + MusicBrainz fallback) ───────────────────────

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
    firstTrackUri: null,
  };
}

/** Resolve a single URL via MusicBrainz. Returns album record or { _error }. */
export async function resolveAlbumMusicBrainz(sourceUrl, service) {
  try {
    const params = new URLSearchParams({ resource: sourceUrl, inc: 'release-rels+artist-credits', fmt: 'json' });
    const res = await fetch(`${MUSICBRAINZ_BASE}/url?${params}`);
    if (!res.ok) return { _error: res.status };
    const data = await res.json();
    const rec  = parseMbRelease(data, sourceUrl, service);
    return rec || { _error: 'not-found' };
  } catch {
    return { _error: 'network' };
  }
}

/**
 * Resolve via Odesli (throttled), falling back to MusicBrainz (throttled).
 * Skips Odesli entirely when its throttler is in cooldown.
 * Returns a resolved record or the last error (stub stays pending for next pass).
 */
export async function resolveAlbumResilient(sourceUrl, { service } = {}) {
  let lastOdesliErr;
  if (!throttles.odesli.coolingDown()) {
    lastOdesliErr = await throttles.odesli.run(() => resolveAlbum(sourceUrl));
    if (!lastOdesliErr._error) return lastOdesliErr;
  } else {
    lastOdesliErr = { _error: 429 }; // cooldown active = effectively rate-limited
  }
  // MusicBrainz fallback (throttled independently)
  const mbRec = await throttles.musicbrainz.run(() => resolveAlbumMusicBrainz(sourceUrl, service));
  if (!mbRec._error) return mbRec;
  return lastOdesliErr; // both failed — caller leaves stub pending
}

// ── Spotify ───────────────────────────────────────────────────────────────────

const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * One Spotify Web API call: sends the bearer token, refreshes it once on 401 and
 * retries, and normalises every failure to `{ _error }`.
 *
 * Returns `null` — not an `_error` object — when the token could not be
 * refreshed. Callers rely on that distinction: sync.js's handleErr() maps null
 * to "Auth failed" and disables further pushes.
 *
 * A body is only sent when one is given, so GET requests carry no
 * Content-Type header.
 */
async function _spotifyRequest(method, path, body) {
  const makeReq = () => fetch(SPOTIFY_API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + getToken(),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  let res = await makeReq();
  if (res.status === 401) {
    if (!await refreshAccessToken()) return null;
    res = await makeReq();
  }
  if (res.status === 429) return rateLimitError(res);
  if (!res.ok) return { _error: res.status };
  if (method === 'GET') return res.json();

  // Playlist mutations answer 200-with-empty-body and 204, which res.json()
  // rejects on — so those go through text() and treat empty as {}.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const spotifyRequest = (method, path, body) => throttles.spotify.run(() => _spotifyRequest(method, path, body));

export async function spotifyGet(path)        { return spotifyRequest('GET',  path); }
export async function spotifyPost(path, body) { return spotifyRequest('POST', path, body); }
export async function spotifyPut(path, body)  { return spotifyRequest('PUT',  path, body); }

export async function fetchAlbumFirstTrack(albumId) {
  const data = await spotifyGet('/albums/' + albumId + '/tracks?limit=1');
  return data?.items?.[0]?.uri || null;
}

// Fetch Last.fm tags in the background and update the saved album.
// onUpdate() is called after storage is written so the caller can re-render.
export async function enrichWithLastfm(albumId, artistName, albumTitle, onUpdate) {
  if (!artistName) return; // sparse Odesli entities can resolve with no artist
  const primaryArtist = artistName.split(',')[0].trim();

  // Fetch artist + album tags in parallel; artist tags take priority
  const [artistTags, albumData] = await Promise.all([
    fetchArtistTags(primaryArtist),
    fetchLastfmAlbum(primaryArtist, albumTitle),
  ]);

  // Merge: artist tags first, then album tags that aren't duplicates
  const seen = new Set(artistTags);
  const merged = [...artistTags];
  for (const t of albumData.tags) {
    if (!seen.has(t)) { merged.push(t); seen.add(t); }
  }

  // Fall back to similar artists if we still have nothing
  let tags = merged;
  if (!tags.length) {
    tags = await fetchTagsFromSimilarArtists(primaryArtist);
  }

  if (!tags.length) return;
  const albums = loadAlbums();
  const album = albums.find(x => x.id === albumId);
  if (album) { album.tags = tags.slice(0, 7); saveAlbums(albums); onUpdate?.(); }
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

async function _lfmGet(params) {
  const p = new URLSearchParams({ ...params, api_key: LASTFM_KEY, format: 'json' });
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(LASTFM + '?' + p, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { clearTimeout(timer); return null; }
}

function lfmGet(params) {
  return throttles.lastfm.run(() => _lfmGet(params));
}

export async function fetchLastfmAlbum(artist, album) {
  const data = await lfmGet({ method: 'album.getinfo', artist, album, autocorrect: '1' });
  const tags = cleanTags(asArray(data?.album?.tags?.tag).slice(0, 5));
  return { tags };
}

const BIO_MAX_CHARS = 900;

const YEAR_RE = /^\d{4}s?$/;
const JUNK_TAGS = new Set(['seen live', 'favorites', 'favourite', 'under 2000 listeners']);

function cleanTags(rawTags) {
  return rawTags
    .map(t => t.name.toLowerCase())
    .filter(t => t.length > 1 && t.length <= 25 && !YEAR_RE.test(t) && !JUNK_TAGS.has(t));
}

async function fetchArtistTags(artist) {
  const data = await lfmGet({ method: 'artist.gettoptags', artist, autocorrect: '1' });
  return cleanTags(asArray(data?.toptags?.tag).filter(t => t.count >= 5).slice(0, 5));
}

async function fetchTagsFromSimilarArtists(artist) {
  const simData = await lfmGet({ method: 'artist.getsimilar', artist, limit: '4', autocorrect: '1' });
  const simArtists = asArray(simData?.similarartists?.artist).slice(0, 4);
  const counts = {};
  const results = await Promise.all(
    simArtists.map(a => lfmGet({ method: 'artist.gettoptags', artist: a.name, autocorrect: '1' }))
  );
  for (const data of results) {
    const tags = cleanTags(asArray(data?.toptags?.tag).filter(t => t.count >= 15).slice(0, 5));
    for (const name of tags) counts[name] = (counts[name] || 0) + 1;
  }
  // Keep tags that appear in at least 2 similar artists
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

// ── Spotify album search (fills gaps from Odesli asymmetric matching) ─────────

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
 * Returns true when a Spotify search result item is a confident match for the
 * resolved artist + title.
 * @param {{ name: string, artists: Array<{name:string}> }} item  Spotify search result
 * @param {string} artist  Resolved artist name
 * @param {string} title   Resolved album title
 */
export function spotifyAlbumMatches(item, artist, title) {
  const normTitle = normalizeAlbumStr(title);
  const normItem  = normalizeAlbumStr(item.name);
  if (!normTitle || normTitle !== normItem) return false;

  const normArtist = normalizeAlbumStr(artist);
  return (item.artists || []).some(a => {
    const na = normalizeAlbumStr(a.name);
    return na === normArtist || na.includes(normArtist) || normArtist.includes(na);
  });
}

/**
 * Search Spotify for an album by artist + title and return a
 * `{ url, nativeUri }` entry (suitable for `links.spotify`) when a confident
 * match is found, or null otherwise.
 * Only callable when a Spotify token is valid (caller is responsible).
 */
export async function searchSpotifyAlbum(artist, title) {
  if (!artist || !title) return null;
  const q = `album:${title} artist:${artist}`;
  const data = await spotifyGet('/search?type=album&limit=5&q=' + encodeURIComponent(q));
  if (!data || data._error) return null;
  const items = data.albums?.items || [];
  const match = items.find(item => spotifyAlbumMatches(item, artist, title));
  if (!match) return null;
  return {
    url:       match.external_urls?.spotify || null,
    nativeUri: match.uri || null,
  };
}

export async function fetchAlbumTracks(albumId) {
  const data = await spotifyGet('/albums/' + albumId);
  if (!data?.tracks?.items) return [];
  return data.tracks.items.map(t => ({
    number:      t.track_number,
    name:        t.name,
    duration_ms: t.duration_ms,
  }));
}

export async function fetchSpotifyArtist(artistId) {
  const data = await spotifyGet('/artists/' + artistId);
  if (!data) return null;
  return {
    image:       data.images?.[0]?.url || null,
    genres:      (data.genres || []).slice(0, 5),
    spotifyUrl:  data.external_urls?.spotify || null,
  };
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
// Odesli carries no artist imagery either, only album thumbnails.
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
      const res = await fetch(`${AUDIODB_BASE}/search.php?s=${encodeURIComponent(artistName)}`);
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
 * Deezer artist image via our resolver. `albumId` (Deezer's own album id, which
 * Odesli hands us for free in links.deezer) makes the lookup exact; without it
 * the resolver falls back to a strict name match.
 */
export async function fetchDeezerArtistImage(artistName, albumId) {
  return throttles.deezer.run(async () => {
    try {
      const params = new URLSearchParams({ name: artistName });
      if (albumId) params.set('albumId', albumId);
      // Signed payload must match exactly what the resolver reconstructs.
      const signed = `artist:${artistName}|${albumId || ''}`;
      const res = await fetch(`${ODESLI_BASE}/v1/artist?${params}`, {
        headers: { 'x-gp-token': await signRequestToken(signed) },
      });
      if (!res.ok) return res.status === 429 ? rateLimitError(res) : null;
      const data = await res.json();
      return isBlankImage(data?.image) ? null : data.image;
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

  const fromDeezer = await fetchDeezerArtistImage(artist, deezerAlbumId(album));
  return typeof fromDeezer === 'string' ? fromDeezer : null;
}
