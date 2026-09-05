import '../css/style.css';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/geist-mono';
import { resolveAlbumResilient, enrichWithLastfm, fetchLastfmArtist, fetchArtistImage, fetchAlbumTracks, deezerAlbumId, TRACKS_ERROR } from './api.js';
import { loadAlbums, saveAlbums, loadDone, saveDone, parseMusicLink, filterAlbums, serializeBackup, parseBackup, getPreferredService, setPreferredService, hasExplicitPreferredService, makePendingRecord, isRetryableResolveError, mergeRefreshedAlbum } from './storage.js';
import { renderAuthArea, renderApp, renderShareOverlay } from './render.js';
import { initBeacon } from './beacon.js';

// ── State ─────────────────────────────────────────────────────────────────────
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
let importProgress = null;  // { done, total, retrying } while resolving, or null
let importSummary  = null;  // { added, failed[] } shown as modal after a user-triggered import
let refreshingId   = null;  // album.id currently being refreshed, or null

const appEl  = document.getElementById('app');
const authEl = document.getElementById('auth-area');

function visibleAlbums() {
  return filterAlbums(loadAlbums(), activeFilter, searchQuery);
}

function getState() {
  return { activeFilter, loadingAdd, artistCache, trackCache, exploreIndex, addError, profileOpen, searchQuery, tagsExpanded, addOpen, prefService: getPreferredService(), importProgress, importSummary, refreshingId };
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

  renderAuthArea(authEl);
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

/**
 * Persist a freshly resolved album and kick off its background enrichment.
 *
 * Shared by all three entry points (paste, share-target launch, pending retry)
 * so the id-dedupe and the Last.fm enrichment can't drift between them.
 *
 * Re-reads storage rather than trusting a caller-held array: resolving is async,
 * and a share-target add or a pending retry can land in between.
 */
async function saveResolvedAlbum(rec) {
  const albums = loadAlbums();
  if (albums.find(a => a.id === rec.id)) return rec;  // already queued
  const fresh = loadAlbums();
  fresh.push(rec);
  saveAlbums(fresh);
  enrichWithLastfm(rec.id, rec.artist, rec.title, rerender);
  return rec;
}

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

  const rec = await resolveAlbumResilient(url, { service });

  if (!rec._error) {
    // Auto-set preferred service from the first link pasted (if never explicitly chosen)
    if (service && !hasExplicitPreferredService()) setPreferredService(service);

    // Success — dedup on resolved ID too (different URL, same album)
    await saveResolvedAlbum(rec);
    loadingAdd = false;
    addOpen = false;
    rerender();
    const inp = appEl.querySelector('#url-input');
    if (inp) inp.value = '';
  } else if (isRetryableResolveError(rec._error)) {
    // Resolver + MusicBrainz both failed with a retryable error — save a pending stub so the link isn't lost
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

/**
 * Mark the album at a visible index as listened. Flashes the card first when it
 * is on screen, so the removal has a beat of feedback.
 *
 * `explore` selects which card wraps the button and, after removal, keeps the
 * explore view open on the album that slid into this slot (or closes it when
 * the queue is empty). The list-view path just rerenders.
 */
function markDone(visibleIdx, triggerEl, { explore = false } = {}) {
  const album = visibleAlbums()[visibleIdx];
  if (!album) return;
  const action = explore ? 'explore-done' : 'done';
  const btn    = triggerEl || appEl.querySelector(`[data-action="${action}"][data-index="${visibleIdx}"]`);
  const card   = btn?.closest(explore ? '.explore-album' : '.card');
  if (card) {
    card.classList.add('done-flash');
    setTimeout(() => applyDone(visibleIdx, album, explore), 550);
  } else {
    applyDone(visibleIdx, album, explore);
  }
}

function applyDone(visibleIdx, album, explore) {
  const albums = loadAlbums();
  const idx    = albums.findIndex(a => a.id === album.id);
  if (idx === -1) return;
  albums.splice(idx, 1);
  saveAlbums(albums);
  saveDone(loadDone() + 1);

  if (explore) {
    const newVisible = visibleAlbums();
    if (newVisible.length === 0) {
      exploreIndex = null;
    } else {
      exploreIndex = Math.min(visibleIdx, newVisible.length - 1);
      prefetchExplore(newVisible[exploreIndex]);
    }
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
  const { artist, id } = album;
  const deezerId    = deezerAlbumId(album);
  const needsLastfm = !artistCache[artist];
  // Retry-eligible when never fetched OR the last attempt failed (TRACKS_ERROR)
  // — a plain array (even []) means "done", success or genuine no-tracklist,
  // and is never refetched. Without the TRACKS_ERROR branch here, a single
  // transient failure used to be indistinguishable from "done" and could
  // never be retried for the rest of the session.
  const needsTracks = deezerId && (trackCache[id] === undefined || trackCache[id] === TRACKS_ERROR);
  // No Deezer link → no tracklist to fetch; mark empty so the card shows no
  // tracklist instead of a perpetual "Loading tracks…".
  if (!deezerId && trackCache[id] === undefined) trackCache[id] = [];

  const fetches = [];
  if (needsLastfm) fetches.push(fetchLastfmArtist(artist).then(d => { artistCache[artist] = { ...artistCache[artist], ...d }; }));
  if (needsTracks) fetches.push(fetchAlbumTracks(deezerId).then(t => { trackCache[id] = t; }));

  if (fetches.length) {
    await Promise.all(fetches);
    if (exploreIndex !== null && visibleAlbums()[exploreIndex]?.id === id) rerender();
  }

  if (!artistCache[artist]?.image) {
    const image = await fetchArtistImage(album);
    if (image) {
      artistCache[artist] = { ...artistCache[artist], image };
      if (exploreIndex !== null && visibleAlbums()[exploreIndex]?.id === id) rerender();
    }
  }
}

function closeExplore() {
  exploreIndex = null;
  rerender();
}

/** Explicit retry for a failed tracklist fetch — the explore card's error
 * state offers this rather than making the user navigate away and back
 * (which would also retry, since prefetchExplore treats TRACKS_ERROR as
 * retry-eligible, but shouldn't be the ONLY way to recover). */
function retryTracks(visibleIdx) {
  const album = visibleAlbums()[visibleIdx];
  if (!album) return;
  const deezerId = deezerAlbumId(album);
  if (!deezerId) return;
  delete trackCache[album.id];
  rerender();
  fetchAlbumTracks(deezerId).then(t => {
    trackCache[album.id] = t;
    if (exploreIndex !== null && visibleAlbums()[exploreIndex]?.id === album.id) rerender();
  });
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
  // Resolve all pending stubs fresh (throttled, with progress bar + summary on drain)
  resolvePending({ summarize: true });
}

async function refreshAlbum(visibleIdx) {
  const album = visibleAlbums()[visibleIdx];
  if (!album || !album.sourceUrl) return;
  refreshingId = album.id;
  rerender();
  try {
    const rec = await resolveAlbumResilient(album.sourceUrl, { service: album.service });
    if (!rec._error) {
      const merged = mergeRefreshedAlbum(album, rec);
      const all = loadAlbums();
      const pos = all.findIndex(a => a.id === album.id);
      if (pos !== -1) { all[pos] = merged; saveAlbums(all); }
      delete artistCache[album.artist]; // clear so explore re-fetches artist data
      // Clear so explore re-fetches the tracklist too — the refresh may have
      // picked up a Deezer cross-link that didn't exist before, and this was
      // previously the one thing "Refresh details" couldn't fix: a stuck
      // TRACKS_ERROR (or a stale empty result) just sat there forever. The
      // "refresh" action only ever renders from inside the explore card
      // (see render.js), so re-running prefetchExplore here is always for
      // the album currently on screen.
      delete trackCache[album.id];
      prefetchExplore(merged);
      enrichWithLastfm(merged.id, merged.artist, merged.title, rerender);
    }
    // On failure: silently keep existing data, no error surfaced
  } finally {
    refreshingId = null;
    rerender();
  }
}

// ── Event delegation ──────────────────────────────────────────────────────────
document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, tag, url, index } = el.dataset;

  switch (action) {
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
    case 'done':          markDone(parseInt(index, 10), el);                       break;
    case 'explore-done':  markDone(parseInt(index, 10), el, { explore: true });     break;
    case 'retry-tracks':  retryTracks(parseInt(index, 10));  break;
    case 'open-profile':  openProfile();                        break;
    case 'close-profile': closeProfile();                       break;
    case 'export-data':   exportData();                         break;
    case 'import-data':   document.getElementById('profile-import-input')?.click(); break;
    case 'close-import-summary':
      importSummary = null;
      rerender();
      break;
    case 'copy-import-links':
      if (importSummary?.failed?.length) {
        navigator.clipboard?.writeText(importSummary.failed.join('\n'));
      }
      break;
    case 'refresh':       refreshAlbum(parseInt(index, 10));    break;
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
    if (importSummary)          { importSummary = null; rerender(); }
    else if (addOpen)           { addOpen = false; addError = null; rerender(); }
    else if (exploreIndex !== null) closeExplore();
    else if (profileOpen)       closeProfile();
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

// ── Share-target overlay ──────────────────────────────────────────────────────
// Launching from a share used to show nothing at all until the album resolved:
// a token refresh, a /me call and a resolver round trip happen first, so the app
// sat there looking ignored for 2-3 seconds. The overlay now goes up BEFORE the
// first await and morphs into the confirmation, instead of only existing at the
// end of the flow.

let _shareEl      = null;
let _shareShownAt = 0;

// Don't flash: once the overlay is up it stays for at least this long before a
// terminal phase replaces it, even if the resolver answered instantly.
const SHARE_MIN_MS = 500;

function showShareOverlay(phase, data = {}) {
  if (!_shareEl) {
    _shareEl = document.createElement('div');
    _shareEl.id = 'share-overlay';
    // Announced by screen readers as the phase changes, hence status/polite.
    _shareEl.setAttribute('role', 'status');
    _shareEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(_shareEl);
    _shareShownAt = Date.now();
  }
  // Deliberately NO entrance animation on the overlay itself. Measured on a
  // cold share launch: the main thread is busy booting, so a scale-in scheduled
  // via rAF sat frozen at its 0.88 start frame for up to 400ms before running —
  // a stutter at precisely the moment this thing exists to reassure. The scrim
  // appears instantly; only the cover and badge animate, and by then boot is done.
  _shareEl.className = `share-overlay--${phase}`;
  _shareEl.innerHTML = renderShareOverlay({ phase, ...data });
}

/** Apply a terminal phase, honouring the minimum visible time. */
async function setSharePhase(phase, data = {}) {
  if (!_shareEl) return;
  const elapsed = Date.now() - _shareShownAt;
  if (elapsed < SHARE_MIN_MS) await _sleep(SHARE_MIN_MS - elapsed);
  showShareOverlay(phase, data);
}

function hideShareOverlay() {
  _shareEl?.remove();
  _shareEl = null;
}

function highlightCard(highlightId) {
  const card = highlightId && document.getElementById('card-' + highlightId);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('card--highlight');
  }
}

/**
 * Close out a successful share: hold the confirmation briefly, close the window
 * when this was a share launch (the user is expecting to land back where they
 * came from), and otherwise fall back to highlighting the card in place.
 */
/**
 * The error phase is the one the user has to read, so it neither auto-closes
 * fast nor blocks: a tap dismisses it, otherwise it fades after a few seconds,
 * revealing the add form with the same message already in it.
 */
function dismissShareError() {
  const el = _shareEl;
  if (!el) return;
  const close = () => { if (_shareEl === el) hideShareOverlay(); };
  el.addEventListener('click', close);
  setTimeout(close, 3200);
}

function finishShareOverlay(highlightId, isShareLaunch) {
  if (isShareLaunch) setTimeout(() => window.close(), 900);
  setTimeout(() => {
    if (!_shareEl) return;
    hideShareOverlay();
    highlightCard(highlightId);
  }, 1050);
}

// ── Pending resolution retry ───────────────────────────────────────────────────

let _resolvingPending = false;
let _resolvePendingAgain = false;

// Backoff for transient errors in the retry loop (separate from the throttler's
// cooldown, which already paces resolver/MB calls). Capped at 60 s.
const _retryBackoff = n => Math.min(Math.pow(2, n) * 1000, 60_000);
const _sleep = ms => new Promise(r => setTimeout(r, ms));

async function resolvePending({ summarize = false } = {}) {
  if (_resolvingPending) { _resolvePendingAgain = true; return; }
  if (!loadAlbums().some(a => a._pending)) return;

  _resolvingPending = true;
  let added = 0;
  const failed = [];

  do {
    _resolvePendingAgain = false;
    const pending = loadAlbums().filter(a => a._pending);
    if (!pending.length) break;

    importProgress = { done: 0, total: pending.length, retrying: 0 };
    rerender();

    for (const stub of pending) {
      let retry = 0;
      const MAX_RETRIES = 4;

      while (true) {
        const rec = await resolveAlbumResilient(stub.sourceUrl, { service: stub.service });

        if (!rec._error) {
          // ── Resolved ──────────────────────────────────────────────────────
          rec.addedAt = stub.addedAt; // preserve original addedAt
          const fresh = loadAlbums();
          const pos = fresh.findIndex(a => a.id === stub.id);
          if (pos !== -1) fresh.splice(pos, 1, rec);
          saveAlbums(fresh);
          enrichWithLastfm(rec.id, rec.artist, rec.title, rerender);
          added++;
          break;

        } else if (isRetryableResolveError(rec._error) && retry < MAX_RETRIES) {
          // ── Transient / rate-limited — back off and retry ─────────────────
          retry++;
          importProgress.retrying = retry;
          rerender();
          await _sleep(_retryBackoff(retry));

        } else if (isRetryableResolveError(rec._error)) {
          // ── Still failing after MAX_RETRIES — leave stub pending, move on ─
          // resumePendingIfAny() will retry it when the user returns later.
          break;

        } else {
          // ── Permanent failure (not-found / 4xx) — drop stub, record URL ──
          failed.push(stub.sourceUrl);
          const fresh = loadAlbums();
          const pos = fresh.findIndex(a => a.id === stub.id);
          if (pos !== -1) { fresh.splice(pos, 1); saveAlbums(fresh); }
          break;
        }
      }

      importProgress.done++;
      importProgress.retrying = 0;
      rerender();
    }
  } while (_resolvePendingAgain);

  importProgress = null;
  _resolvingPending = false;

  if (summarize) {
    importSummary = { added, failed };
  }
  rerender();
}

// ── Resume-on-return ──────────────────────────────────────────────────────────
// Mobile browsers suspend JS timers when the app is backgrounded. Resume any
// in-progress import when the user returns, so cards keep populating.
function resumePendingIfAny() {
  if (loadAlbums().some(a => a._pending)) resolvePending();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumePendingIfAny();
});
window.addEventListener('focus', resumePendingIfAny);

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  initBeacon();

  const params = new URLSearchParams(window.location.search);
  const shared = params.get('text') || params.get('url');

  // Before ANY await: a share launch must show feedback in its first frame,
  // otherwise the app looks like it dropped the link. parseMusicLink needs no
  // network, so the source service is already known here.
  const sharedParse = shared ? parseMusicLink(shared) : null;
  if (shared) showShareOverlay('adding', { service: sharedParse.service });

  if (navigator.storage?.persist) navigator.storage.persist();

  rerender();

  // Retry any pending records from previous sessions
  resolvePending();

  if (shared) {
    const isShareLaunch = window.matchMedia('(display-mode: standalone)').matches;
    const { url, service, error } = sharedParse;
    if (error) {
      addError = error;
      addOpen = true;
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();
      await setSharePhase('error', { service, message: error });
      dismissShareError();
    } else if (url) {
      const albums = loadAlbums();
      let highlightId = null;
      let addedMeta = null;
      let phase = null;   // which terminal state the overlay lands on
      const existing = albums.find(a => a.sourceUrl === url);
      if (existing) {
        highlightId = existing.id;
        addedMeta = existing._pending ? null : existing;
        phase = existing._pending ? 'pending' : 'exists';
      } else {
        const rec = await resolveAlbumResilient(url, { service });
        if (!rec._error) {
          await saveResolvedAlbum(rec);
          highlightId = rec.id;
          addedMeta = rec;
          phase = 'added';
        } else if (isRetryableResolveError(rec._error)) {
          // Resolver + MusicBrainz both failed with a retryable error — save pending stub so share isn't lost
          const stub = makePendingRecord(url, service);
          const fresh = loadAlbums();
          fresh.push(stub);
          saveAlbums(fresh);
          highlightId = stub.id;
          addedMeta = null; // no cover/title yet — the overlay says so
          phase = 'pending';
        } else {
          // Non-retryable (404 / 400) — surface the failure instead of dropping it silently
          addError = 'Couldn’t find that album — double-check the link and try again.';
          addOpen = true;
          phase = 'error';
        }
      }
      window.history.replaceState({}, document.title, window.location.pathname);
      rerender();

      await setSharePhase(phase, { service, album: addedMeta, message: addError });
      if (phase === 'error') dismissShareError();
      else                   finishShareOverlay(highlightId, isShareLaunch);
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
