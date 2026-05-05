import { STORAGE_KEY, DONE_KEY } from './config.js';

export function loadAlbums()  { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
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
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), albums, done });
}

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.albums) || typeof data.done !== 'number') {
    throw new Error('Invalid backup format');
  }
  return { albums: data.albums, done: data.done };
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
