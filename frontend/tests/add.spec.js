import { test, expect } from '@playwright/test';
import { stubExternals, SPOTIFY_URL } from './helpers.js';

async function openAddReveal(page) {
  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();
}

// ── Successful add (no Spotify auth required) ─────────────────────────────────

test('adds album from Spotify URL without being logged in', async ({ page, context }) => {
  await stubExternals(context);

  await page.goto('/');
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  await openAddReveal(page);
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.card .card-title')).toContainText('Test Album');
});

// ── Resolver error paths ───────────────────────────────────────────────────────
// The add flow falls through to MusicBrainz on any resolver error (see
// resolveAlbumResilient in api.js) — but stubExternals' default MusicBrainz
// stub also 404s ("no match"), so both cases below still end up with the
// resolver's own error, same as before that fallback existed.

test('resolver 404 shows error and does not add card', async ({ page, context }) => {
  await stubExternals(context, { resolver: 404 });

  await page.goto('/');
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  await openAddReveal(page);
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.card')).not.toBeVisible();
});

test('resolver 503 saves a pending card (retryable error)', async ({ page, context }) => {
  await stubExternals(context, { resolver: 503 });

  await page.goto('/');
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  await openAddReveal(page);
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  // A pending card should appear (not an error)
  await expect(page.locator('.card--pending')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.add-error')).not.toBeVisible();
});

// ── parseMusicLink rejection paths ────────────────────────────────────────────

test('Bandcamp URL shows rejection error', async ({ page, context }) => {
  await stubExternals(context);

  await page.goto('/');
  await openAddReveal(page);
  await page.fill('#url-input', 'https://radiohead.bandcamp.com/album/ok-computer');
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 3000 });
  await expect(err).toContainText(/bandcamp/i);
  await expect(page.locator('.card')).not.toBeVisible();
});

test('garbage input shows rejection error', async ({ page, context }) => {
  await stubExternals(context);

  await page.goto('/');
  await openAddReveal(page);
  await page.fill('#url-input', 'not a link at all');
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.card')).not.toBeVisible();
});
