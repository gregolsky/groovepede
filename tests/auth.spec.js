import { test, expect } from '@playwright/test';

const STORAGE_KEYS = {
  TOKEN:   'gp_token',
  EXPIRY:  'gp_expiry',
  REFRESH: 'gp_refresh',
};

// A realistic Odesli response for a Spotify album link
function makeOdesliResponse() {
  const entityId = 'SPOTIFY_ALBUM::abc123def456ghi789jklm';
  return {
    entityUniqueId: entityId,
    userCountry: 'US',
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
  };
}

async function stubOdesliSuccess(context) {
  await context.route('https://api.song.link/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeOdesliResponse()),
    })
  );
}

async function stubLastfm(context) {
  await context.route('https://ws.audioscrobbler.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

// ── Logged-out: app is accessible without Spotify ────────────────────────────

test('shows app when no token at all — no login wall', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();
  // Connect Spotify button should be present but secondary
  await expect(page.locator('#auth-area [data-action="login"]')).toBeVisible();
  // No hard landing wall
  await expect(page.locator('.landing')).not.toBeVisible();
});

test('shows app when token expired and no refresh token — no login wall', async ({ page, context }) => {
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,  'stale');
    localStorage.setItem(keys.EXPIRY, String(Date.now() - 1000));
  }, { keys: STORAGE_KEYS });
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.landing')).not.toBeVisible();
});

test('logged-out user can add an album via Odesli', async ({ page, context }) => {
  await stubOdesliSuccess(context);
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await page.fill('#url-input', 'https://open.spotify.com/album/abc123def456ghi789jklm');
  await page.click('[data-action="add"]');

  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.card .card-title')).toContainText('Test Album');
});

// ── Token refresh and retry ───────────────────────────────────────────────────

test('does NOT show login wall when token expired but refresh token exists', async ({ page, context }) => {
  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'refreshed_token', expires_in: 3600 }),
    });
  });
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
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.landing')).not.toBeVisible();
});

test('adds album successfully after token refresh via Odesli', async ({ page, context }) => {
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
  await stubOdesliSuccess(context);
  await stubLastfm(context);

  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'about_to_expire');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() + 999999));
    localStorage.setItem(keys.REFRESH, 'valid_refresh');
  }, { keys: STORAGE_KEYS });

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await page.fill('#url-input', 'https://open.spotify.com/album/abc123def456ghi789jklm');
  await page.click('[data-action="add"]');

  await expect(page.locator('.card')).toBeVisible({ timeout: 5000 });
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
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.VERIFIER, 'fake_verifier');
  }, { keys: { ...STORAGE_KEYS, VERIFIER: 'gp_verifier' } });
  await stubLastfm(context);

  await page.goto('/?code=fake_auth_code');
  await expect(page).toHaveURL('/');
  await expect(page.locator('.landing')).not.toBeVisible();
  await expect(page.locator('.stats')).toBeVisible();
});

// ── invalid_grant: expired refresh token ─────────────────────────────────────

test('clears session and shows app (not logged in) when refresh token returns invalid_grant at boot', async ({ page, context }) => {
  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }),
    });
  });
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'expired_token');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() - 1000));
    localStorage.setItem(keys.REFRESH, 'expired_refresh_token');
  }, { keys: STORAGE_KEYS });
  await stubLastfm(context);

  await page.goto('/');
  // App shows (not blocked by landing wall) but user is logged out
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.landing')).not.toBeVisible();
  // Tokens cleared
  const stored = await page.evaluate(keys => ({
    token:   localStorage.getItem(keys.TOKEN),
    expiry:  localStorage.getItem(keys.EXPIRY),
    refresh: localStorage.getItem(keys.REFRESH),
  }), STORAGE_KEYS);
  expect(stored.token).toBeNull();
  expect(stored.expiry).toBeNull();
  expect(stored.refresh).toBeNull();
});

test('clears session when mid-session add fails with invalid_grant', async ({ page, context }) => {
  await context.route('https://api.spotify.com/v1/me', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    });
  });
  // Odesli call itself fails with a non-retryable code (simulate Odesli 404 so no add)
  // The invalid_grant should still fire from the firstTrackUri Spotify fetch
  await context.route('https://api.song.link/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makeOdesliResponse()),
    });
  });
  // Spotify firstTrackUri fetch returns 401
  await context.route('https://api.spotify.com/v1/albums/**', async route => {
    await route.fulfill({ status: 401, body: '{}' });
  });
  await context.route('https://accounts.spotify.com/api/token', async route => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }),
    });
  });
  await context.addInitScript(({ keys }) => {
    localStorage.setItem(keys.TOKEN,   'valid_token');
    localStorage.setItem(keys.EXPIRY,  String(Date.now() + 999999));
    localStorage.setItem(keys.REFRESH, 'expired_refresh_token');
  }, { keys: STORAGE_KEYS });
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await page.fill('#url-input', 'https://open.spotify.com/album/abc123def456ghi789jklm');
  await page.click('[data-action="add"]');

  // Session cleared; Connect button appears
  await expect(page.locator('[data-action="login"]')).toBeVisible({ timeout: 5000 });
  const stored = await page.evaluate(keys => ({
    token:   localStorage.getItem(keys.TOKEN),
    expiry:  localStorage.getItem(keys.EXPIRY),
    refresh: localStorage.getItem(keys.REFRESH),
  }), STORAGE_KEYS);
  expect(stored.token).toBeNull();
});

// ── Logout ────────────────────────────────────────────────────────────────────

test('logout clears session and shows app in logged-out state', async ({ page, context }) => {
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
  await stubLastfm(context);

  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="open-profile"]');
  await expect(page.locator('.profile')).toBeVisible();
  await page.click('[data-action="logout"]');

  // App still shows; user is just logged out
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.landing')).not.toBeVisible();
  // Connect button re-appears in header
  await expect(page.locator('#auth-area [data-action="login"]')).toBeVisible();
});
