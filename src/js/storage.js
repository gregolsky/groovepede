import { STORAGE_KEY, DONE_KEY, PREF_SERVICE_KEY } from './config.js';
import { findServiceByHost } from './services.js';

export function upgradeAlbumRecord(rec) {
  if (rec.links) return rec; // already migrated
  const spotifyId = rec.id;
  const spotifyUrl = rec.url || null;
  const links = {};
  if (spotifyUrl) {
    links.spotify = {
      url: spotifyUrl,
      nativeUri: `spotify:album:${spotifyId}`,
    };
  }
  return { ...rec, sourceUrl: spotifyUrl || rec.sourceUrl || null, legacyId: spotifyId, links };
}

export function loadAlbums()  { try { return (JSON.parse(localStorage.getItem(STORAGE_KEY)) || []).map(upgradeAlbumRecord); } catch { return []; } }
export function saveAlbums(a) { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
export function loadDone()    { return parseInt(localStorage.getItem(DONE_KEY) || '0'); }
export function saveDone(n)   { localStorage.setItem(DONE_KEY, String(n)); }

export function extractAlbumId(url) {
  // Full URL: open.spotify.com/album/<id>
  const urlMatch = url.match(/spotify\.com\/album\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // Spotify URI: spotify:album:<id>
  const uriMatch = url.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];
  // Bare album ID (22-char base62)
  if (/^[a-zA-Z0-9]{22}$/.test(url)) return url;
  return null;
}

// Bare Spotify album ID for Web API calls. album.id is now an Odesli
// entityUniqueId (e.g. "SPOTIFY_ALBUM::<id>"), so it can't be passed to
// /v1/albums/<id> directly — derive it from the resolved Spotify link.
export function spotifyAlbumId(album) {
  const url = album?.links?.spotify?.url;
  return url ? extractAlbumId(url) : null;
}

export function serializeBackup(albums, done) {
  // Only persist user-owned data; all external metadata is pulled fresh on import.
  const lean = albums.map(a => ({ sourceUrl: a.sourceUrl, service: a.service, addedAt: a.addedAt }));
  return JSON.stringify({ version: 3, exportedAt: new Date().toISOString(), albums: lean, done });
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || ![1, 2, 3].includes(data.version) || !Array.isArray(data.albums) || typeof data.done !== 'number') {
    throw new Error('Invalid backup format');
  }
  // Rebuild every album as a pending stub; external metadata (title, cover, links, tags)
  // is NOT restored — it will be re-fetched fresh by resolvePending() after import.
  const stubs = data.albums.map(album => {
    let sourceUrl, service;
    if (data.version <= 2) {
      const upgraded = upgradeAlbumRecord(album);
      sourceUrl = upgraded.sourceUrl;
      service = upgraded.service || parseMusicLink(sourceUrl || '').service;
    } else {
      sourceUrl = album.sourceUrl;
      service = album.service || parseMusicLink(sourceUrl || '').service;
    }
    if (!sourceUrl) return null;
    const stub = makePendingRecord(sourceUrl, service || 'spotify');
    stub.addedAt = album.addedAt || stub.addedAt;
    return stub;
  }).filter(Boolean);
  return { albums: stubs, done: data.done };
}

export function getPreferredService() {
  return localStorage.getItem(PREF_SERVICE_KEY) || 'spotify';
}
/** True when the user has explicitly chosen a preferred service (not just the default). */
export function hasExplicitPreferredService() {
  return !!localStorage.getItem(PREF_SERVICE_KEY);
}
export function setPreferredService(s) {
  localStorage.setItem(PREF_SERVICE_KEY, s);
}

export function parseMusicLink(raw) {
  const s = (raw || '').trim();
  if (!s) return { error: null };

  // Spotify URI: spotify:album:<id>
  const spotifyUri = s.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (spotifyUri) return { url: `https://open.spotify.com/album/${spotifyUri[1]}`, service: 'spotify' };

  // Spotify non-album URIs
  if (/^spotify:artist:/.test(s))              return { error: "That's an artist link — paste an album link instead" };
  if (/^spotify:track:/.test(s))               return { error: "That's a track link — paste the album link instead" };
  if (/^spotify:playlist:/.test(s))            return { error: "That's a playlist — paste an album link instead" };
  if (/^spotify:(show|episode|user):/.test(s)) return { error: "Paste a Spotify album link or URI" };
  if (/^spotify:/.test(s))                     return { error: "Couldn't find an album in that Spotify link" };

  // Bare 22-char Spotify album ID
  if (/^[a-zA-Z0-9]{22}$/.test(s)) return { url: `https://open.spotify.com/album/${s}`, service: 'spotify' };

  if (!/^https?:\/\//.test(s))
    return { error: 'Paste an album link from a supported music service' };

  let host;
  try { host = new URL(s).hostname.replace(/^www\./, ''); }
  catch { return { error: 'Paste an album link from a supported music service' }; }

  // Blocked sources (not in the service registry)
  if (host.includes('bandcamp.com'))
    return { error: "Bandcamp isn't supported yet — paste a link from Spotify, Apple Music, YouTube, Tidal, or Deezer" };
  if (host.includes('discogs.com'))
    return { error: "Discogs isn't supported yet — paste a link from Spotify, Apple Music, YouTube, Tidal, or Deezer" };
  if (host === 'youtu.be')
    return { error: "That's a track — paste a YouTube playlist link for an album" };

  // Registry lookup — covers all supported services
  const svc = findServiceByHost(host);
  if (svc) {
    if (svc.albumMatch(s)) return { url: s, service: svc.slug };
    return { error: svc.nonAlbumError(s) || 'Paste an album link from a supported service (Spotify, Apple Music, YouTube, Tidal, or Deezer)' };
  }

  return { error: 'Paste an album link from a supported service (Spotify, Apple Music, YouTube, Tidal, or Deezer)' };
}

export function makePendingRecord(url, service) {
  return {
    id:        'pending:' + url,
    sourceUrl: url,
    service,
    title:     null,
    artist:    null,
    cover:     null,
    year:      null,
    tags:      [],
    addedAt:   new Date().toISOString(),
    links:     {},
    _pending:  true,
  };
}

export function isRetryableResolveError(err) {
  if (err === 'network') return true;
  if (err === 429) return true;
  if (typeof err === 'number' && err >= 500) return true;
  return false;
}
