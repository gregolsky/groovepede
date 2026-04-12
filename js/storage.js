import { STORAGE_KEY, DONE_KEY } from './config.js';

export function loadAlbums()  { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; } }
export function saveAlbums(a) { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); }
export function loadDone()    { return parseInt(localStorage.getItem(DONE_KEY) || '0'); }
export function saveDone(n)   { localStorage.setItem(DONE_KEY, String(n)); }

export function extractAlbumId(url) {
  const m = url.match(/spotify\.com\/album\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}
