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
