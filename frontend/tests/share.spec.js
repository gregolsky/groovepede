import { test, expect } from '@playwright/test';
import { stubExternals, KEYS } from './helpers.js';

const ALBUM_ID    = 'shareTestAlbum1xxxxxx'; // 22 chars for Spotify ID
const SHARE_URL   = `https://open.spotify.com/album/${ALBUM_ID}`;
const RECORD_ID   = `spotify:${ALBUM_ID}`;

function makeShareAlbumResponse() {
  return {
    id: RECORD_ID,
    service: 'spotify',
    title: 'Share Test Album',
    artist: 'Share Artist',
    cover: 'https://img/cover',
    year: null,
    tags: [],
    links: {
      spotify: { url: SHARE_URL, nativeUri: `spotify:album:${ALBUM_ID}` },
    },
  };
}

function fakeStandalone(context) {
  return context.addInitScript(() => {
    const orig = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(display-mode: standalone)') {
        return { matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} };
      }
      return orig(query);
    };
  });
}

// This spec's resolver fixture is its own (a distinct album id, so the share
// target's dedupe path is exercised), but every other external comes from the
// shared list.
async function stubApis(context) {
  await stubExternals(context, { resolver: makeShareAlbumResponse() });
}

/** Hold the resolver open so the loading phase can be observed. */
async function slowResolver(context, ms = 1500) {
  await context.route('**/api.groovepede.gregolsky.pl/**', async route => {
    await new Promise(r => setTimeout(r, ms));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeShareAlbumResponse()) });
  });
}

// ── The loading phase — the reason this overlay exists ─────────────────────────

test('share-target shows the adding overlay before the album resolves', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await slowResolver(context);   // registered last, so it wins over stubApis

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  // Feedback must appear while the resolver is still thinking — not after.
  const overlay = page.locator('#share-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });
  await expect(overlay).toHaveClass(/share-overlay--adding/);
  await expect(overlay.locator('.share-overlay__title')).toHaveText('Adding to your queue…');
  await expect(overlay.locator('.share-overlay__sub')).toHaveText('from Spotify');
  await expect(overlay.locator('.share-progress')).toBeVisible();
  await expect(overlay.locator('.share-art-cover')).toHaveCount(0);

  // …and then becomes the confirmation in place.
  await expect(overlay).toHaveClass(/share-overlay--added/, { timeout: 6000 });
  await expect(overlay.locator('.share-art-cover')).toBeVisible();
});

// ── Share in standalone (PWA) mode shows overlay ───────────────────────────────

test('share-target shows confirmation overlay in standalone mode', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#share-overlay .share-overlay__title')).toHaveText('Share Test Album');
  await expect(page.locator('#share-overlay .share-overlay__sub')).toHaveText('Share Artist');
  await expect(page.locator('#share-overlay .share-overlay__label')).toHaveText('Added to queue!');
});

test('share-target overlay disappears and card is highlighted when window.close() does not close', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.addInitScript(() => { window.close = () => {}; });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#share-overlay')).not.toBeAttached({ timeout: 3000 });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toBeVisible({ timeout: 1000 });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Share via browser tab (not standalone): same overlay, no window.close ──────

test('share-target in browser tab resolves the overlay and highlights the card', async ({ page, context }) => {
  await stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  // The dead time is identical in a tab, so the overlay runs there too — it just
  // fades out into the queue instead of closing the window.
  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#share-overlay')).not.toBeAttached({ timeout: 3000 });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toBeVisible({ timeout: 6000 });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Non-success outcomes are no longer silent ─────────────────────────────────

test('sharing an album that is already queued says so', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.addInitScript(({ keys, url, id }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([{
      id, title: 'Share Test Album', artist: 'Share Artist', sourceUrl: url,
      cover: 'https://img/cover', year: '2024', tags: [], addedAt: new Date().toISOString(),
      links: { spotify: { url, nativeUri: null } },
    }]));
  }, { keys: KEYS, url: SHARE_URL, id: RECORD_ID });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-overlay .share-overlay__label')).toHaveText('Already in your queue!', { timeout: 6000 });
});

test('sharing an unresolvable link explains the failure instead of doing nothing', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.route('**/api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--error/, { timeout: 6000 });
  await expect(overlay.locator('.share-overlay__title')).toHaveText(/Couldn’t add that link/);
  await expect(overlay.locator('.share-overlay__label')).toHaveText('Tap to dismiss!');
  // Tapping dismisses it, revealing the add form with the same message.
  await overlay.click();
  await expect(overlay).not.toBeAttached();
  await expect(page.locator('.add-error')).toBeVisible();
});

test('sharing while the resolver is down still confirms the link was saved', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.addInitScript(() => { window.close = () => {}; });
  // 503 is retryable, so a stub is saved and retried later — the share is not lost,
  // and the overlay has to say so rather than looking like a failure.
  await context.route('**/api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--pending/, { timeout: 10000 });
  await expect(overlay.locator('.share-overlay__title')).toHaveText('Got it — saved!');
  await expect(overlay.locator('.share-overlay__label')).toHaveText('Fetching details…');
});

test('a shared link that is not an album is rejected on the overlay', async ({ page, context }) => {
  await stubApis(context);
  await fakeStandalone(context);

  await page.goto(`/?url=${encodeURIComponent('https://open.spotify.com/track/abc123')}`);

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--error/, { timeout: 6000 });
  await expect(overlay.locator('.share-overlay__sub')).toContainText('track');
});
