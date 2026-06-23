import '../css/style.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/geist-mono';
import { login, clearToken, tokenValid, exchangeCode, refreshAccessToken } from './auth.js';
import { spotifyGet, fetchAlbumMeta, fetchAlbumFirstTrack, resolveAlbum, enrichWithLastfm, fetchLastfmArtist, fetchSpotifyArtist, fetchAlbumTracks } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, extractAlbumId, validateAlbumInput, parseMusicLink, serializeBackup, parseBackup, getPreferredService, setPreferredService, makePendingRecord, isRetryableResolveError } from './storage.js';
import { renderAuthArea, renderApp } from './render.js';
import * as sync from './sync.js';

// ── State ─────────────────────────────────────────────────────────────────────
let userProfile    = null;
let activeFilter   = 'all';
let loadingAdd     = false;
let artistCache    = {};
let trackCache     = {};
let exploreIndex   = null; // integer index into visible album list, or null
let animating      = false;
let addError       = null;
let profileOpen    = false;
let searchQuery    = '';
let tagsExpanded   = false;
let addOpen        = false;
let importProgress = null; // { done, total } while resolving, or null

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  return { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex, addError, profileOpen, userProfile, searchQuery, tagsExpanded, addOpen, prefService: getPreferredService(), importProgress };
}

let _entrancePlayed = false;

