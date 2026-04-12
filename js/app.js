import { login, clearToken, tokenValid, exchangeCode } from './auth.js';
import { spotifyGet, fetchAlbumMeta, enrichWithLastfm, fetchLastfmArtist } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, extractAlbumId } from './storage.js';
import { renderAuthArea, renderApp } from './render.js';

// ── State ─────────────────────────────────────────────────────────────────────
let userProfile   = null;
let activeFilter  = 'all';
let loadingAdd    = false;
let expandedCards = new Set();
let artistCache   = {};

const appEl  = document.getElementById('app');
const authEl = document.getElementById('auth-area');

function getState() {
  return { activeFilter, loadingAdd, expandedCards, artistCache };
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

  switch (action) {
    case 'login':  login();                               break;
    case 'logout': logout();                              break;
    case 'filter': setFilter(tag);                        break;
    case 'add':    handleAdd();                           break;
    case 'listen': window.open(url, '_blank');            break;
    case 'expand': toggleArtist(albumId, artist);        break;
    case 'done':   markDone(parseInt(index, 10));        break;
  }
});

// Enter key in the add input (listener survives re-renders since it's on the container)
appEl.addEventListener('keydown', e => {
  if (e.target.id === 'url-input' && e.key === 'Enter') handleAdd();
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

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

boot();
