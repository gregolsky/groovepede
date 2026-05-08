import { test, expect } from '@playwright/test';

const STORAGE_KEYS = {
  TOKEN:  'gp_token',
  EXPIRY: 'gp_expiry',
};

const ALBUM_ID = 'abc123def456ghi789jklm';
const ALBUM_URL = `https://api.spotify.com/v1/albums/${ALBUM_ID}`;

async function seedValidToken(context) {
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,  'valid_token');
    localStorage.setItem(keys.EXPIRY, String(Date.now() + 3600000));
  }, { keys: STORAGE_KEYS });
}

async function stubMe(context) {
  await context.route('https://api.spotify.com/v1/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    })
  );
}

// ── Album add errors ───────────────────────────────────────────────────────────

test('403 on album fetch shows development-mode error and does not add card', async ({ page, context }) => {
  await stubMe(context);
  await context.route(ALBUM_URL, route =>
    route.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: { status: 403, message: 'Insufficient client scope' } }) })
  );
  await seedValidToken(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#url-input', ALBUM_ID);
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(err).toContainText('development mode');
  await expect(err).toContainText('allowlist');
  await expect(page.locator('.card')).not.toBeVisible();
});

test('404 on album fetch shows generic error with status code and does not add card', async ({ page, context }) => {
  await stubMe(context);
  await context.route(ALBUM_URL, route =>
    route.fulfill({ status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: { status: 404, message: 'Not found' } }) })
  );
  await seedValidToken(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#url-input', ALBUM_ID);
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(err).toContainText('404');
  await expect(page.locator('.card')).not.toBeVisible();
});

test('500 on album fetch shows generic error with status code and does not add card', async ({ page, context }) => {
  await stubMe(context);
  await context.route(ALBUM_URL, route =>
    route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { status: 500, message: 'Internal Server Error' } }) })
  );
  await seedValidToken(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#url-input', ALBUM_ID);
  await page.click('[data-action="add"]');

  const err = page.locator('.add-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(err).toContainText('500');
  await expect(page.locator('.card')).not.toBeVisible();
});
