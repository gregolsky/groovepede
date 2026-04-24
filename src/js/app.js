import '../css/style.css';
import { login, clearToken, tokenValid, exchangeCode, refreshAccessToken } from './auth.js';
import { spotifyGet, fetchAlbumMeta, enrichWithLastfm, fetchLastfmArtist, fetchSpotifyArtist } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, extractAlbumId } from './storage.js';
import { renderAuthArea, renderApp } from './render.js';

// ── State ─────────────────────────────────────────────────────────────────────
let userProfile      = null;
let activeFilter     = 'all';
let loadingAdd       = false;
let expandedCards    = new Set();
let artistCache      = {};
let artistDetailView = null; // { artistName, albumId, artistId } when open

const appEl  = document.getElementById('app');
const authEl = document.getElementById('auth-area');

function getState() {
  return { activeFilter, loadingAdd, expandedCards, artistCache, artistDetailView };
}

function rerender() {
  renderAuthArea(authEl, userProfile);
  renderApp(appEl, getState());
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function setFilter(tag) {
  activeFilter = tag;
  rerender();
}

async function handleAdd() {
  const input = appEl.querySelector('#url-input');
  if (!input) return;
  const id = extractAlbumId(input.value.trim());
  if (!id) {
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 1200);
    return;
  }
  const albums = loadAlbums();
  if (albums.find(a => a.id === id)) { input.value = ''; return; }

  loadingAdd = true;
  rerender();

  const meta = await fetchAlbumMeta(id);
  if (meta) { albums.push(meta); saveAlbums(albums); }

  loadingAdd = false;
  rerender();

  const inp = appEl.querySelector('#url-input');
  if (inp) inp.value = '';
  if (meta) enrichWithLastfm(meta.id, meta.artist, meta.title, rerender); // fire-and-forget
}

function markDone(index) {
  const albums = loadAlbums();
  const album  = albums[index];
  if (album) expandedCards.delete(album.id);
  albums.splice(index, 1);
  saveAlbums(albums);
  saveDone(loadDone() + 1);
  rerender();
}

async function toggleArtist(albumId, artistName) {
  if (expandedCards.has(albumId)) {
    expandedCards.delete(albumId);
    rerender();
    return;
  }
  expandedCards.add(albumId);
  rerender();

  if (!artistCache[artistName]) {
    const data = await fetchLastfmArtist(artistName);
    artistCache[artistName] = data;
    if (expandedCards.has(albumId)) rerender();
  }
}

async function openArtistDetail(albumId, artistName, artistId) {
  artistDetailView = { albumId, artistName, artistId };
  window.history.pushState({ artistDetail: true }, '');
  rerender();

  const needsLastfm  = !artistCache[artistName];
  const needsSpotify = artistId && artistCache[artistName]?.image === undefined;

  const fetches = [];
  if (needsLastfm)  fetches.push(fetchLastfmArtist(artistName).then(d => { artistCache[artistName] = { ...artistCache[artistName], ...d }; }));
  if (needsSpotify) fetches.push(fetchSpotifyArtist(artistId).then(d => { if (d) artistCache[artistName] = { ...artistCache[artistName], ...d }; }));

  if (fetches.length) {
    await Promise.all(fetches);
    if (artistDetailView?.artistName === artistName) rerender();
  }
}

function closeArtistDetail() {
  artistDetailView = null;
  rerender();
}

function logout() {
  clearToken();
  userProfile = null;
  rerender();
}

// ── Event delegation ──────────────────────────────────────────────────────────
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, tag, albumId, artist, url, index } = el.dataset;

  const { artistId } = el.dataset;
  switch (action) {
    case 'login':         login();                                              break;
    case 'logout':        logout();                                             break;
    case 'filter':        setFilter(tag);                                       break;
    case 'add':           handleAdd();                                          break;
    case 'listen':        window.open(url, '_blank');                           break;
    case 'expand':        toggleArtist(albumId, artist);                       break;
    case 'done':          markDone(parseInt(index, 10));                       break;
    case 'artist-detail': openArtistDetail(albumId, artist, artistId);        break;
    case 'close-detail':  closeArtistDetail();                                 break;
  }
});

// Enter key in the add input (listener survives re-renders since it's on the container)
appEl.addEventListener('keydown', e => {
  if (e.target.id === 'url-input' && e.key === 'Enter') handleAdd();
});

// Browser back button closes artist detail view
window.addEventListener('popstate', () => {
  if (artistDetailView) {
    artistDetailView = null;
    rerender();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const shared = params.get('text') || params.get('url');

  if (code) {
    window.history.replaceState({}, document.title, window.location.pathname);
    await exchangeCode(code);
  }

  // Silently refresh expired token if we have a refresh token
  if (!tokenValid()) {
    await refreshAccessToken();
  }

  rerender();

  if (!tokenValid()) return;

  userProfile = await spotifyGet('/me');
  renderAuthArea(authEl, userProfile);

  if (shared) {
    const id = extractAlbumId(shared);
    if (id) {
      const albums = loadAlbums();
      if (!albums.find(a => a.id === id)) {
        const meta = await fetchAlbumMeta(id);
        if (meta) {
          albums.push(meta);
          saveAlbums(albums);
          enrichWithLastfm(meta.id, meta.artist, meta.title, rerender); // fire-and-forget
        }
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
    }
  }

  // Enrich any albums missing meaningful Last.fm tags
  const albums = loadAlbums();
  const yearOnly = /^\d{4}s?$/;
  for (const album of albums) {
    const hasMeaningfulTags = (album.tags || []).some(t => !yearOnly.test(t));
    if (!hasMeaningfulTags && album.artist && album.title) {
      enrichWithLastfm(album.id, album.artist, album.title, rerender);
    }
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

boot();
