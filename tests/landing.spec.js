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

  // Primary CTA is the add button, not a login wall
  await expect(page.locator('.landing-cta')).toBeVisible();
  await expect(page.locator('.landing-cta[data-action="toggle-add"]')).toBeVisible();
  // Spotify connect is NOT shown in the landing (it lives in preferences only)
  await expect(page.locator('.landing [data-action="login"]')).toHaveCount(0);
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

test('Profile icon in header opens the profile overlay with import option', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();

  await page.click('[data-action="open-profile"]');
  await expect(page.locator('.profile')).toBeVisible();
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();
});

test('importing a JSON backup from the hero populates the queue', async ({ page, context }) => {
  await stubLastfm(context);
  // Stub Odesli so resolvePending can resolve the imported pending stub
  const importEntityId = 'SPOTIFY_ALBUM::imported1xxxxxxxxxxxx';
  await context.route('https://api.song.link/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entityUniqueId: importEntityId,
        userCountry: 'US',
        entitiesByUniqueId: {
          [importEntityId]: { id: 'imported1xxxxxxxxxxxx', type: 'album', title: 'Imported Album',
            artistName: 'Imported Artist', thumbnailUrl: 'https://img/cover',
            apiProvider: 'spotify', platforms: ['spotify'] },
        },
        linksByPlatform: {
          spotify: { url: 'https://open.spotify.com/album/imported1',
            nativeAppUriMobile: 'spotify:album:imported1', entityUniqueId: importEntityId },
        },
      }),
    })
  );
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

  // Profile auto-closes after import; wait for queue to populate
  await expect(page.locator('.card-title')).toContainText('Imported Album', { timeout: 5000 });
  await expect(page.locator('.landing')).not.toBeAttached();
});

test('importing falls back to MusicBrainz when Odesli is unavailable', async ({ page, context }) => {
  await stubLastfm(context);

  // Odesli returns 503 (server error) — non-retryable, triggers immediate MB fallback.
  // 429 retry/backoff timing is covered by unit tests; E2E just validates the MB path.
  await context.route('https://api.song.link/**', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":503}' })
  );

  // MusicBrainz url-lookup returns release data
  await context.route('https://musicbrainz.org/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        resource: 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd',
        id: 'url-uuid',
        relations: [{
          'target-type': 'release',
          release: {
            id: 'ce4d1a76-7727-45d7-b61a-21a6e841e21c',
            title: 'MB Fallback Album',
            date: '2017-01-01',
            'artist-credit': [{ name: 'MB Artist' }],
          },
        }],
      }),
    })
  );

  const backup = {
    version: 3,
    exportedAt: new Date().toISOString(),
    albums: [{ sourceUrl: 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd', service: 'spotify', addedAt: new Date().toISOString() }],
    done: 0,
  };

  await page.goto('/');
  await page.click('[data-action="open-profile"]');
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('[data-action="import-data"]'),
  ]);
  await fileChooser.setFiles({
    name: 'backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  // Card title populated via MusicBrainz fallback
  await expect(page.locator('.card-title')).toContainText('MB Fallback Album', { timeout: 10000 });
});

test('unresolvable import link is dropped and shown in the summary modal', async ({ page, context }) => {
  await stubLastfm(context);

  // Odesli returns a non-retryable 404 — album not found
  await context.route('https://api.song.link/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":404}' })
  );
  // MusicBrainz also returns not-found (relations array empty)
  await context.route('https://musicbrainz.org/**', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ resource: 'https://open.spotify.com/album/notfound123', id: 'url-uuid', relations: [] }),
    })
  );

  const bogusUrl = 'https://open.spotify.com/album/notfound123';
  const backup = {
    version: 3,
    exportedAt: new Date().toISOString(),
    albums: [{ sourceUrl: bogusUrl, service: 'spotify', addedAt: new Date().toISOString() }],
    done: 0,
  };

  await page.goto('/');
  await page.click('[data-action="open-profile"]');
  await expect(page.locator('[data-action="import-data"]')).toBeVisible();

  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('[data-action="import-data"]'),
  ]);
  await fileChooser.setFiles({
    name: 'backup.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });

  // Summary modal appears with 0 added + the failed link
  await expect(page.locator('.import-summary-overlay')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.import-summary-title')).toContainText('Import complete');
  await expect(page.locator('.import-summary-added')).toContainText('0 albums added');
  await expect(page.locator('.import-summary-failed-title')).toContainText('1 link');
  await expect(page.locator('.import-summary-link')).toContainText('notfound123');

  // The stub was removed — no pending card lingers
  await expect(page.locator('.card--pending')).toHaveCount(0);

  // Dismissing the modal hides it
  await page.click('[data-action="close-import-summary"]');
  await expect(page.locator('.import-summary-overlay')).not.toBeAttached();
});

test('Listen button is disabled when album is not on preferred service', async ({ page, context }) => {
  await stubLastfm(context);

  // Seed a resolved album that only has an Apple Music link, while the
  // preferred service (default: spotify) is not present
  const album = {
    id: 'APPLE_ALBUM::apple1',
    title: 'Apple-only Album',
    artist: 'Some Artist',
    sourceUrl: 'https://music.apple.com/album/apple1',
    links: {
      apple: { url: 'https://music.apple.com/album/apple1', nativeUri: 'music://album/apple1' },
    },
    cover: null, year: '2024', tags: [], addedAt: new Date().toISOString(),
  };
  await context.addInitScript(({ keys, al }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([al]));
  }, { keys: KEYS, al: album });

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  // The Listen button should be disabled (preferred service = spotify, album only on apple)
  const listenBtn = page.locator('.btn-listen--unavailable');
  await expect(listenBtn).toBeVisible();
  await expect(listenBtn).toBeDisabled();
  await expect(listenBtn).toContainText('Not on Spotify');
});

