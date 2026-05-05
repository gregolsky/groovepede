import { SYNC_ENABLED_KEY, SYNC_PLAYLIST_KEY, SYNC_LAST_KEY, SYNC_PENDING_KEY } from './config.js';
import { loadAlbums, saveAlbums } from './storage.js';
import { spotifyGet, spotifyPost, spotifyPut, fetchAlbumFirstTrack, enrichWithLastfm } from './api.js';
import { login } from './auth.js';

// ── Internal state ─────────────────────────────────────────────────────────────

let _status      = 'idle';
let _lastError   = null;
let _lastSyncedAt = null;
let _pushTimer   = null;
let _onChange    = null;

export function setStatusListener(cb) { _onChange = cb; }

function notify(s, err = null) {
  _status    = s;
  _lastError = err;
  if (s === 'idle' && !err) {
    _lastSyncedAt = Date.now();
    localStorage.setItem(SYNC_LAST_KEY, String(_lastSyncedAt));
  }
  _onChange?.();
}

// ── Public read ───────────────────────────────────────────────────────────────

export function isSyncEnabled()    { return localStorage.getItem(SYNC_ENABLED_KEY) === '1'; }
export function getPlaylistId()    { return localStorage.getItem(SYNC_PLAYLIST_KEY) || null; }
export function hasPendingEnable() { return localStorage.getItem(SYNC_PENDING_KEY) === '1'; }
export function getSyncStatus()  {
  const stored = parseInt(localStorage.getItem(SYNC_LAST_KEY) || '0') || null;
  return { status: _status, lastSyncedAt: _lastSyncedAt ?? stored, lastError: _lastError };
}

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

export function albumsToTrackUris(albums) {
  return albums.filter(a => a.firstTrackUri).map(a => a.firstTrackUri);
}

export function playlistTracksToAlbums(items) {
  const seen = new Set();
  const out  = [];
  for (const item of items) {
    const t = item.track;
    if (!t?.album) continue;
    const al = t.album;
    if (seen.has(al.id)) continue;
    seen.add(al.id);
    const artists = al.artists || [];
    out.push({
      id:            al.id,
      url:           al.external_urls?.spotify || '',
      title:         al.name || '',
      artist:        artists.map(a => a.name).join(', '),
      artistId:      artists[0]?.id || null,
      cover:         al.images?.[0]?.url || null,
      year:          (al.release_date || '').slice(0, 4) || null,
      tags:          [],
      addedAt:       new Date().toISOString(),
      firstTrackUri: t.uri || null,
    });
  }
  return out;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Enable / disable ──────────────────────────────────────────────────────────

export async function enableSync(userProfile) {
  let playlistId = getPlaylistId();

  if (!playlistId) {
    notify('syncing');
    const userId = userProfile?.id;
    if (!userId) { notify('error', 'Not logged in'); return; }

    const playlist = await spotifyPost('/users/' + userId + '/playlists', {
      name: 'Groovepede Queue', public: false,
      description: 'Your Groovepede album listening queue.',
    });

    if (!playlist) { notify('error', 'Auth failed'); return; }
    if (playlist._error === 403) {
      localStorage.setItem(SYNC_PENDING_KEY, '1');
      login();
      return;
    }
    if (playlist._error) { notify('error', 'Could not create playlist (Spotify error ' + playlist._error + ')'); return; }

    playlistId = playlist.id;
    localStorage.setItem(SYNC_PLAYLIST_KEY, playlistId);
  }

  localStorage.setItem(SYNC_ENABLED_KEY, '1');
  notify('idle');
  await pushNow();
}

export function disableSync() {
  localStorage.removeItem(SYNC_ENABLED_KEY);
  clearTimeout(_pushTimer);
  _status = 'idle';
  _onChange?.();
}

export async function finishEnableAfterAuth(userProfile) {
  localStorage.removeItem(SYNC_PENDING_KEY);
  await enableSync(userProfile);
}

// ── Push ──────────────────────────────────────────────────────────────────────

export function schedulePush() {
  if (!isSyncEnabled()) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushNow, 2000);
}

export async function pushNow() {
  if (!isSyncEnabled()) return;
  const playlistId = getPlaylistId();
  if (!playlistId) return;

  notify('syncing');

  // Lazy backfill firstTrackUri for pre-sync albums
  const albums = loadAlbums();
  let changed = false;
  for (const album of albums) {
    if (!album.firstTrackUri) {
      const uri = await fetchAlbumFirstTrack(album.id);
      if (uri) { album.firstTrackUri = uri; changed = true; }
    }
  }
  if (changed) saveAlbums(albums);

  const uris    = albumsToTrackUris(albums);
  const chunks  = chunk(uris, 100);
  const payload = chunks[0] ?? [];

  // First PUT replaces the whole playlist; subsequent POSTs append chunks 2…n
  const first = await spotifyPut('/playlists/' + playlistId + '/tracks', { uris: payload });
  if (handleErr(first)) return;

  for (let i = 1; i < chunks.length; i++) {
    const res = await spotifyPost('/playlists/' + playlistId + '/tracks', { uris: chunks[i] });
    if (handleErr(res)) return;
  }

  notify('idle');
}

function handleErr(res, msg = 'Sync failed') {
  if (!res)                { notify('error', 'Auth failed'); return true; }
  if (res._error === 404)  {
    localStorage.removeItem(SYNC_PLAYLIST_KEY);
    localStorage.removeItem(SYNC_ENABLED_KEY);
    notify('error', 'Playlist deleted on Spotify — re-enable sync to recreate');
    return true;
  }
  if (res._error)          { notify('error', msg + ' (' + res._error + ')'); return true; }
  return false;
}

// ── Pull / Restore ────────────────────────────────────────────────────────────

export async function pullNow(rerenderFn) {
  const playlistId = getPlaylistId();
  if (!playlistId) return;

  notify('syncing');

  // Paginate through all playlist tracks
  const items = [];
  let next = '/playlists/' + playlistId +
    '/tracks?limit=100&fields=next,items(track(uri,album(id,name,release_date,external_urls,images,artists)))';
  while (next) {
    const path = next.startsWith('http') ? next.replace('https://api.spotify.com/v1', '') : next;
    const page = await spotifyGet(path);
    if (!page) { notify('error', 'Failed to fetch playlist'); return; }
    items.push(...(page.items || []));
    next = page.next || null;
  }

  const fromPlaylist = playlistTracksToAlbums(items);
  const local        = loadAlbums();

  if (local.length > 0) {
    const ok = confirm(`Replace your ${local.length} album${local.length !== 1 ? 's' : ''} with ${fromPlaylist.length} from your Spotify playlist?`);
    if (!ok) { notify('idle'); return; }
  }

  // Preserve local metadata for albums already in the queue
  const localMap = Object.fromEntries(local.map(a => [a.id, a]));
  const merged   = fromPlaylist.map(a => localMap[a.id]
    ? { ...localMap[a.id], firstTrackUri: a.firstTrackUri }
    : a
  );

  saveAlbums(merged);
  notify('idle');
  rerenderFn();

  for (const album of merged) {
    if (!(album.tags || []).length && album.artist && album.title) {
      enrichWithLastfm(album.id, album.artist, album.title, rerenderFn);
    }
  }
}
