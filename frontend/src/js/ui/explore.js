/** The explore view: open/close, swipe/arrow navigation, Done, tracklist retry, refresh. */
import { markListened, refreshAlbum } from '../services/queue.js';
import { loadAlbumDetails, retryTracklist, forgetAlbumDetails } from '../services/album-details.js';
import { ui, setUi, rerender, visibleAlbums, rerenderIfExploring } from './state.js';

let animating = false;

/** True mid slide-transition — navigation and Escape wait it out. */
export const isAnimating = () => animating;

/**
 * Show the album at a visible index, starting its details load BEFORE the
 * render: the load marks a Deezer-less album's tracklist empty synchronously,
 * and rendering first showed "Loading tracks…" with nothing left to replace it.
 */
function showExplore(index) {
  const album = visibleAlbums()[index];
  if (album) loadAlbumDetails(album, rerenderIfExploring);
  setUi({ exploreIndex: index });
}

export function openExplore(index) {
  window.history.pushState({ explore: true }, '');
  showExplore(index);
}

export function closeExplore() {
  setUi({ exploreIndex: null });
}

export function navigateExplore(dir) {
  if (animating) return;
  const next = ui.exploreIndex + dir;
  if (next < 0 || next >= visibleAlbums().length) return;

  animating = true;
  const outClass = dir > 0 ? 'explore--slide-out-left' : 'explore--slide-out-right';
  const inClass  = dir > 0 ? 'explore--slide-in-right' : 'explore--slide-in-left';
  document.querySelector('#app .explore')?.classList.add(outClass);

  setTimeout(() => {
    showExplore(next);
    const inEl = document.querySelector('#app .explore');
    if (!inEl) { animating = false; return; }
    inEl.classList.add(inClass);
    setTimeout(() => { inEl.classList.remove(inClass); animating = false; }, 200);
  }, 150);
}

/**
 * Mark the album at a visible index as listened. Flashes the card first when it
 * is on screen, so the removal has a beat of feedback.
 *
 * `explore` selects which card wraps the button and, after removal, keeps the
 * explore view open on the album that slid into this slot (or closes it when
 * the queue is empty). The list-view path just rerenders.
 */
export function markDone(index, triggerEl, { explore = false } = {}) {
  const album = visibleAlbums()[index];
  if (!album) return;
  const action = explore ? 'explore-done' : 'done';
  const btn    = triggerEl || document.querySelector(`#app [data-action="${action}"][data-index="${index}"]`);
  const card   = btn?.closest(explore ? '.explore-album' : '.card');
  if (!card) return applyDone(index, album, explore);
  card.classList.add('done-flash');
  setTimeout(() => applyDone(index, album, explore), 550);
}

function applyDone(index, album, explore) {
  if (!markListened(album.id)) return;
  if (!explore) return rerender();
  const left = visibleAlbums().length;
  if (left === 0) setUi({ exploreIndex: null });
  else showExplore(Math.min(index, left - 1));
}

/** Explicit retry for a failed tracklist fetch — the error state offers it, so
 * navigating away and back isn't the only way to recover. */
export function retryTracks(index) {
  const album = visibleAlbums()[index];
  if (album) retryTracklist(album, rerenderIfExploring);
}

/** "Refresh details" — only ever rendered inside the explore card, so it's
 * always for the album on screen. */
export async function refreshDetails(index) {
  const album = visibleAlbums()[index];
  if (!album?.sourceUrl) return;
  setUi({ refreshingId: album.id });
  try {
    const merged = await refreshAlbum(album, rerender);
    if (merged) {
      forgetAlbumDetails(album);
      loadAlbumDetails(merged, rerenderIfExploring);
    }
  } finally {
    setUi({ refreshingId: null });
  }
}