test('resolution resumes when user returns to tab (visibilitychange)', async ({ page, context }) => {
  await stubLastfm(context);

  // Odesli is unavailable; MB resolves on the second request (simulating resumed resolution)
  let mbCallCount = 0;
  await context.route('https://api.song.link/**', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":503}' })
  );
  await context.route('https://musicbrainz.org/**', route => {
    mbCallCount++;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        resource: 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd',
        id: 'url-uuid',
        relations: [{ 'target-type': 'release', release: {
          id: 'ce4d1a76-7727-45d7-b61a-21a6e841e21c',
          title: 'Resumed Album',
          date: '2020-01-01',
          'artist-credit': [{ name: 'Resume Artist' }],
        }}],
      }),
    });
  });

  // Pre-seed localStorage with a pending stub (bypasses import flow; tests the resume path)
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.ALBUMS, JSON.stringify([{
      id: 'pending:https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd',
      sourceUrl: 'https://open.spotify.com/album/5Oc87gybQZkVeqogIFXzMd',
      service: 'spotify', title: null, artist: null, cover: null, year: null,
      tags: [], addedAt: new Date().toISOString(), links: {}, _pending: true,
    }]));
  }, { keys: KEYS });

  await page.goto('/');
  // Card is present but pending (resolution may have started at boot)
  await expect(page.locator('.card-title')).toBeVisible({ timeout: 3000 });

  // Simulate returning from background: dispatch visibilitychange visible
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Resolution completes via MB fallback
  await expect(page.locator('.card-title')).toContainText('Resumed Album', { timeout: 8000 });
});

// ── Desktop layout smoke tests ────────────────────────────────────────────────

test('desktop viewport renders hero with 2-col layout and 3 feature cards', async ({ page, context }) => {
  await stubLastfm(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await expect(page.locator('.landing')).toBeVisible();
  await expect(page.locator('.landing-headline')).toContainText('Never lose a great album');
  await expect(page.locator('.landing-feature')).toHaveCount(3);
  await expect(page.locator('.landing-hero-text')).toBeVisible();
  await expect(page.locator('.landing-hero-visual')).toBeVisible();
  await expect(page.locator('.landing-timeline')).toBeVisible();
  await expect(page.locator('.landing-timeline-step')).toHaveCount(3);
});

test('FAQ is not inline in the hero anymore', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');

  await expect(page.locator('.landing')).toBeVisible();
  await expect(page.locator('.landing .faq-item')).toHaveCount(0);
});

test('FAQ link in hero navigates to faq.html', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');

  await expect(page.locator('.landing-hero-faq-link')).toHaveAttribute('href', 'faq.html');
});

test('FAQ link in footer navigates to faq.html', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');

  const faqLinks = page.locator('.footer a[href="faq.html"]');
  await expect(faqLinks).toHaveCount(1);
});

// ── FAQ subpage ───────────────────────────────────────────────────────────────

test('faq.html loads with on-brand styles and accordion items', async ({ page }) => {
  await page.goto('/faq.html');

  // Title present
  await expect(page.locator('.faq-page-title')).toContainText('Frequently asked questions');

  // Five FAQ items
  await expect(page.locator('.faq-item')).toHaveCount(5);

  // Back-to-home link in header
  const backLink = page.locator('.header-right a[href="/"]');
  await expect(backLink).toBeVisible();
  await expect(backLink).toContainText('Back');

  // Accordions are interactive — open the first one
  await page.locator('.faq-item:first-of-type summary').click();
  await expect(page.locator('.faq-item:first-of-type')).toHaveAttribute('open', '');
});
