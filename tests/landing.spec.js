import { test, expect } from '@playwright/test';

const KEYS = { TOKEN: 'gp_token', EXPIRY: 'gp_expiry', ALBUMS: 'gp_albums' };

function stubOdesli(context) {
  const entityId = 'SPOTIFY_ALBUM::abc123def456ghi789jklm';
  return context.route('https://api.song.link/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entityUniqueId: entityId,
        userCountry: 'US',
        entitiesByUniqueId: {
          [entityId]: { id: 'abc123def456ghi789jklm', type: 'album', title: 'Hero Test Album',
            artistName: 'Hero Artist', thumbnailUrl: 'https://img/cover',
            apiProvider: 'spotify', platforms: ['spotify'] },
        },
        linksByPlatform: {
          spotify: { url: 'https://open.spotify.com/album/abc123def456ghi789jklm',
            nativeAppUriMobile: 'spotify:album:abc123def456ghi789jklm', entityUniqueId: entityId },
        },
      }),
    })
  );
}

function stubLastfm(context) {
  return context.route('https://ws.audioscrobbler.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

const SPOTIFY_URL = 'https://open.spotify.com/album/abc123def456ghi789jklm';

// ── Hero shown on empty queue ─────────────────────────────────────────────────

test('empty queue shows hero with bg.jpg landing, not a login wall', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');

  // Hero block present
  await expect(page.locator('.landing')).toBeVisible();
  await expect(page.locator('.landing-headline')).toContainText('Never lose a great album');

  // At least one feature card
  await expect(page.locator('.landing-feature')).toHaveCount(3);

  // App is NOT blocked — add CTA is available without login
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  // Spotify connect is secondary, not the primary CTA
  // (primary is toggle-add, not a hard login wall)
  await expect(page.locator('.landing [data-action="login"]')).toBeVisible();
  await expect(page.locator('.landing-cta')).toBeVisible();
  // landing-cta is the add button, not login
  await expect(page.locator('.landing-cta[data-action="toggle-add"]')).toBeVisible();
});

test('hero collapses to populated app once an album is added', async ({ page, context }) => {
  await stubOdesli(context);
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();

  // Add an album via the hero CTA
  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();
  await page.fill('#url-input', SPOTIFY_URL);
  await page.click('[data-action="add"]');

  // Hero gone, populated app shown
  await expect(page.locator('.landing')).not.toBeAttached({ timeout: 5000 });
  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.stats')).toBeVisible();
});

test('hero returns when all albums are deleted', async ({ page, context }) => {
  const album = {
    id: 'SPOTIFY_ALBUM::del1', title: 'Goodbye Album', artist: 'Test',
    sourceUrl: 'https://open.spotify.com/album/del1',
    links: { spotify: { url: 'https://open.spotify.com/album/del1' } },
    cover: null, year: '2020', tags: [], addedAt: new Date().toISOString(),
  };
  await context.addInitScript(({ keys, al }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([al]));
  }, { keys: KEYS, al: album });
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible(); // populated app

  // Mark done to delete the album
  await page.click('[data-action="done"][data-index="0"]');

  // Hero reappears
  await expect(page.locator('.landing')).toBeVisible({ timeout: 3000 });
});

test('reloading with albums in storage goes straight to populated app (no hero)', async ({ page, context }) => {
  const album = {
    id: 'SPOTIFY_ALBUM::alb1', title: 'Existing Album', artist: 'Artist',
    sourceUrl: 'https://open.spotify.com/album/alb1',
    links: { spotify: { url: 'https://open.spotify.com/album/alb1' } },
    cover: null, year: '2021', tags: [], addedAt: new Date().toISOString(),
  };
  await context.addInitScript(({ keys, al }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([al]));
  }, { keys: KEYS, al: album });
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.landing')).not.toBeAttached();
});

// ── Import reachable from hero (logged-out bug regression) ───────────────────

test('logged-out user can open profile from hero and access Import', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();

  // Profile is reachable from the auth area even when logged out
  await page.click('[data-action="open-profile"]');
  await expect(page.locator('.profile')).toBeVisible();
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();
  await expect(page.locator('[data-action="export-data"]')).toBeVisible();
});

test('Import a backup link in hero opens the profile overlay', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');
  await expect(page.locator('.landing-import-link')).toBeVisible();

  await page.click('.landing-import-link');
  await expect(page.locator('.profile')).toBeVisible();
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();
});

test('importing a JSON backup from the hero populates the queue', async ({ page, context }) => {
  await stubLastfm(context);
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    albums: [{
      id: 'SPOTIFY_ALBUM::imported1',
      title: 'Imported Album',
      artist: 'Imported Artist',
      sourceUrl: 'https://open.spotify.com/album/imported1',
      links: { spotify: { url: 'https://open.spotify.com/album/imported1' } },
      cover: null, year: '2023', tags: [], addedAt: new Date().toISOString(),
    }],
    done: 0,
  };

  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();

  // Open profile via auth-area button
  await page.click('[data-action="open-profile"]');
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();

  // Upload the backup file
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('[data-action="import-data"]'),
  ]);
  await fileChooser.setFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  // Close profile to return to the main app view
  await page.click('[data-action="close-profile"]');

  // Queue populated, hero gone
  await expect(page.locator('.card-title')).toContainText('Imported Album', { timeout: 5000 });
  await expect(page.locator('.landing')).not.toBeAttached();
});
