/**
 * Cross-linking an extracted album to the other services (Deezer, Apple,
 * Spotify) by exact normalised artist + title match, plus the name folding
 * that match uses and the Spotify app-only token it needs.
 */

import { DEEZER_BASE, ITUNES_BASE, SPOTIFY_ACCOUNTS_BASE, SPOTIFY_API_BASE, UpstreamFetchError, fetchUpstream } from './upstream.mjs';

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

// ── Cross-service link discovery ────────────────────────────────────────────
// Given the {artist, title} just extracted from the pasted page, look up the
// exact album on the two services with a free keyless search API. Best-effort:
// any failure here just means one fewer link on the record, never a failed add.

// Deezer's query syntax uses double quotes as field delimiters; a literal "
// inside the artist/title would prematurely close the field, corrupting the
// query for every field after it.
const stripQuotes = s => s.replace(/"/g, '');

export async function crossLinkDeezer(artist, title, fetchImpl) {
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

export async function crossLinkApple(artist, title, fetchImpl) {
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
      // Thrown, not cached: an undefined token would read as "not configured"
      // in crossLinkSpotify and silently stop Spotify links for an hour. A
      // throw surfaces as a logged 'cross-link failed' and retries next request.
      if (!data?.access_token) throw new Error('Spotify token response had no access_token');
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

export async function crossLinkSpotify(artist, title, fetchImpl) {
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
