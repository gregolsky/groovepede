// Shared helpers for the production smoke suite.
// Keep these dependency-free of the app's own ESM modules: src/js/config.js
// reads `import.meta.env.VITE_GP_PRIVATE_KEY`, which throws under plain Node
// (Playwright's config/test files aren't run through Vite), so storage keys
// below are copied literals — see src/js/config.js for the source of truth.
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
 * Reports horizontal overflow at the current viewport. `wide` names the
 * offending elements (tag.class@rightEdge) so a failure points at the
 * culprit instead of just a number mismatch.
 */
export async function overflowReport(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth + 1;
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > limit)
      .slice(0, 15)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
        return `${el.tagName.toLowerCase()}.${cls.trim().replace(/\s+/g, '.')}@${Math.round(el.getBoundingClientRect().right)}`;
      });
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide };
  });
}

// Six synthetic, fully-resolved albums (no `_pending`, no cover images — kept
// deliberately offline, no network dependency) spanning 9 distinct tags so
// the tag bar's "More" toggle (shown once tagsByFrequency().length > 7,
// see src/js/render.js) is actually exercised.
const SAMPLE_ALBUMS = [
  { id: 'smoke::1', title: 'Song for Our Grandfathers', artist: 'Broken Social Scene', sourceUrl: 'https://open.spotify.com/album/smoke1', tags: ['indie rock', 'post-rock'], links: { spotify: { url: 'https://open.spotify.com/album/smoke1' } } },
  { id: 'smoke::2', title: 'Selected Ambient Works 85-92', artist: 'Aphex Twin', sourceUrl: 'https://open.spotify.com/album/smoke2', tags: ['ambient', 'electronic'], links: { spotify: { url: 'https://open.spotify.com/album/smoke2' } } },
  { id: 'smoke::3', title: 'Damn', artist: 'Kendrick Lamar', sourceUrl: 'https://open.spotify.com/album/smoke3', tags: ['hip hop', 'rap'], links: { spotify: { url: 'https://open.spotify.com/album/smoke3' } } },
  { id: 'smoke::4', title: 'In Rainbows', artist: 'Radiohead', sourceUrl: 'https://open.spotify.com/album/smoke4', tags: ['art rock', 'experimental'], links: { spotify: { url: 'https://open.spotify.com/album/smoke4' } } },
  { id: 'smoke::5', title: 'Blue Train', artist: 'John Coltrane', sourceUrl: 'https://open.spotify.com/album/smoke5', tags: ['jazz', 'hard bop'], links: { spotify: { url: 'https://open.spotify.com/album/smoke5' } } },
  { id: 'smoke::6', title: 'Rumours', artist: 'Fleetwood Mac', sourceUrl: 'https://open.spotify.com/album/smoke6', tags: ['classic rock'], links: { spotify: { url: 'https://open.spotify.com/album/smoke6' } } },
];

/**
 * Seeds localStorage with SAMPLE_ALBUMS before the app boots, so the test
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
    { albums: SAMPLE_ALBUMS, storageKey: STORAGE_KEY, doneKey: DONE_KEY, done }
  );
}