function rerender() {
  const focused = document.activeElement;
  const focusId = focused?.id;
  const selStart = focused?.selectionStart;
  const selEnd   = focused?.selectionEnd;

  // Play the orchestrated entrance motion once per load. The class must be on
  // #app before its innerHTML is rebuilt so the fresh nodes match the scoped
  // rules; remove it afterwards so later rerenders don't replay the animation.
  if (!_entrancePlayed) {
    _entrancePlayed = true;
    appEl.classList.add('animate-in');
    setTimeout(() => appEl.classList.remove('animate-in'), 2500);
  }

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
  const { url, service, error } = parseMusicLink(input.value.trim());
  if (error !== undefined) {
    // error is set — either a real message or null (empty input)
    if (error) {
      addError = error;
      input.classList.add('error');
      rerender();
    }
    return;
  }
  addError = null;
  input.classList.remove('error');

  const albums = loadAlbums();
  // Dedup on sourceUrl before resolving (fast path for re-pasting same link)
  if (albums.find(a => a.sourceUrl === url || (a._pending && a.sourceUrl === url))) {
    input.value = '';
    addOpen = false;
    rerender();
    return;
  }

  loadingAdd = true;
  rerender();

  const rec = await resolveAlbum(url);

  if (!rec._error) {
    // Success — dedup on resolved ID too (different URL, same album)
    const fresh = loadAlbums();
    if (!fresh.find(a => a.id === rec.id)) {
      // Fetch firstTrackUri for Spotify sync support (Odesli doesn't return track URIs)
      if (rec.links?.spotify && tokenValid()) {
        const spotifyId = extractAlbumId(rec.links.spotify.url);
        if (spotifyId) {
          rec.firstTrackUri = await fetchAlbumFirstTrack(spotifyId);
        }
      }
      fresh.push(rec);
      saveAlbums(fresh);
      if (tokenValid()) sync.schedulePush();
    }
    loadingAdd = false;
    addOpen = false;
    rerender();
    const inp = appEl.querySelector('#url-input');
    if (inp) inp.value = '';
    enrichWithLastfm(rec.id, rec.artist, rec.title, rerender);
  } else if (isRetryableResolveError(rec._error)) {
    // Odesli is down / rate-limited — save a pending stub so the link isn't lost
    const fresh = loadAlbums();
    if (!fresh.find(a => a.sourceUrl === url)) {
      fresh.push(makePendingRecord(url, service));
      saveAlbums(fresh);
    }
    loadingAdd = false;
    addOpen = false;
    rerender();
    const inp = appEl.querySelector('#url-input');
    if (inp) inp.value = '';
  } else {
    // Non-retryable (404 / 400) — show error, don't save
    addError = 'Couldn’t find that album — double-check the link and try again.';
    loadingAdd = false;
    rerender();
  }
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
  if (tokenValid()) sync.schedulePush();
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
  if (tokenValid()) sync.schedulePush();
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
  // Close profile and land on the populated queue immediately
  profileOpen  = false;
  exploreIndex = null;
  rerender();
  // Resolve all pending stubs fresh (throttled, with progress bar)
  resolvePending();
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
    case 'set-pref-service':
      setPreferredService(el.value);
      rerender();
      break;
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

// ── Pending resolution retry ───────────────────────────────────────────────────

let _resolvingPending = false;
let _resolvePendingAgain = false;

async function resolvePending() {
  if (_resolvingPending) { _resolvePendingAgain = true; return; }
  if (!loadAlbums().some(a => a._pending)) return;

  _resolvingPending = true;
  do {
  _resolvePendingAgain = false;
  const pending = loadAlbums().filter(a => a._pending);
  if (!pending.length) break;

  importProgress = { done: 0, total: pending.length };
  rerender();

  for (const stub of pending) {
    const rec = await resolveAlbum(stub.sourceUrl);
    if (!rec._error) {
      // Fetch Spotify firstTrackUri for sync support
      if (rec.links?.spotify && tokenValid()) {
        const spotifyId = extractAlbumId(rec.links.spotify.url);
        if (spotifyId) rec.firstTrackUri = await fetchAlbumFirstTrack(spotifyId);
      }

      // Replace the pending stub in place, preserving original addedAt
      rec.addedAt = stub.addedAt;
      const fresh = loadAlbums();
      const idx = fresh.findIndex(a => a.id === stub.id);
      if (idx !== -1) fresh.splice(idx, 1, rec);
      saveAlbums(fresh);

      enrichWithLastfm(rec.id, rec.artist, rec.title, rerender);
    }

    importProgress = { done: importProgress.done + 1, total: importProgress.total };
    rerender();

    // Pace to stay within Odesli's free-tier limit (~10 req/min = 1 per 6 s)
    if (importProgress.done < importProgress.total) {
      await sleep(6500);
    }
  }
  } while (_resolvePendingAgain);

  importProgress = null;
  _resolvingPending = false;
  rerender();
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

  // Retry any pending records from previous sessions (runs even when logged out)
  resolvePending();

  // Spotify-conditional: profile + sync setup (skipped when logged out)
  if (tokenValid()) {
    if (navigator.storage?.persist) navigator.storage.persist();

    userProfile = await spotifyGet('/me');
    renderAuthArea(authEl, userProfile);

    if (sync.hasPendingEnable()) {
      await sync.finishEnableAfterAuth(userProfile);
      rerender();
    }
  }

  if (shared) {
    const isShareLaunch = window.matchMedia('(display-mode: standalone)').matches;
    const { url, service, error } = parseMusicLink(shared);
    if (error) {
      addError = error;
      addOpen = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
    } else if (url) {
      const albums = loadAlbums();
      let highlightId = null;
      let addedMeta = null;
      const existing = albums.find(a => a.sourceUrl === url);
      if (existing) {
        highlightId = existing.id;
        addedMeta = existing._pending ? null : existing;
      } else {
        const rec = await resolveAlbum(url);
        if (!rec._error) {
          // Fetch Spotify firstTrackUri for sync support
          if (rec.links?.spotify && tokenValid()) {
            const spotifyId = extractAlbumId(rec.links.spotify.url);
            if (spotifyId) rec.firstTrackUri = await fetchAlbumFirstTrack(spotifyId);
          }
          const fresh = loadAlbums();
          if (!fresh.find(a => a.id === rec.id)) {
            fresh.push(rec);
            saveAlbums(fresh);
            if (tokenValid()) sync.schedulePush();
          }
          highlightId = rec.id;
          addedMeta = rec;
          enrichWithLastfm(rec.id, rec.artist, rec.title, rerender);
        } else if (isRetryableResolveError(rec._error)) {
          // Odesli down — save pending stub so share isn't lost
          const stub = makePendingRecord(url, service);
          const fresh = loadAlbums();
          fresh.push(stub);
          saveAlbums(fresh);
          highlightId = stub.id;
          addedMeta = null; // no cover/title for confirmation overlay
        }
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
      if (highlightId) {
        if (isShareLaunch && addedMeta?.cover) {
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
