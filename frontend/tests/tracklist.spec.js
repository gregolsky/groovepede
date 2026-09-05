import { test, expect } from '@playwright/test';
import { stubExternals, seedAlbums } from './helpers.js';

// An already-resolved album with a Deezer cross-link, so deezerAlbumId()
// (frontend/src/js/api.js) finds an id and prefetchExplore actually calls
// fetchAlbumTracks instead of short-circuiting to an empty tracklist.
const ALBUM_WITH_DEEZER_LINK = {
  id: 'spotify:4aawyAB9vmqN3uQ7FjRGTy',
  title: 'OK Computer',
  artist: 'Radiohead',
  cover: null,
  year: '1997',
  tags: [],
  addedAt: new Date().toISOString(),
  links: {
    spotify: { url: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy' },
    deezer:  { url: 'https://www.deezer.com/album/302127' },
  },
};

async function seedWithAlbum(context) {
  await seedAlbums(context, [ALBUM_WITH_DEEZER_LINK]);
  // No /v1/album call expected — the album above is already fully resolved.
  await stubExternals(context, { resolver: null });
}

test('a resolved tracklist replaces "Loading tracks…" with the track list', async ({ page, context }) => {
  await seedWithAlbum(context);
  await context.route('**/v1/tracks**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ tracks: [
      { number: 1, name: 'Airbag', duration_ms: 284000 },
      { number: 2, name: 'Paranoid Android', duration_ms: 383000 },
    ] }),
  }));

  await page.goto('/');
  await page.locator('.card').first().click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.explore')).toBeVisible();

  await expect(page.locator('.explore-tracklist')).toBeVisible();
  await expect(page.locator('.explore-track')).toHaveCount(2);
  await expect(page.locator('.explore-track-name').first()).toHaveText('Airbag');
  await expect(page.locator('.explore-loading')).toHaveCount(0);
});

test('a failed tracklist fetch shows a retry action instead of silent blank space, and retry recovers it', async ({ page, context }) => {
  await seedWithAlbum(context);
  await context.route('**/v1/tracks**', route => route.fulfill({ status: 500, body: '{"_error":500}' }));

  await page.goto('/');
  await page.locator('.card').first().click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.explore')).toBeVisible();

  // Not silent blank space, not stuck on "Loading tracks…" — an explicit
  // error state with a way out.
  await expect(page.locator('.explore-tracklist-error')).toBeVisible();
  await expect(page.locator('.explore-retry')).toBeVisible();
  await expect(page.locator('.explore-tracklist')).toHaveCount(0);

  // Now let a retry succeed.
  await context.route('**/v1/tracks**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ tracks: [{ number: 1, name: 'Airbag', duration_ms: 284000 }] }),
  }));
  await page.click('.explore-retry');

  await expect(page.locator('.explore-tracklist')).toBeVisible();
  await expect(page.locator('.explore-track-name')).toHaveText('Airbag');
  await expect(page.locator('.explore-tracklist-error')).toHaveCount(0);
});
