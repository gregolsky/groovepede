import { test, expect } from '@playwright/test';

const STORAGE_KEYS = {
  TOKEN:   'gp_token',
  EXPIRY:  'gp_expiry',
  REFRESH: 'gp_refresh',
};

// Helpers for seeding localStorage before the page loads
function withExpiredToken(refreshToken = null) {
  return async ({ context }, use) => {
    await context.addInitScript(({ keys, refresh }) => {
      localStorage.setItem(keys.TOKEN,  'expired_token');
      localStorage.setItem(keys.EXPIRY, String(Date.now() - 1000)); // already expired
      if (refresh) localStorage.setItem(keys.REFRESH, refresh);
    }, { keys: STORAGE_KEYS, refresh: refreshToken });
    await use();
  };
}

// ── Show login screen only when no session is recoverable ─────────────────────

test('shows login screen when no token at all', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();
  await expect(page.locator('.landing [data-action="login"]')).toBeVisible();
});

test('shows login screen when token expired and no refresh token', async ({ page, context }) => {
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,  'stale');
    localStorage.setItem(keys.EXPIRY, String(Date.now() - 1000));
  }, { keys: STORAGE_KEYS });

  await page.goto('/');
  await expect(page.locator('.landing')).toBeVisible();
});

test('does NOT show login screen when token expired but refresh token exists', async ({ page, context }) => {
  // Stub the Spotify token refresh endpoint to return a fresh token
  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'refreshed_token',
        expires_in: 3600,
      }),
    });
  });

  // Stub /me so boot doesn't fail
  await context.route('https://api.spotify.com/v1/me', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    });
  });

  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'expired_token');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() - 1000));
    localStorage.setItem(keys.REFRESH, 'valid_refresh_token');
  }, { keys: STORAGE_KEYS });

  await page.goto('/');
  await expect(page.locator('.landing')).not.toBeVisible();
  await expect(page.locator('.stats')).toBeVisible();
});

// ── Token refresh and retry on 401 ────────────────────────────────────────────

test('retries Spotify API call after 401 by refreshing token', async ({ page, context }) => {
  let albumCallCount = 0;

  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'new_token', expires_in: 3600 }),
    });
  });

  await context.route('https://api.spotify.com/v1/me', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    });
  });

  await context.route('https://api.spotify.com/v1/albums/abc123def456ghi789jklm', async route => {
    albumCallCount++;
    // First call → 401, second call → success
    if (albumCallCount === 1) {
      await route.fulfill({ status: 401, body: '{}' });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Test Album',
          artists: [{ name: 'Test Artist', id: 'a1' }],
          images: [{ url: 'https://example.com/cover.jpg' }],
          release_date: '2020-01-01',
          external_urls: { spotify: 'https://open.spotify.com/album/abc123def456ghi789jklm' },
        }),
      });
    }
  });

  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'about_to_expire');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() + 999999));
    localStorage.setItem(keys.REFRESH, 'valid_refresh');
  }, { keys: STORAGE_KEYS });

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  // Paste a valid 22-char album ID to trigger fetchAlbumMeta
  await page.fill('#url-input', 'abc123def456ghi789jklm');
  await page.click('[data-action="add"]');

  // Should succeed after retry — card should appear
  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
  expect(albumCallCount).toBe(2);
});

// ── OAuth callback (code exchange) ────────────────────────────────────────────

test('exchanges OAuth code from URL and shows app', async ({ page, context }) => {
  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'fresh_token',
        refresh_token: 'refresh_tok',
        expires_in: 3600,
      }),
    });
  });

  await context.route('https://api.spotify.com/v1/me', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'OAuth User', images: [] }),
    });
  });

  // Seed the verifier (needed for exchangeCode)
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.VERIFIER, 'fake_verifier');
  }, { keys: { ...STORAGE_KEYS, VERIFIER: 'gp_verifier' } });

  await page.goto('/?code=fake_auth_code');

  // URL should be cleaned up
  await expect(page).toHaveURL('/');

  // App should show the queue, not login screen
  await expect(page.locator('.landing')).not.toBeVisible();
  await expect(page.locator('.stats')).toBeVisible();
});

// ── Logout ────────────────────────────────────────────────────────────────────

test('logout clears session and shows login screen', async ({ page, context }) => {
  await context.route('https://api.spotify.com/v1/me', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    });
  });

  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'valid_token');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() + 3600000));
    localStorage.setItem(keys.REFRESH, 'refresh_tok');
  }, { keys: STORAGE_KEYS });

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="logout"]');
  await expect(page.locator('.landing')).toBeVisible();
});
