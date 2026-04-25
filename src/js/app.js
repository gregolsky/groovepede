import '../css/style.css';
import { login, clearToken, tokenValid, exchangeCode, refreshAccessToken } from './auth.js';
import { spotifyGet, fetchAlbumMeta, enrichWithLastfm, fetchLastfmArtist, fetchSpotifyArtist, fetchAlbumTracks } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, extractAlbumId } from './storage.js';
import { renderAuthArea, renderApp } from './render.js';

// ── State ─────────────────────────────────────────────────────────────────────
let userProfile  = null;
let activeFilter = 'all';
let loadingAdd   = false;
let artistCache  = {};
let trackCache   = {};
let exploreIndex = null; // integer index into visible album list, or null
let animating    = false;

const appEl  = document.getElementById('app');
const authEl = document.getElementById('auth-area');

function visibleAlbums() {
  const albums = loadAlbums();
  return activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
}

function getState() {
  return { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex };
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
  if (meta) enrichWithLastfm(meta.id, meta.artist, meta.title, rerender);
}

function markDone(visibleIdx, triggerEl) {
  const visible = visibleAlbums();
  const album   = visible[visibleIdx];
  if (!album) return;

  // Animate the button/card before committing state change
  const btn = triggerEl || appEl.querySelector(`[data-action="done"][data-index="${visibleIdx}"]`);
  const card = btn?.closest('.card, .explore-album');
  if (card) {
    card.classList.add('done-flash');
    setTimeout(() => applyDone(visibleIdx, album), 550);
  } else {
    applyDone(visibleIdx, album);
  }
}

function applyDone(visibleIdx, album) {
  const albums = loadAlbums();
  const idx    = albums.findIndex(a => a.id === album.id);
  if (idx === -1) return;
  albums.splice(idx, 1);
  saveAlbums(albums);
  saveDone(loadDone() + 1);
  // Stay in explore mode but move to next, or close if list now empty
  const newVisible = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
  if (newVisible.length === 0) {
    exploreIndex = null;
  } else {
    exploreIndex = Math.min(visibleIdx, newVisible.length - 1);
    prefetchExplore(newVisible[exploreIndex]);
  }
  rerender();
}

async function openExplore(index) {
  exploreIndex = index;
  window.history.pushState({ explore: true }, '');
  rerender();
  const album = visibleAlbums()[index];
  if (album) prefetchExplore(album);
}

async function prefetchExplore(album) {
  const { artist, artistId, id } = album;
  const needsLastfm  = !artistCache[artist];
  const needsSpotify = artistId && artistCache[artist]?.image === undefined;
  const needsTracks  = !trackCache[id];

  const fetches = [];
  if (needsLastfm)  fetches.push(fetchLastfmArtist(artist).then(d => { artistCache[artist] = { ...artistCache[artist], ...d }; }));
  if (needsSpotify) fetches.push(fetchSpotifyArtist(artistId).then(d => { if (d) artistCache[artist] = { ...artistCache[artist], ...d }; }));
  if (needsTracks)  fetches.push(fetchAlbumTracks(id).then(t => { trackCache[id] = t; }));

  if (fetches.length) {
    await Promise.all(fetches);
    if (exploreIndex !== null && visibleAlbums()[exploreIndex]?.id === id) rerender();
  }
}

function closeExplore() {
  exploreIndex = null;
  rerender();
}

function navigateExplore(dir) {
  if (animating) return;
  const list = visibleAlbums();
  const next = exploreIndex + dir;
  if (next < 0 || next >= list.length) return;

  animating = true;
  const outClass = dir > 0 ? 'explore--slide-out-left' : 'explore--slide-out-right';
  const inClass  = dir > 0 ? 'explore--slide-in-right' : 'explore--slide-in-left';

  const outEl = appEl.querySelector('.explore');
  if (outEl) outEl.classList.add(outClass);

  setTimeout(() => {
    exploreIndex = next;
    rerender();
    prefetchExplore(list[next]);
    const inEl = appEl.querySelector('.explore');
    if (inEl) {
      inEl.classList.add(inClass);
      setTimeout(() => { inEl.classList.remove(inClass); animating = false; }, 200);
    } else {
      animating = false;
    }
  }, 150);
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
  const { action, tag, url, index } = el.dataset;

  switch (action) {
    case 'login':         login();                              break;
    case 'logout':        logout();                             break;
    case 'filter':        setFilter(tag);                       break;
    case 'add':           handleAdd();                          break;
    case 'listen':        window.open(url, '_blank');           break;
    case 'explore':       openExplore(parseInt(index, 10));     break;
    case 'close-explore': closeExplore();                       break;
    case 'explore-prev':  navigateExplore(-1);                  break;
    case 'explore-next':  navigateExplore(+1);                  break;
    case 'done':          markDone(parseInt(index, 10), el);    break;
  }
});

// Enter key in the add input
appEl.addEventListener('keydown', e => {
  if (e.target.id === 'url-input' && e.key === 'Enter') handleAdd();
});

// Keyboard arrow navigation in explore mode
window.addEventListener('keydown', e => {
  if (exploreIndex === null) return;
  if (e.key === 'ArrowLeft')  navigateExplore(-1);
  if (e.key === 'ArrowRight') navigateExplore(+1);
  if (e.key === 'Escape' && !animating) closeExplore();
});

// Touch swipe in explore mode
let touchStartX = 0;
document.body.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
document.body.addEventListener('touchend', e => {
  if (exploreIndex === null || animating) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) navigateExplore(dx < 0 ? +1 : -1);
}, { passive: true });

// Browser back button
window.addEventListener('popstate', () => {
  if (exploreIndex !== null) {
    exploreIndex = null;
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
      let highlightId = null;
      if (!albums.find(a => a.id === id)) {
        const meta = await fetchAlbumMeta(id);
        if (meta) {
          albums.push(meta);
          saveAlbums(albums);
          highlightId = meta.id;
          enrichWithLastfm(meta.id, meta.artist, meta.title, rerender);
        }
      } else {
        highlightId = id;
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
      if (highlightId) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.getElementById('card-' + highlightId);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('card--highlight');
          }
        }));
      }
    }
  }

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
