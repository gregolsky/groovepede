import { STORAGE_KEY, DONE_KEY, PREF_SERVICE_KEY } from './config.js';

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
export function setPreferredService(s) {
  localStorage.setItem(PREF_SERVICE_KEY, s);
}

const SUPPORTED_SERVICES = new Set(['spotify', 'apple', 'youtube', 'deezer', 'tidal', 'amazon', 'pandora', 'soundcloud']);

export function parseMusicLink(raw) {
  const s = (raw || '').trim();
  if (!s) return { error: null };

  // Spotify URI: spotify:album:<id>
  const spotifyUri = s.match(/^spotify:album:([a-zA-Z0-9]+)$/);
  if (spotifyUri) return { url: `https://open.spotify.com/album/${spotifyUri[1]}`, service: 'spotify' };

  // Spotify non-album URIs
  if (/^spotify:artist:/.test(s)) return { error: "That’s an artist link — paste an album link instead" };
  if (/^spotify:track:/.test(s))  return { error: "That’s a track link — paste the album link instead" };
  if (/^spotify:playlist:/.test(s)) return { error: "That’s a playlist — paste an album link instead" };
  if (/^spotify:(show|episode|user):/.test(s)) return { error: "Paste a Spotify album link or URI" };
  if (/^spotify:/.test(s)) return { error: "Couldn’t find an album in that Spotify link" };

  // Bare 22-char Spotify album ID
  if (/^[a-zA-Z0-9]{22}$/.test(s)) return { url: `https://open.spotify.com/album/${s}`, service: 'spotify' };

  if (!/^https?:\/\//.test(s))
    return { error: 'Paste an album link from a supported music service' };

  let host;
  try { host = new URL(s).hostname.replace(/^www\./, ''); }
  catch { return { error: 'Paste an album link from a supported music service' }; }

  // Blocked sources
  if (host.includes('bandcamp.com'))
    return { error: "Bandcamp isn’t supported yet — paste a link from Spotify, Apple Music, YouTube, Tidal, or Deezer" };
  if (host.includes('discogs.com'))
    return { error: "Discogs isn’t supported yet — paste a link from Spotify, Apple Music, YouTube, Tidal, or Deezer" };

  // Spotify
  if (host === 'open.spotify.com') {
    if (/\/album\//.test(s))   return { url: s, service: 'spotify' };
    if (/\/artist\//.test(s))  return { error: "That’s an artist link — paste an album link instead" };
    if (/\/track\//.test(s))   return { error: "That’s a track link — paste the album link instead" };
    if (/\/playlist\//.test(s)) return { error: "That’s a playlist — paste an album link instead" };
    if (/\/(show|episode)\//.test(s)) return { error: "That’s a podcast — paste an album link instead" };
    return { error: "Couldn’t find an album in that Spotify link" };
  }

  // Apple Music
  if (host === 'music.apple.com') return { url: s, service: 'apple' };

  // YouTube / YouTube Music
  if (host === 'music.youtube.com' || host === 'youtube.com') {
    if (/[?&]list=/.test(s)) return { url: s, service: 'youtube' };
    if (/\/watch/.test(s))   return { error: "That’s a track — paste a YouTube playlist link for an album" };
    return { url: s, service: 'youtube' };
  }
  if (host === 'youtu.be')
    return { error: "That’s a track — paste a YouTube playlist link for an album" };

  // Deezer
  if (host === 'deezer.com' && /\/album\//.test(s)) return { url: s, service: 'deezer' };

  // Tidal
  if ((host === 'tidal.com' || host === 'listen.tidal.com') && /\/album\//.test(s))
    return { url: s, service: 'tidal' };

  // Amazon Music
  if (host === 'music.amazon.com' && /\/albums\//.test(s)) return { url: s, service: 'amazon' };

  // Pandora
  if (host === 'pandora.com' && /\/album\//.test(s)) return { url: s, service: 'pandora' };

  // SoundCloud sets (albums)
  if (host === 'soundcloud.com' && /\/sets\//.test(s)) return { url: s, service: 'soundcloud' };

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

export function validateAlbumInput(raw) {
  const s = (raw || '').trim();
  if (!s) return { id: null, error: null };

  const id = extractAlbumId(s);
  if (id) return { id, error: null };

  if (/spotify\.com\/artist\/|^spotify:artist:/.test(s))
    return { id: null, error: "That\u2019s an artist link \u2014 paste an album link instead" };
  if (/spotify\.com\/track\/|^spotify:track:/.test(s))
    return { id: null, error: "That\u2019s a track link \u2014 paste the album link instead" };
  if (/spotify\.com\/playlist\/|^spotify:playlist:/.test(s))
    return { id: null, error: "That\u2019s a playlist \u2014 paste an album link instead" };
  if (/spotify\.com\/(show|episode)\/|^spotify:(show|episode):/.test(s))
    return { id: null, error: "That\u2019s a podcast \u2014 paste an album link instead" };
  if (/spotify\.com\//.test(s))
    return { id: null, error: "Couldn\u2019t find an album in that Spotify link" };
  if (/^https?:\/\//.test(s))
    return { id: null, error: "That doesn\u2019t look like a Spotify link" };

  return { id: null, error: "Paste a Spotify album link or URI" };
}
