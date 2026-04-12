import { LASTFM_KEY } from './config.js';
import { getToken } from './auth.js';
import { loadAlbums, saveAlbums } from './storage.js';

const LASTFM = 'https://ws.audioscrobbler.com/2.0/';

// ── Spotify ───────────────────────────────────────────────────────────────────

export async function spotifyGet(path) {
  const res = await fetch('https://api.spotify.com/v1' + path,
    { headers: { Authorization: 'Bearer ' + getToken() } });
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
  const lfmData = await fetchLastfmAlbum(primaryArtist, albumTitle);
  if (!lfmData.tags.length) return;
  const albums = loadAlbums();
  const album = albums.find(x => x.id === albumId);
  if (album) { album.tags = lfmData.tags; saveAlbums(albums); onUpdate?.(); }
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
  const tags = (data?.album?.tags?.tag || [])
    .slice(0, 5)
    .map(t => t.name.toLowerCase())
    .filter(t => t.length > 1);
  return { tags };
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
