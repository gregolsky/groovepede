/**
 * The UI store: view state, and the one rerender() that turns it (plus the
 * stored queue and the explore caches) into markup.
 *
 * `ui` is a frozen snapshot, exported as a live binding: every module reads
 * the current one, none can assign it, and setUi() is the only way to change
 * it — always followed by exactly one rerender.
 */
import { loadAlbums, loadDone, getPreferredService } from '../infra/storage.js';
import { filterAlbums } from '../domain/albums.js';
import { albumDetails } from '../services/album-details.js';
import { renderHeaderActions, renderApp } from './render.js';

export let ui = Object.freeze({
  activeFilter:   'all',
  searchQuery:    '',
  tagsExpanded:   false,
  addOpen:        false,
  loadingAdd:     false,
  addError:       null,
  exploreIndex:   null,  // index into visibleAlbums(), or null
  profileOpen:    false,
  importProgress: null,  // { done, total, retrying } while resolving, or null
  importSummary:  null,  // { added, failed[] } shown as modal after a user-triggered import
  refreshingId:   null,  // album.id currently being refreshed, or null
});

/** `render: false` only when the caller patches the DOM itself (see dismissAddError). */
export function setUi(patch, { render = true } = {}) {
  ui = Object.freeze({ ...ui, ...patch });
  if (render) rerender();
}

/**
 * The album list on screen, after the tag filter and the search box. Every
 * `data-index` in the markup indexes THIS list (see filterAlbums).
 */
export function visibleAlbums() {
  return filterAlbums(loadAlbums(), ui.activeFilter, ui.searchQuery);
}

/** True while the explore view is showing the album with this id. */
export function isExploring(id) {
  return ui.exploreIndex !== null && visibleAlbums()[ui.exploreIndex]?.id === id;
}

/** Rerender when new data concerns the album on screen — the services' onChange. */
export function rerenderIfExploring(id) {
  if (isExploring(id)) rerender();
}

let entrancePlayed = false;

export function rerender() {
  const appEl = document.getElementById('app');
  const focused  = document.activeElement;
  const focusId  = focused?.id;
  const selStart = focused?.selectionStart;
  const selEnd   = focused?.selectionEnd;

  // Play the orchestrated entrance motion once per load. The class must be on
  // #app before its innerHTML is rebuilt so the fresh nodes match the scoped
  // rules; remove it afterwards so later rerenders don't replay the animation.
  if (!entrancePlayed) {
    entrancePlayed = true;
    appEl.classList.add('animate-in');
    setTimeout(() => appEl.classList.remove('animate-in'), 2500);
  }

  renderHeaderActions(document.getElementById('auth-area'));
  // The renderer reads nothing from storage itself; everything it shows is here.
  renderApp(appEl, {
    ...ui,
    ...albumDetails(),
    albums:      loadAlbums(),
    done:        loadDone(),
    prefService: getPreferredService(),
  });

  if (focusId === 'search-input' || focusId === 'url-input') {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { el.setSelectionRange(selStart, selEnd); } catch {}
    }
  }
}
