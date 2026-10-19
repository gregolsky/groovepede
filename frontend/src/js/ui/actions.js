/**
 * Input → command. Markup names what a click means with `data-action`
 * (render.js); COMMANDS maps each name to its handler. Keys, swipes and the
 * back button reuse the same handlers, so every way of doing a thing behaves
 * the same.
 *
 * Event handling is one delegated listener per event type: the markup is
 * rebuilt on every rerender, and it carries no inline handlers (CSP-ready).
 */
import { isSafeLinkUrl } from '../domain/music-services.js';
import { ui, setUi } from './state.js';
import { submitAdd, toggleAdd, closeAdd, dismissAddError } from './add-form.js';
import { openExplore, closeExplore, navigateExplore, markDone, retryTracks, refreshDetails, isAnimating } from './explore.js';
import {
  openProfile, closeProfile, setPrefService, downloadBackup, pickBackupFile, readBackupFile,
  closeImportSummary, copyFailedLinks, resumePendingIfAny,
} from './profile.js';

function clearSearch() {
  setUi({ searchQuery: '' });
  requestAnimationFrame(() => document.getElementById('search-input')?.focus());
}

function openListenLink(url) {
  // Guarded at the sink too, not just on import: records already in storage
  // from before import-time validation existed never went through it.
  if (isSafeLinkUrl(url)) window.open(url, '_blank', 'noopener');
}

/** Close whatever is on top: the import summary, the add form, explore, then the profile. */
function closeTopmost() {
  if (ui.importSummary)            closeImportSummary();
  else if (ui.addOpen)             closeAdd();
  else if (ui.exploreIndex !== null) closeExplore();
  else if (ui.profileOpen)         closeProfile();
}

/** Each handler gets the element's dataset, `index` parsed, and the element itself. */
const COMMANDS = {
  'filter':               ({ tag }) => setUi({ activeFilter: tag }),
  'clear-search':         () => clearSearch(),
  'toggle-tags':          () => setUi({ tagsExpanded: !ui.tagsExpanded }),
  'add':                  () => submitAdd(),
  'toggle-add':           () => toggleAdd(),
  'listen':               ({ url }) => openListenLink(url),
  'done':                 ({ index, el }) => markDone(index, el),
  'explore':              ({ index }) => openExplore(index),
  'close-explore':        () => closeExplore(),
  'explore-prev':         () => navigateExplore(-1),
  'explore-next':         () => navigateExplore(+1),
  'explore-done':         ({ index, el }) => markDone(index, el, { explore: true }),
  'retry-tracks':         ({ index }) => retryTracks(index),
  'refresh':              ({ index }) => refreshDetails(index),
  'open-profile':         () => openProfile(),
  'close-profile':        () => closeProfile(),
  'set-pref-service':     ({ el }) => setPrefService(el.value),
  'export-data':          () => downloadBackup(),
  'import-data':          () => pickBackupFile(),
  'close-import-summary': () => closeImportSummary(),
  'copy-import-links':    () => copyFailedLinks(),
};

/** Wire every listener. Call once at boot. */
export function bindEvents() {
  const appEl = document.getElementById('app');

  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    const command = el && COMMANDS[el.dataset.action];
    if (!command) return;
    command({ ...el.dataset, index: parseInt(el.dataset.index, 10), el });
  });

  appEl.addEventListener('keydown', e => {
    if (e.target.id === 'url-input' && e.key === 'Enter') submitAdd();
  });

  appEl.addEventListener('input', e => {
    if (e.target.id === 'search-input') setUi({ searchQuery: e.target.value });
    else if (e.target.id === 'url-input') dismissAddError();
  });

  appEl.addEventListener('change', e => {
    if (e.target.id !== 'profile-import-input') return;
    readBackupFile(e.target.files?.[0]);
    e.target.value = ''; // so picking the same file again still fires `change`
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !isAnimating()) closeTopmost();
    if (ui.exploreIndex === null) return;
    if (e.key === 'ArrowLeft')  navigateExplore(-1);
    if (e.key === 'ArrowRight') navigateExplore(+1);
  });

  // Swipe between albums in explore.
  let touchStartX = 0;
  document.body.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  document.body.addEventListener('touchend', e => {
    if (ui.exploreIndex === null || isAnimating()) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) navigateExplore(dx < 0 ? +1 : -1);
  }, { passive: true });

  // Browser back: leave explore, else the profile.
  window.addEventListener('popstate', () => {
    if (ui.exploreIndex !== null) closeExplore();
    else if (ui.profileOpen)      closeProfile();
  });

  // Landing images fade in once loaded and hide if they fail to load —
  // behaviour the markup can't carry without inline onload/onerror. load/error
  // don't bubble, hence capture-phase listeners on the document.
  const REVEAL_IMG = 'img.landing-feature-img, img.landing-timeline-img';
  document.addEventListener('load',  e => { if (e.target.matches?.(REVEAL_IMG)) e.target.classList.add('img-loaded'); }, true);
  document.addEventListener('error', e => { if (e.target.matches?.(REVEAL_IMG)) e.target.style.visibility = 'hidden'; }, true);

  // Coming back to the app resumes any pending resolution the OS suspended.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumePendingIfAny();
  });
  window.addEventListener('focus', resumePendingIfAny);
}
