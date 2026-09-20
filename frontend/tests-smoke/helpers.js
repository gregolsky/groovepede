// Shared helpers for the production smoke suite.
// Keep these dependency-free of the app's own ESM modules: src/js/config.js
// reads `import.meta.env.VITE_GP_PRIVATE_KEY`, which throws under plain Node
// (Playwright's config/test files aren't run through Vite), so storage keys
// below are copied literals — see src/js/config.js for the source of truth.
import { WIDE_TAG_ALBUMS } from '../tests-lib/albums.js';

// Re-exported so viewport.spec.js keeps importing it from here.
export { overflowReport } from '../tests-lib/dom.js';

const STORAGE_KEY = 'gp_albums';
const DONE_KEY = 'gp_done';

// A resolver origin distinct from the app origin — errors/4xx here matter
// just as much as app-origin ones (it's the signal for signing-key drift or
// a dead Pi), everything else (Last.fm, cover art CDNs, Spotify) is ignored
// so third-party flakiness never reddens a deploy.
const RESOLVER_ORIGIN = 'https://api.groovepede.gregolsky.pl';

/**
 * Watches a page for the failure signals this suite cares about and returns
 * a live array of human-readable strings. Call once per test, right after
 * the page is created, then assert `expect(errors).toEqual([])`.
 *
 * Deliberately ignored:
 *  - console.warn (the known "Manifest: Enctype…" warning on every load)
 *  - 4xx/5xx from any origin other than the app itself or the resolver
 */
export function watchForErrors(page, baseURL) {
  const errors = [];
  const appOrigin = new URL(baseURL).origin;

  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  page.on('response', (res) => {
    if (res.status() < 400) return;
    let origin;
    try { origin = new URL(res.url()).origin; } catch { return; }
    if (origin !== appOrigin && origin !== RESOLVER_ORIGIN) return;
    errors.push(`http ${res.status()}: ${res.request().method()} ${res.url()}`);
  });

  return errors;
}

/**
 * Seeds localStorage with WIDE_TAG_ALBUMS before the app boots, so the test
 * lands on the populated view (not the empty-queue landing) with zero API
 * calls — tags are pre-populated so enrichWithLastfm() never fires.
 * Must be called before page.goto().
 */
export async function seedAlbums(page, { done = 2 } = {}) {
  await page.addInitScript(
    ({ albums, storageKey, doneKey, done }) => {
      localStorage.setItem(storageKey, JSON.stringify(albums));
      localStorage.setItem(doneKey, String(done));
    },
    { albums: WIDE_TAG_ALBUMS, storageKey: STORAGE_KEY, doneKey: DONE_KEY, done }
  );
}
