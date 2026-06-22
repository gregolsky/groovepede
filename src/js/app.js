import '../css/style.css';
import { login, clearToken, tokenValid, exchangeCode, refreshAccessToken } from './auth.js';
import { spotifyGet, fetchAlbumMeta, enrichWithLastfm, fetchLastfmArtist, fetchSpotifyArtist, fetchAlbumTracks } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, extractAlbumId, validateAlbumInput, serializeBackup, parseBackup } from './storage.js';
import { renderAuthArea, renderApp } from './render.js';
import * as sync from './sync.js';

// ── State ─────────────────────────────────────────────────────────────────────
let userProfile  = null;
let activeFilter = 'all';
let loadingAdd   = false;
let artistCache  = {};
let trackCache   = {};
let exploreIndex = null; // integer index into visible album list, or null
let animating    = false;
let addError     = null;
let profileOpen  = false;
let searchQuery  = '';
let tagsExpanded = false;
let addOpen      = false;

const appEl  = document.getElementById('app');
const authEl = document.getElementById('auth-area');

function visibleAlbums() {
  const albums = loadAlbums();
  let list = activeFilter === 'all' ? albums : albums.filter(a => (a.tags || []).includes(activeFilter));
  const q = searchQuery.trim().toLowerCase();
  if (q) list = list.filter(a => (a.title || '').toLowerCase().includes(q) || (a.artist || '').toLowerCase().includes(q));
  return list;
}

function getState() {
  return { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex, addError, profileOpen, userProfile, searchQuery, tagsExpanded, addOpen };
}

