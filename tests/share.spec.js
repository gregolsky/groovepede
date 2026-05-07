import { test, expect } from '@playwright/test';

const KEYS = {
  TOKEN:  'gp_token',
  EXPIRY: 'gp_expiry',
};

const ALBUM_ID = 'shareTestAlbum1';
const SHARE_URL = `https://open.spotify.com/album/${ALBUM_ID}`;

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

function stubSpotifyApis(context) {
  return context.route('https://api.spotify.com/**', async route => {
    const url = route.request().url();
    if (url.includes('/v1/me')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'u1', display_name: 'Test User', images: [] }) });
    }
    if (url.includes(`/v1/albums/${ALBUM_ID}`) && !url.includes('/tracks')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: ALBUM_ID,
          name: 'Share Test Album',
          external_urls: { spotify: SHARE_URL },
          artists: [{ id: 'a1', name: 'Share Artist' }],
          images: [{ url: 'https://img/cover' }],
          release_date: '2020-01-01',
          tracks: { items: [{ uri: 'spotify:track:t1' }] },
        }),
      });
    }
    route.continue();
  });
}

// ── Share in standalone (PWA) mode shows overlay ───────────────────────────────

test('share-target shows confirmation overlay in standalone mode', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  await fakeStandalone(context);
  await stubSpotifyApis(context);
  await context.route('https://ws.audioscrobbler.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).toBeVisible({ timeout: 4000 });
  await expect(page.locator('#share-confirm .share-confirm__title')).toHaveText('Share Test Album');
  await expect(page.locator('#share-confirm .share-confirm__label')).toHaveText('Added to queue');
});

test('share-target overlay disappears and card is highlighted when window.close() does not close', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  await fakeStandalone(context);
  await stubSpotifyApis(context);
  await context.route('https://ws.audioscrobbler.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  // Prevent window.close() from actually closing so we can observe fallback
  await context.addInitScript(() => { window.close = () => {}; });

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).toBeVisible({ timeout: 4000 });
  // After 1050ms, overlay should be removed and card should be highlighted
  await expect(page.locator('#share-confirm')).not.toBeAttached({ timeout: 2500 });
  await expect(page.locator(`#card-${ALBUM_ID}`)).toBeVisible({ timeout: 1000 });
  await expect(page.locator(`#card-${ALBUM_ID}`)).toHaveClass(/card--highlight/);
});

// ── Share via browser tab (not standalone) shows normal highlight, no overlay ──

test('share-target in browser tab shows card highlight, not overlay', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {});
  await stubSpotifyApis(context);
  await context.route('https://ws.audioscrobbler.com/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  await page.goto(`/?url=${encodeURIComponent(SHARE_URL)}`);

  await expect(page.locator('#share-confirm')).not.toBeAttached({ timeout: 4000 });
  await expect(page.locator(`#card-${ALBUM_ID}`)).toBeVisible({ timeout: 4000 });
  await expect(page.locator(`#card-${ALBUM_ID}`)).toHaveClass(/card--highlight/);
});
