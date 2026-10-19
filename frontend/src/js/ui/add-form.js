/** The paste-a-link form: submit, open/close, and clearing its error as the user types. */
import { parseMusicLink } from '../domain/links.js';
import { hasExplicitPreferredService, setPreferredService } from '../infra/storage.js';
import { reportFailure } from '../infra/beacon.js';
import { addAlbumFromUrl, findBySourceUrl } from '../services/queue.js';
import { ui, setUi, rerender } from './state.js';

export const RESOLVE_FAILED_MSG = 'Couldn’t find that album — double-check the link and try again.';

const urlInput = () => document.getElementById('url-input');

export async function submitAdd() {
  const input = urlInput();
  if (!input) return;
  const { url, service, error } = parseMusicLink(input.value.trim());
  if (error !== undefined) {
    // null means empty input — nothing to say.
    if (error) {
      setUi({ addError: error });
      reportFailure('add-failed', { route: 'manual-parse', msg: error });
    }
    return;
  }

  // Fast path for re-pasting the exact same link: no resolve needed.
  if (findBySourceUrl(url)) {
    input.value = '';
    setUi({ addError: null, addOpen: false });
    return;
  }

  setUi({ addError: null, loadingAdd: true });
  const outcome = await addAlbumFromUrl(url, service, 'manual-resolve', rerender);
  if (outcome.kind === 'failed') {
    setUi({ loadingAdd: false, addError: RESOLVE_FAILED_MSG });
    return;
  }
  // Auto-set preferred service from the first link pasted (if never explicitly chosen)
  if (outcome.kind !== 'pending' && service && !hasExplicitPreferredService()) setPreferredService(service);
  setUi({ loadingAdd: false, addOpen: false });
  const inp = urlInput();
  if (inp) inp.value = '';
}

export function toggleAdd() {
  const addOpen = !ui.addOpen;
  setUi(addOpen ? { addOpen } : { addOpen, addError: null });
  if (addOpen) requestAnimationFrame(() => urlInput()?.focus());
}

export function closeAdd() {
  setUi({ addOpen: false, addError: null });
}

/** Typing into the input clears a shown error — in place, so the input keeps what's typed. */
export function dismissAddError() {
  if (!ui.addError) return;
  setUi({ addError: null }, { render: false });
  document.querySelector('#app .add-error')?.remove();
}
