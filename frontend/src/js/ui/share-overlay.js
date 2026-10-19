/**
 * The overlay a share-target launch shows while the shared link resolves.
 * Owns its own element (outside #app, so rerenders never touch it); its
 * markup comes from renderShareOverlay in render.js.
 *
 * Launching from a share used to show nothing at all until the album resolved,
 * so the app sat there looking ignored for the whole resolver round trip. The
 * overlay now goes up BEFORE the first await and morphs into the confirmation,
 * instead of only existing at the end of the flow.
 */
import { renderShareOverlay } from './render.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let _shareEl      = null;
let _shareShownAt = 0;

// Don't flash: once the overlay is up it stays for at least this long before a
// terminal phase replaces it, even if the resolver answered instantly.
const SHARE_MIN_MS = 500;

export function showShareOverlay(phase, data = {}) {
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
  _shareEl.innerHTML = String(renderShareOverlay({ phase, ...data }));
}

/** Apply a terminal phase, honouring the minimum visible time. */
export async function setSharePhase(phase, data = {}) {
  if (!_shareEl) return;
  const elapsed = Date.now() - _shareShownAt;
  if (elapsed < SHARE_MIN_MS) await sleep(SHARE_MIN_MS - elapsed);
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
 * The error phase is the one the user has to read, so it neither auto-closes
 * fast nor blocks: a tap dismisses it, otherwise it fades after a few seconds,
 * revealing the add form with the same message already in it.
 */
export function dismissShareError() {
  const el = _shareEl;
  if (!el) return;
  const close = () => { if (_shareEl === el) hideShareOverlay(); };
  el.addEventListener('click', close);
  setTimeout(close, 3200);
}

/**
 * Close out a successful share: hold the confirmation briefly, close the window
 * when this was a share launch (the user is expecting to land back where they
 * came from), and otherwise fall back to highlighting the card in place.
 */
export function finishShareOverlay(highlightId, isShareLaunch) {
  if (isShareLaunch) setTimeout(() => window.close(), 900);
  setTimeout(() => {
    if (!_shareEl) return;
    hideShareOverlay();
    highlightCard(highlightId);
  }, 1050);
}
