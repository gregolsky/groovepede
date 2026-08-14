import { test, expect } from '@playwright/test';

// A realistic Odesli response for a Spotify album link
function makeOdesliResponse(overrides = {}) {
  const entityId = 'SPOTIFY_ALBUM::abc123def456ghi789jklm';
  return {
    entityUniqueId: entityId,
    userCountry: 'US',
    pageUrl: 'https://song.link/s/abc123def456ghi789jklm',
    entitiesByUniqueId: {
      [entityId]: {
        id: 'abc123def456ghi789jklm',
        type: 'album',
        title: 'Test Album',
        artistName: 'Test Artist',
        thumbnailUrl: 'https://example.com/cover.jpg',
        apiProvider: 'spotify',
        platforms: ['spotify'],
      },
    },
    linksByPlatform: {
      spotify: {
        url: 'https://open.spotify.com/album/abc123def456ghi789jklm',
        nativeAppUriMobile: 'spotify:album:abc123def456ghi789jklm',
        entityUniqueId: entityId,
      },
    },
    ...overrides,
  };
}

async function stubOdesliSuccess(context) {
  await context.route('https://api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeOdesliResponse()),
    })
  );
}

async function stubLastfm(context) {
  await context.route('https://www.theaudiodb.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"artists":null}' })
  );

  await context.route('https://ws.audioscrobbler.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

async function openAddReveal(page) {
  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();
}

const SPOTIFY_URL = 'https://open.spotify.com/album/abc123def456ghi789jklm';

// ── Successful add (no Spotify auth required) ─────────────────────────────────

test('adds album from Spotify URL without being logged in', async ({ page, context }) => {
  await stubOdesliSuccess(context);
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  await openAddReveal(page);
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.card .card-title')).toContainText('Test Album');
});

// ── Odesli error paths ────────────────────────────────────────────────────────

test('Odesli 404 shows error and does not add card', async ({ page, context }) => {
  await context.route('https://api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  );
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  await openAddReveal(page);
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.card')).not.toBeVisible();
});

test('Odesli 503 saves a pending card (retryable error)', async ({ page, context }) => {
  await context.route('https://api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  );
  await stubLastfm(context);

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
  await stubLastfm(context);

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
  await stubLastfm(context);

  await page.goto('/');
  await openAddReveal(page);
  await page.fill('#url-input', 'not a link at all');
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.card')).not.toBeVisible();
});
