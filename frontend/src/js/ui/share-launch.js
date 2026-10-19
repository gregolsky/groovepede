/**
 * A launch from the OS share sheet (the PWA's share target): parse the shared
 * text, add the album, and walk the overlay through its phases —
 *
 *   adding ──▶ added | exists | pending ──▶ close the window, or highlight the card
 *         └──▶ error ───────────────────▶ tap/timeout dismisses, add form shows why
 */
import { parseMusicLink } from '../domain/links.js';
import { reportFailure } from '../infra/beacon.js';
import { addAlbumFromUrl, findBySourceUrl } from '../services/queue.js';
import { showShareOverlay, setSharePhase, dismissShareError, finishShareOverlay } from './share-overlay.js';
import { RESOLVE_FAILED_MSG } from './add-form.js';
import { ui, setUi, rerender } from './state.js';

/**
 * The terminal phase an add lands the overlay on, the card to highlight, and
 * the album to show. `existing` is the album already saved from this exact
 * link, if any; `outcome` is addAlbumFromUrl's, when it had to run.
 */
export function shareLanding({ existing, outcome }) {
  if (existing) {
    const pending = !!existing._pending;
    return { phase: pending ? 'pending' : 'exists', highlightId: existing.id, album: pending ? null : existing };
  }
  if (outcome.kind === 'failed') return { phase: 'error', highlightId: null, album: null };
  // 'added' | 'exists' | 'pending' — a pending stub has no cover/title yet, and the overlay says so.
  return { phase: outcome.kind, highlightId: outcome.album.id, album: outcome.kind === 'pending' ? null : outcome.album };
}

/** The share's query params have done their job; drop them so a reload doesn't re-add. */
function clearShareParams() {
  window.history.replaceState({}, document.title, window.location.pathname);
}

/**
 * Call before ANY await: a share launch must show feedback in its first frame,
 * otherwise the app looks like it dropped the link (parseMusicLink needs no
 * network, so the source service is already known). Returns null when this
 * isn't a share launch, else `{ complete }` to run the add once the app is up.
 */
export function beginShareLaunch(search) {
  const params = new URLSearchParams(search);
  // Which field carries the link is up to the sharing app — e.g. Spotify's
  // mobile "Share" sheet puts "<Title> by <Artist> <url>" in `text` rather
  // than a bare URL in `url`. parseMusicLink scans the whole string for an
  // embedded link, so joining every field finds it wherever the sender put it.
  const shared = [params.get('text'), params.get('url'), params.get('title')].filter(Boolean).join(' ');
  if (!shared.trim()) return null;

  const { url, service, error } = parseMusicLink(shared);
  showShareOverlay('adding', { service });
  if (error) {
    // Only the sanitized, static error string is reported — never the shared
    // text itself, which can carry the album/artist name the user shared.
    reportFailure('add-failed', { route: 'share-parse', msg: error });
  }

  return {
    async complete() {
      if (error) {
        clearShareParams();
        setUi({ addError: error, addOpen: true });
        await setSharePhase('error', { service, message: error });
        dismissShareError();
        return;
      }
      const isShareLaunch = window.matchMedia('(display-mode: standalone)').matches;
      // Short links make every share's URL unique, so this rarely catches a
      // repeat — addAlbumFromUrl's id dedupe does.
      const existing = findBySourceUrl(url);
      const outcome  = existing ? null : await addAlbumFromUrl(url, service, 'share-resolve', rerender);
      const { phase, highlightId, album } = shareLanding({ existing, outcome });

      clearShareParams();
      // A failure is surfaced in the add form too, not just on the overlay.
      if (phase === 'error') setUi({ addError: RESOLVE_FAILED_MSG, addOpen: true });
      else rerender();

      await setSharePhase(phase, { service, album, message: ui.addError });
      if (phase === 'error') dismissShareError();
      else finishShareOverlay(highlightId, isShareLaunch);
    },
  };
}