function rerender() {
  const focused = document.activeElement;
  const focusId = focused?.id;
  const selStart = focused?.selectionStart;
  const selEnd   = focused?.selectionEnd;

  renderAuthArea(authEl, userProfile);
  renderApp(appEl, getState());

  if (focusId === 'search-input' || focusId === 'url-input') {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { el.setSelectionRange(selStart, selEnd); } catch {}
    }
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function setFilter(tag) {
  activeFilter = tag;
  rerender();
}

async function handleAdd() {
  const input = appEl.querySelector('#url-input');
  if (!input) return;
  const { id, error } = validateAlbumInput(input.value.trim());
  if (!id) {
    addError = error;
    input.classList.add('error');
    rerender();
    return;
  }
  addError = null;
  input.classList.remove('error');

  const albums = loadAlbums();
  if (albums.find(a => a.id === id)) { input.value = ''; return; }

  loadingAdd = true;
  rerender();

  const meta = await fetchAlbumMeta(id);
  if (meta?._error === 403) {
    addError = 'Spotify access denied — this app is in development mode and your account is not on the allowlist.';
  } else if (meta?._error) {
    addError = 'Could not fetch album from Spotify (error ' + meta._error + ').';
  } else if (meta) {
    albums.push(meta); saveAlbums(albums); sync.schedulePush();
  }

  loadingAdd = false;
  if (meta && !meta._error) addOpen = false;
  rerender();

  const inp = appEl.querySelector('#url-input');
  if (inp) inp.value = '';
  if (meta && !meta._error) enrichWithLastfm(meta.id, meta.artist, meta.title, rerender);
}

function markDone(visibleIdx, triggerEl) {
  const album = visibleAlbums()[visibleIdx];
  if (!album) return;
  const btn  = triggerEl || appEl.querySelector(`[data-action="done"][data-index="${visibleIdx}"]`);
  const card = btn?.closest('.card');
  if (card) {
    card.classList.add('done-flash');
    setTimeout(() => applyDone(album), 550);
  } else {
    applyDone(album);
  }
}

function applyDone(album) {
  const albums = loadAlbums();
  const idx    = albums.findIndex(a => a.id === album.id);
  if (idx === -1) return;
  albums.splice(idx, 1);
  saveAlbums(albums);
  saveDone(loadDone() + 1);
  sync.schedulePush();
  rerender();
}

function markExploreDone(visibleIdx, triggerEl) {
  const album = visibleAlbums()[visibleIdx];
  if (!album) return;
  const btn  = triggerEl || appEl.querySelector(`[data-action="explore-done"][data-index="${visibleIdx}"]`);
  const card = btn?.closest('.explore-album');
  if (card) {
    card.classList.add('done-flash');
    setTimeout(() => applyExploreDone(visibleIdx, album), 550);
  } else {
    applyExploreDone(visibleIdx, album);
  }
}

function applyExploreDone(visibleIdx, album) {
  const albums = loadAlbums();
  const idx    = albums.findIndex(a => a.id === album.id);
  if (idx === -1) return;
  albums.splice(idx, 1);
  saveAlbums(albums);
  saveDone(loadDone() + 1);
  sync.schedulePush();
  const newVisible = visibleAlbums();
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
  profileOpen = false;
  rerender();
}

function openProfile() {
  profileOpen = true;
  window.history.pushState({ profile: true }, '');
  rerender();
}

function closeProfile() {
  profileOpen = false;
  rerender();
}

function exportData() {
  const text = serializeBackup(loadAlbums(), loadDone());
  const blob = new Blob([text], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `groovepede-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(text) {
  let parsed;
  try {
    parsed = parseBackup(text);
  } catch {
    alert('Invalid backup file — make sure it was exported from Groovepede.');
    return;
  }
  const current = loadAlbums();
  if (current.length > 0 && !confirm(`Replace your ${current.length} album${current.length !== 1 ? 's' : ''} with ${parsed.albums.length} from the file?`)) {
    return;
  }
  saveAlbums(parsed.albums);
  saveDone(parsed.done);
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
    case 'toggle-add':
      addOpen = !addOpen;
      if (!addOpen) addError = null;
      rerender();
      if (addOpen) requestAnimationFrame(() => document.getElementById('url-input')?.focus());
      break;
    case 'clear-search':
      searchQuery = '';
      rerender();
      requestAnimationFrame(() => document.getElementById('search-input')?.focus());
      break;
    case 'toggle-tags':
      tagsExpanded = !tagsExpanded;
      rerender();
      break;
    case 'listen':        window.open(url, '_blank');           break;
    case 'explore':       openExplore(parseInt(index, 10));     break;
    case 'close-explore': closeExplore();                       break;
    case 'explore-prev':  navigateExplore(-1);                  break;
    case 'explore-next':  navigateExplore(+1);                  break;
    case 'done':          markDone(parseInt(index, 10), el);         break;
    case 'explore-done':  markExploreDone(parseInt(index, 10), el);  break;
    case 'open-profile':  openProfile();                        break;
    case 'close-profile': closeProfile();                       break;
    case 'export-data':   exportData();                         break;
    case 'import-data':   document.getElementById('profile-import-input')?.click(); break;
    case 'toggle-sync':
      if (sync.isSyncEnabled()) { sync.disableSync(); rerender(); }
      else { sync.enableSync(userProfile); } // notify() inside rerenders via _onChange
      break;
    case 'restore-sync':  sync.pullNow(rerender);               break;
  }
});

// Enter key in the add input
appEl.addEventListener('keydown', e => {
  if (e.target.id === 'url-input' && e.key === 'Enter') handleAdd();
});

// Search input and add error clearing
appEl.addEventListener('input', e => {
  if (e.target.id === 'search-input') {
    searchQuery = e.target.value;
    rerender();
    return;
  }
  if (e.target.id === 'url-input' && addError) {
    addError = null;
    e.target.classList.remove('error');
    const errEl = appEl.querySelector('.add-error');
    if (errEl) errEl.remove();
  }
});

// File picker for queue import
appEl.addEventListener('change', e => {
  if (e.target.id !== 'profile-import-input') return;
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => importData(evt.target.result);
  reader.readAsText(file);
});

// Keyboard navigation
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !animating) {
    if (addOpen) { addOpen = false; addError = null; rerender(); }
    else if (exploreIndex !== null) closeExplore();
    else if (profileOpen) closeProfile();
  }
  if (exploreIndex === null) return;
  if (e.key === 'ArrowLeft')  navigateExplore(-1);
  if (e.key === 'ArrowRight') navigateExplore(+1);
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
  if (exploreIndex !== null) { exploreIndex = null; rerender(); }
  else if (profileOpen)      { profileOpen  = false; rerender(); }
});

function showShareConfirmAndClose(meta, highlightId) {
  const el = document.createElement('div');
  el.id = 'share-confirm';
  el.innerHTML = `
    <img src="${meta.cover}" alt="">
    <svg class="share-check" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="26"/>
      <path d="M14 27l8 8 16-16"/>
    </svg>
    <div class="share-confirm__text">
      <p class="share-confirm__title">${meta.title}</p>
      <p class="share-confirm__artist">${meta.artist}</p>
      <p class="share-confirm__label">Added to queue</p>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('share-confirm--in'));

  setTimeout(() => window.close(), 900);
  setTimeout(() => {
    if (document.body.contains(el)) {
      el.remove();
      const card = document.getElementById('card-' + highlightId);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('card--highlight');
      }
    }
  }, 1050);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
sync.setStatusListener(rerender);

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

  if (navigator.storage?.persist) navigator.storage.persist();

  userProfile = await spotifyGet('/me');
  renderAuthArea(authEl, userProfile);

  // Complete pending sync enable that required a re-auth
  if (sync.hasPendingEnable()) {
    await sync.finishEnableAfterAuth(userProfile);
    rerender();
  }

  if (shared) {
    const isShareLaunch = window.matchMedia('(display-mode: standalone)').matches;
    const { id, error } = validateAlbumInput(shared);
    if (!id && error) {
      addError = error;
      addOpen = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
    }
    if (id) {
      const albums = loadAlbums();
      let highlightId = null;
      let addedMeta = null;
      if (!albums.find(a => a.id === id)) {
        const meta = await fetchAlbumMeta(id);
        if (meta) {
          albums.push(meta);
          saveAlbums(albums);
          highlightId = meta.id;
          addedMeta = meta;
          enrichWithLastfm(meta.id, meta.artist, meta.title, rerender);
        }
      } else {
        highlightId = id;
        addedMeta = albums.find(a => a.id === id);
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
      if (highlightId) {
        if (isShareLaunch && addedMeta) {
          showShareConfirmAndClose(addedMeta, highlightId);
        } else {
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
  }

  const albums = loadAlbums();
  const yearOnly = /^\d{4}s?$/;
  for (const album of albums) {
    const hasMeaningfulTags = (album.tags || []).some(t => !yearOnly.test(t));
    if (!hasMeaningfulTags && album.artist && album.title) {
      enrichWithLastfm(album.id, album.artist, album.title, rerender);
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) window.location.reload();
    });
  }
}

boot();
