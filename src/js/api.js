import { LASTFM_KEY, ODESLI_BASE, ODESLI_API_KEY, MUSICBRAINZ_BASE, COVERART_BASE, THROTTLE } from './config.js';
import { getToken, refreshAccessToken } from './auth.js';
import { loadAlbums, saveAlbums, extractAlbumId } from './storage.js';
import { ODESLI_KEY_MAP } from './services.js';
import { createThrottle } from './throttle.js';

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';

// ── Per-service throttlers ────────────────────────────────────────────────────
// One throttler per rate-limited endpoint — owns global pacing + 429 cooldown.
// Raw API functions are "just calls"; throttling is applied at the choke points
// below so all call sites automatically respect rate limits.

const is429        = r => r?._error === 429;
const retryAfterMs = r => r?._retryAfter != null ? r._retryAfter * 1000 : null;

function makeThrottles() {
  return {
    odesli:      createThrottle({ ...THROTTLE.odesli,      isRateLimited: is429, retryAfterOf: retryAfterMs }),
    musicbrainz: createThrottle({ ...THROTTLE.musicbrainz, isRateLimited: is429, retryAfterOf: retryAfterMs }),
    lastfm:      createThrottle({ ...THROTTLE.lastfm }),  // rarely rate-limits; pace only
    spotify:     createThrottle({ ...THROTTLE.spotify,    isRateLimited: is429, retryAfterOf: retryAfterMs }),
  };
}

let throttles = makeThrottles();

/** Override throttles (tests only) — inject no-op / fake-clock instances. */
export function _setThrottles(t) { throttles = { ...throttles, ...t }; }

// ── Odesli (universal resolver) ───────────────────────────────────────────────

export async function resolveAlbum(inputUrl) {
  try {
    const params = new URLSearchParams({ url: inputUrl, userCountry: 'US' });
    if (ODESLI_API_KEY) params.set('key', ODESLI_API_KEY);
    const res = await fetch(`${ODESLI_BASE}/links?${params}`);
    if (!res.ok) {
      if (res.status === 429) {
        const raw = res.headers?.get?.('retry-after');
        const retryAfter = raw ? (parseInt(raw, 10) || null) : null;
        return { _error: 429, ...(retryAfter != null && { _retryAfter: retryAfter }) };
      }
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

async function _spotifyGet(path) {
  const res = await fetch('https://api.spotify.com/v1' + path,
    { headers: { Authorization: 'Bearer ' + getToken() } });
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return null;
    const retry = await fetch('https://api.spotify.com/v1' + path,
      { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!retry.ok) return { _error: retry.status };
    return retry.json();
  }
  if (res.status === 429) {
    const raw = res.headers?.get?.('retry-after');
    const retryAfter = raw ? (parseInt(raw, 10) || null) : null;
    return { _error: 429, ...(retryAfter != null && { _retryAfter: retryAfter }) };
  }
  if (!res.ok) return { _error: res.status };
  return res.json();
}

export async function spotifyGet(path) {
  return throttles.spotify.run(() => _spotifyGet(path));
}

async function _spotifyMutate(method, path, body) {
  const makeReq = () => fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { Authorization: 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let res = await makeReq();
  if (res.status === 401) {
    if (!await refreshAccessToken()) return null;
    res = await makeReq();
  }
  if (res.status === 429) {
    const raw = res.headers?.get?.('retry-after');
    const retryAfter = raw ? (parseInt(raw, 10) || null) : null;
    return { _error: 429, ...(retryAfter != null && { _retryAfter: retryAfter }) };
  }
  if (!res.ok) return { _error: res.status };
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function spotifyMutate(method, path, body) {
  return throttles.spotify.run(() => _spotifyMutate(method, path, body));
}

export async function spotifyPost(path, body) { return spotifyMutate('POST', path, body); }
export async function spotifyPut(path, body)  { return spotifyMutate('PUT',  path, body); }

export async function fetchAlbumFirstTrack(albumId) {
  const data = await spotifyGet('/albums/' + albumId + '/tracks?limit=1');
  return data?.items?.[0]?.uri || null;
}

export async function fetchAlbumMeta(id) {
  const data = await spotifyGet('/albums/' + id);
  if (!data || data._error) return data ?? null;
  const artists = data.artists || [];
  return {
    id,
    url:           data.external_urls.spotify,
    title:         data.name,
    artist:        artists.map(a => a.name).join(', '),
    artistId:      artists[0]?.id || null,
    cover:         data.images?.[0]?.url || null,
    year:          (data.release_date || '').slice(0, 4) || null,
    tags:          [],
    addedAt:       new Date().toISOString(),
    firstTrackUri: data.tracks?.items?.[0]?.uri || null,
  };
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
  const tags = cleanTags((data?.album?.tags?.tag || []).slice(0, 5));
  return { tags };
}

const YEAR_RE = /^\d{4}s?$/;
const JUNK_TAGS = new Set(['seen live', 'favorites', 'favourite', 'under 2000 listeners']);

function cleanTags(rawTags) {
  return rawTags
    .map(t => t.name.toLowerCase())
    .filter(t => t.length > 1 && t.length <= 25 && !YEAR_RE.test(t) && !JUNK_TAGS.has(t));
}

async function fetchArtistTags(artist) {
  const data = await lfmGet({ method: 'artist.gettoptags', artist, autocorrect: '1' });
  return cleanTags((data?.toptags?.tag || []).filter(t => t.count >= 5).slice(0, 5));
}

async function fetchTagsFromSimilarArtists(artist) {
  const simData = await lfmGet({ method: 'artist.getsimilar', artist, limit: '4', autocorrect: '1' });
  const simArtists = (simData?.similarartists?.artist || []).slice(0, 4);
  const counts = {};
  const results = await Promise.all(
    simArtists.map(a => lfmGet({ method: 'artist.gettoptags', artist: a.name, autocorrect: '1' }))
  );
  for (const data of results) {
    const tags = (data?.toptags?.tag || []).filter(t => t.count >= 15).slice(0, 5);
    for (const t of tags) {
      const name = t.name.toLowerCase();
      if (name.length > 1 && name.length <= 25 && !YEAR_RE.test(name) && !JUNK_TAGS.has(name)) {
        counts[name] = (counts[name] || 0) + 1;
      }
    }
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

  // Strip Last.fm "Read more" link
  let fullBio = infoData?.artist?.bio?.content || infoData?.artist?.bio?.summary || '';
  fullBio = fullBio.replace(/<a href="https:\/\/www\.last\.fm[^"]*"[^>]*>.*?<\/a>/gi, '').trim();
  fullBio = fullBio.replace(/<[^>]+>/g, '').trim();

  // Short version for the card panel
  let bio = fullBio;
  if (bio.length > 420) bio = bio.slice(0, 420).replace(/\s+\S*$/, '') + '…';

  const similar = (similarData?.similarartists?.artist || [])
    .slice(0, 6)
    .map(a => ({ name: a.name, url: a.url }));

  const lastfmUrl = infoData?.artist?.url || null;

  return { bio, fullBio, similar, tags, lastfmUrl };
}
