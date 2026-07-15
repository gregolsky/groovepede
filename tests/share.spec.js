import { test, expect } from '@playwright/test';

const KEYS = {
  TOKEN:  'gp_token',
  EXPIRY: 'gp_expiry',
};

const ALBUM_ID    = 'shareTestAlbum1xxxxxx'; // 22 chars for Spotify ID
const SHARE_URL   = `https://open.spotify.com/album/${ALBUM_ID}`;
const ODESLI_ID   = `SPOTIFY_ALBUM::${ALBUM_ID}`;

function makeOdesliResponse() {
  return {
    entityUniqueId: ODESLI_ID,
    userCountry: 'US',
    entitiesByUniqueId: {
      [ODESLI_ID]: {
        id: ALBUM_ID,
        type: 'album',
        title: 'Share Test Album',
        artistName: 'Share Artist',
        thumbnailUrl: 'https://img/cover',
        apiProvider: 'spotify',
        platforms: ['spotify'],
      },
    },
    linksByPlatform: {
      spotify: {
        url: SHARE_URL,
        nativeAppUriMobile: `spotify:album:${ALBUM_ID}`,
        entityUniqueId: ODESLI_ID,
      },
    },
  };
}

function seedLoggedIn() {
  return async ({ context }, use) => {
    await context.addInitScript(({ keys }) => {
      localStorage.setItem(keys.TOKEN,  'valid_token');
      localStorage.setItem(keys.EXPIRY, String(Date.now() + 3600000));
    }, { keys: KEYS });
    await use();
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

function stubApis(context) {
  context.route('https://api.spotify.com/v1/me', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', display_name: 'Test User', images: [] }) })
  );
  context.route('https://api.groovepede.gregolsky.pl/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(makeOdesliResponse()) })
  );
  context.route('https://ws.audioscrobbler.com/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

// ── Share in standalone (PWA) mode shows overlay ───────────────────────────────

test('share-target shows confirmation overlay in standalone mode', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  await fakeStandalone(context);
  stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#share-confirm .share-confirm__title')).toHaveText('Share Test Album');
  await expect(page.locator('#share-confirm .share-confirm__label')).toHaveText('Added to queue');
});

test('share-target overlay disappears and card is highlighted when window.close() does not close', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  await fakeStandalone(context);
  stubApis(context);
  await context.addInitScript(() => { window.close = () => {}; });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#share-confirm')).not.toBeAttached({ timeout: 2500 });
  await expect(page.locator(`[id="card-${ODESLI_ID}"]`)).toBeVisible({ timeout: 1000 });
  await expect(page.locator(`[id="card-${ODESLI_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Share via browser tab (not standalone) shows normal highlight, no overlay ──

test('share-target in browser tab shows card highlight, not overlay', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).not.toBeAttached({ timeout: 6000 });
  await expect(page.locator(`[id="card-${ODESLI_ID}"]`)).toBeVisible({ timeout: 6000 });
  await expect(page.locator(`[id="card-${ODESLI_ID}"]`)).toHaveClass(/card--highlight/);
});

// ── Share works without Spotify login ─────────────────────────────────────────

test('share-target works without being logged in', async ({ page, context }) => {
  stubApis(context);

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator(`[id="card-${ODESLI_ID}"]`)).toBeVisible({ timeout: 6000 });
});
