import { test, expect } from '@playwright/test';
import { stubExternals, fakeStandalone, gatedResolver, KEYS } from './helpers.js';

const ALBUM_ID    = 'shareTestAlbum1xxxxxx'; // 22 chars for Spotify ID
const SHARE_URL   = `https://open.spotify.com/album/${ALBUM_ID}`;
const RECORD_ID   = `spotify:${ALBUM_ID}`;

// Cap for assertions about where the overlay ends up (visible, a phase's
// label, gone). They retry until they pass, so a generous cap never slows a
// passing run. It only stops a slow run from failing: under the full suite the
// Vite dev server starves the page's timers, and the overlay's 1.05s dismissal
// was measured landing 4-6s after the share, past the 1-6s caps these used to
// have. The requirement being tested is that each state is eventually reached,
// not how fast.
const SETTLE_MS = 15_000;

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

// This spec's resolver fixture is its own (a distinct album id, so the share
// target's dedupe path is exercised), but every other external comes from the
// shared list.
async function stubApis(context) {
  await stubExternals(context, { resolver: makeShareAlbumResponse() });
}

/**
 * The overlay's text at the moment it reaches `phase`, read in one page-side
 * check. The terminal phases (added/exists/pending) auto-dismiss after ~1s, so
 * a chain of separate expect()s — each retrying on its own — can outlast the
 * phase and find the overlay already gone. Reading everything in the same
 * tick the phase appears can't.
 */
async function overlayAt(page, phase) {
  const handle = await page.waitForFunction(p => {
    const o = document.querySelector(`#share-overlay.share-overlay--${p}`);
    const text = sel => o.querySelector(sel)?.textContent.trim() ?? null;
    return o && {
      title: text('.share-overlay__title'),
      sub:   text('.share-overlay__sub'),
      label: text('.share-overlay__label'),
      hasCover: !!o.querySelector('.share-art-cover'),
    };
  }, phase, { timeout: SETTLE_MS, polling: 100 });
  return handle.jsonValue();
}

// ── The loading phase — the reason this overlay exists ─────────────────────────

test('share-target shows the adding overlay before the album resolves', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  const release = await gatedResolver(context, makeShareAlbumResponse());   // registered last, so it wins over stubApis

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  // Feedback must appear while the resolver is still thinking — not after.
  const overlay = page.locator('#share-overlay');
  await expect(overlay).toBeVisible({ timeout: SETTLE_MS });
  await expect(overlay).toHaveClass(/share-overlay--adding/);
  await expect(overlay.locator('.share-overlay__title')).toHaveText('Adding to your queue…');
  await expect(overlay.locator('.share-overlay__sub')).toHaveText('from Spotify');
  await expect(overlay.locator('.share-progress')).toBeVisible();
  await expect(overlay.locator('.share-art-cover')).toHaveCount(0);

  // …and then becomes the confirmation in place, once the resolver answers.
  release();
  expect((await overlayAt(page, 'added')).hasCover).toBe(true);
});

// ── Share in standalone (PWA) mode shows overlay ───────────────────────────────

test('share-target shows confirmation overlay in standalone mode', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  expect(await overlayAt(page, 'added')).toMatchObject({
    title: 'Share Test Album', sub: 'Share Artist', label: 'Added to queue!',
  });
});

test('share-target overlay disappears and card is highlighted when window.close() does not close', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.addInitScript(() => { window.close = () => {}; });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.locator('#share-overlay')).not.toBeAttached({ timeout: SETTLE_MS });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Share via browser tab (not standalone): same overlay, no window.close ──────

test('share-target in browser tab resolves the overlay and highlights the card', async ({ page, context }) => {
  await stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  // The dead time is identical in a tab, so the overlay runs there too — it just
  // fades out into the queue instead of closing the window.
  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.locator('#share-overlay')).not.toBeAttached({ timeout: SETTLE_MS });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Link embedded in the shared text (not a bare `url` param) ──────────────────
// Spotify's mobile "Share" sheet fills Web Share's `text` field with
// "<Title> by <Artist> <url>" rather than putting a bare link in `url` — see
// storage.js's parseMusicLink and app.js's boot().

test('sharing "<title> by <artist> <url>" in the text field still resolves and queues the album', async ({ page, context }) => {
  await stubApis(context);
  const shareText = `Share Test Album by Share Artist ${SHARE_URL}`;

  await page.goto(`/?text=${encodeURIComponent(shareText)}`, { waitUntil: 'commit' });

  await expect(page.locator('#share-overlay')).toBeVisible({ timeout: SETTLE_MS });
  await expect(page.locator('#share-overlay')).not.toBeAttached({ timeout: SETTLE_MS });
  await expect(page.locator(`[id="card-${RECORD_ID}"]`)).toBeVisible({ timeout: SETTLE_MS });
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

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  await expect(page.locator('#share-overlay .share-overlay__label')).toHaveText('Already in your queue!', { timeout: SETTLE_MS });
});

test('sharing an album already queued under a different link says so (dedupe by resolved id)', async ({ page, context }) => {
  // Short links (spotify.link, open.spotify.com/s/…) and ?si= tracking make
  // every share's URL unique, so the sourceUrl check can't catch a repeat —
  // the resolved album id has to.
  await fakeStandalone(context);
  await stubApis(context);
  await context.addInitScript(({ keys, id }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([{
      id, title: 'Share Test Album', artist: 'Share Artist',
      sourceUrl: 'https://open.spotify.com/s/someOtherShareCode',
      cover: 'https://img/cover', year: '2024', tags: [], addedAt: new Date().toISOString(),
      links: { spotify: { url: 'https://open.spotify.com/album/x', nativeUri: null } },
    }]));
  }, { keys: KEYS, id: RECORD_ID });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  await expect(page.locator('#share-overlay .share-overlay__label')).toHaveText('Already in your queue!', { timeout: SETTLE_MS });
  await expect(page.locator('.card')).toHaveCount(1);
});

test('sharing an unresolvable link explains the failure instead of doing nothing', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubApis(context);
  await context.route('**/api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--error/, { timeout: SETTLE_MS });
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

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`, { waitUntil: 'commit' });

  expect(await overlayAt(page, 'pending')).toMatchObject({
    title: 'Got it — saved!', label: 'Fetching details…',
  });
});

test('a shared link that is not an album is rejected on the overlay', async ({ page, context }) => {
  await stubApis(context);
  await fakeStandalone(context);

  await page.goto(`/?url=${encodeURIComponent('https://open.spotify.com/track/abc123')}`, { waitUntil: 'commit' });

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--error/, { timeout: SETTLE_MS });
  await expect(overlay.locator('.share-overlay__sub')).toContainText('track');
});
