/**
 * The profile screen: preferred service, backup export/import, and the
 * pending-resolution progress bar + import summary an import ends with.
 */
import { loadAlbums, setPreferredService } from '../infra/storage.js';
import { reportFailure } from '../infra/beacon.js';
import { parseBackup } from '../domain/backup.js';
import { exportBackup, replaceQueue } from '../services/queue.js';
import { resolvePending, hasPendingAlbums } from '../services/pending.js';
import { enrichWithLastfm } from '../services/enrich.js';
import { ui, setUi, rerender } from './state.js';

export function openProfile() {
  window.history.pushState({ profile: true }, '');
  setUi({ profileOpen: true });
}

export function closeProfile() {
  setUi({ profileOpen: false });
}

export function setPrefService(slug) {
  setPreferredService(slug);
  rerender();
}

export function downloadBackup() {
  const { filename, text } = exportBackup();
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function pickBackupFile() {
  document.getElementById('profile-import-input')?.click();
}

export function readBackupFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload  = evt => importBackupText(evt.target.result);
  reader.onerror = () => {
    alert('Couldn’t read that file — try exporting the backup again.');
    reportFailure('import-read-failed', { msg: reader.error?.name || 'unknown' });
  };
  reader.readAsText(file);
}

function importBackupText(text) {
  let parsed;
  try {
    parsed = parseBackup(text);
  } catch {
    alert('Invalid backup file — make sure it was exported from Groovepede.');
    return;
  }
  const current = loadAlbums().length;
  if (current > 0 && !confirm(`Replace your ${current} album${current !== 1 ? 's' : ''} with ${parsed.albums.length} from the file?`)) {
    return;
  }
  replaceQueue(parsed);
  // Close profile and land on the populated queue immediately
  setUi({ profileOpen: false, exploreIndex: null });
  // Resolve all pending stubs fresh (throttled, with progress bar + summary on drain)
  resolvePendingAlbums({ summarize: true });
}

export function closeImportSummary() {
  setUi({ importSummary: null });
}

export function copyFailedLinks() {
  const failed = ui.importSummary?.failed;
  if (failed?.length) navigator.clipboard?.writeText(failed.join('\n'));
}

/** Resolve pending stubs (see pending.js), driving the progress bar; with
 * `summarize`, show the import summary once the run drains. */
export async function resolvePendingAlbums({ summarize = false } = {}) {
  const result = await resolvePending({
    onProgress: importProgress => setUi({ importProgress }),
    onAdded:    rec => enrichWithLastfm(rec.id, rec.artist, rec.title, rerender),
  });
  if (result && summarize) setUi({ importSummary: result });
}

/** Mobile browsers suspend JS timers when the app is backgrounded. Resume any
 * in-progress import when the user returns, so cards keep populating. */
export function resumePendingIfAny() {
  if (hasPendingAlbums()) resolvePendingAlbums();
}
