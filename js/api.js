import { LASTFM_KEY } from './config.js';
import { getToken, refreshAccessToken } from './auth.js';
import { loadAlbums, saveAlbums } from './storage.js';

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';

// ── Spotify ───────────────────────────────────────────────────────────────────

export async function spotifyGet(path) {
  const res = await fetch('https://api.spotify.com/v1' + path,
    { headers: { Authorization: 'Bearer ' + getToken() } });
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) return null;
    const retry = await fetch('https://api.spotify.com/v1' + path,
      { headers: { Authorization: 'Bearer ' + getToken() } });
    if (!retry.ok) return null;
    return retry.json();
  }
  if (!res.ok) return null;
  return res.json();
}

export async function fetchAlbumMeta(id) {
  const data = await spotifyGet('/albums/' + id);
  if (!data) return null;
  const artists = data.artists || [];
  return {
    id,
    url:      data.external_urls.spotify,
    title:    data.name,
    artist:   artists.map(a => a.name).join(', '),
    artistId: artists[0]?.id || null,
    cover:    data.images?.[0]?.url || null,
    year:     (data.release_date || '').slice(0, 4) || null,
    tags:     [],
    addedAt:  new Date().toISOString(),
  };
}

// Fetch Last.fm tags in the background and update the saved album.
// onUpdate() is called after storage is written so the caller can re-render.
export async function enrichWithLastfm(albumId, artistName, albumTitle, onUpdate) {
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

async function lfmGet(params) {
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

export async function fetchLastfmArtist(artistName) {
  const [infoData, similarData] = await Promise.all([
    lfmGet({ method: 'artist.getinfo',   artist: artistName, autocorrect: '1' }),
    lfmGet({ method: 'artist.getsimilar', artist: artistName, limit: '6', autocorrect: '1' }),
  ]);

  // Strip Last.fm "Read more" link, trim to ~420 chars
  let bio = infoData?.artist?.bio?.summary || '';
  bio = bio.replace(/<a href="https:\/\/www\.last\.fm[^"]*"[^>]*>.*?<\/a>/gi, '').trim();
  bio = bio.replace(/<[^>]+>/g, '').trim();
  if (bio.length > 420) bio = bio.slice(0, 420).replace(/\s+\S*$/, '') + '…';

  const similar = (similarData?.similarartists?.artist || [])
    .slice(0, 6)
    .map(a => ({ name: a.name, url: a.url }));

  return { bio, similar };
}
