import { test, expect } from '@playwright/test';

const KEYS = {
  TOKEN:    'gp_token',
  EXPIRY:   'gp_expiry',
  REFRESH:  'gp_refresh',
  ALBUMS:   'gp_albums',
  SYNC_ON:  'gp_sync_enabled',
  SYNC_PL:  'gp_sync_playlist_id',
};

const PLAYLIST_ID = 'testPlaylistId123';
const USER_ID     = 'testuser';

function seedLoggedIn(extraStorage = {}) {
  return async ({ context }, use) => {
    await context.addInitScript(({ keys, extra }) => {
      localStorage.setItem(keys.TOKEN,  'valid_token');
      localStorage.setItem(keys.EXPIRY, String(Date.now() + 3600000));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    }, { keys: KEYS, extra: extraStorage });
    await use();
  };
}

function stubSpotify(context) {
  return context.route('https://api.spotify.com/**', async route => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.includes('/v1/me') && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: USER_ID, display_name: 'Test User', images: [] }) });
    }
    if (url.includes('/v1/users/') && url.includes('/playlists') && method === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ id: PLAYLIST_ID, name: 'Groovepede Queue', public: false }) });
    }
    if (url.includes('/v1/playlists/' + PLAYLIST_ID + '/tracks') && method === 'PUT') {
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ snapshot_id: 'snap1' }) });
    }
    if (url.includes('/v1/playlists/' + PLAYLIST_ID + '/tracks') && method === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ snapshot_id: 'snap2' }) });
    }
    if (url.includes('/v1/playlists/' + PLAYLIST_ID + '/tracks') && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          next: null,
          items: [{
            track: {
              uri: 'spotify:track:restoredTrack1',
              album: {
                id: 'restoredAlbum1',
                name: 'Restored Album',
                release_date: '2022-01-01',
                external_urls: { spotify: 'https://open.spotify.com/album/restoredAlbum1' },
                images: [{ url: 'https://img/cover' }],
                artists: [{ id: 'artist1', name: 'Restored Artist' }],
              },
            },
          }],
        }),
      });
    }
    if (url.includes('/v1/albums/') && url.includes('/tracks') && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ items: [{ uri: 'spotify:track:backfill1' }] }) });
    }
    if (url.includes('/v1/albums/') && method === 'GET') {
      const id = url.match(/\/albums\/([^/?]+)/)?.[1] || 'unknown';
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id, name: 'Stubbed Album', external_urls: { spotify: 'https://open.spotify.com/album/' + id },
          artists: [{ id: 'a1', name: 'Stubbed Artist' }],
          images: [{ url: 'https://img/stub' }],
          release_date: '2021-06-01',
          tracks: { items: [{ uri: 'spotify:track:stub1' }] },
        }),
      });
    }
    route.continue();
  });
}

function stubLastfm(context) {
  return context.route('https://ws.audioscrobbler.com/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
}

// ── Logged-out sync isolation ─────────────────────────────────────────────────

test('sync section not present when logged out; Connect Spotify shown instead', async ({ page, context }) => {
  await stubLastfm(context);
  await page.goto('/');
  // Empty queue → hero shown; add CTA accessible
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible();

  // When logged out, sync toggle must not exist anywhere
  await expect(page.locator('.sync-toggle')).toHaveCount(0);
  // Auth area shows Connect button
  await expect(page.locator('#auth-area [data-action="login"]')).toBeVisible();
  // Profile IS now accessible even when logged out (import/export fix)
  await expect(page.locator('#auth-area [data-action="open-profile"]')).toBeVisible();
});

test('marking album done when logged out does not push to Spotify (even if sync was previously enabled)', async ({ page, context }) => {
  const album = {
    id: 'SPOTIFY_ALBUM::alb001', title: 'No Push Album', artist: 'Test',
    sourceUrl: 'https://open.spotify.com/album/alb001',
    links: { spotify: { url: 'https://open.spotify.com/album/alb001' } },
    cover: null, year: '2020', tags: [], addedAt: new Date().toISOString(),
    firstTrackUri: 'spotify:track:t001',
  };

  // Seed sync enabled + playlist + album, but NO auth token
  await context.addInitScript(({ keys, al, plId }) => {
    localStorage.setItem(keys.ALBUMS,  JSON.stringify([al]));
    localStorage.setItem(keys.SYNC_ON, '1');
    localStorage.setItem(keys.SYNC_PL, plId);
  }, { keys: KEYS, al: album, plId: PLAYLIST_ID });
  await stubLastfm(context);

  let playlistPushMade = false;
  context.on('request', req => {
    if (req.url().includes('/playlists/') && req.url().includes('/tracks')) {
      playlistPushMade = true;
    }
  });

  await page.goto('/');
  await expect(page.locator('.card')).toBeVisible();

  await page.click('[data-action="done"][data-index="0"]');
  // Wait past the 2s schedulePush debounce to be sure
  await page.waitForTimeout(3500);

  expect(playlistPushMade).toBe(false);
});

// ── Enable sync from profile ───────────────────────────────────────────────────

test('enabling sync creates playlist and does initial push', async ({ page, context }) => {
  await seedLoggedIn()(
    { context },
    async () => {
      await stubSpotify(context);

      let createBody = null;
      await context.route('https://api.spotify.com/v1/users/' + USER_ID + '/playlists', async route => {
        createBody = JSON.parse(route.request().postData());
        await route.fulfill({ status: 201, contentType: 'application/json',
          body: JSON.stringify({ id: PLAYLIST_ID, name: 'Groovepede Queue', public: false }) });
      });

      const putPromise = page.waitForRequest(
        req => req.url().includes('/playlists/' + PLAYLIST_ID + '/tracks') && req.method() === 'PUT',
        { timeout: 8000 }
      );

      await page.goto('/');
      // No albums seeded → hero shows; logged-in header user-pill has open-profile
      await expect(page.locator('#auth-area [data-action="open-profile"]')).toBeVisible();

      await page.click('#auth-area [data-action="open-profile"]');
      await expect(page.locator('.profile')).toBeVisible();
      await page.click('[data-action="toggle-sync"]');

      await putPromise;
      expect(createBody?.name).toBe('Groovepede Queue');
      expect(createBody?.public).toBe(false);

      await expect(page.locator('.sync-toggle--on')).toBeVisible();
    }
  );
});

// ── Auto-push on album add ─────────────────────────────────────────────────────

test('adding an album with sync on triggers a push', async ({ page, context }) => {
  const album = { id: 'alb001', title: 'Push Test', artist: 'Test Artist',
    url: 'https://open.spotify.com/album/alb001', cover: null, year: '2020',
    tags: [], addedAt: new Date().toISOString(), firstTrackUri: 'spotify:track:t001' };

  await seedLoggedIn({
    [KEYS.SYNC_ON]: '1',
    [KEYS.SYNC_PL]: PLAYLIST_ID,
    [KEYS.ALBUMS]:  JSON.stringify([album]),
  })({ context }, async () => {
    await stubSpotify(context);

    // Stub Odesli — add flow now resolves via Odesli, not Spotify albums API
    const newId = '4aawyAB9vmqN3uQ7FjRGTy';
    const odesliId = `SPOTIFY_ALBUM::${newId}`;
    await context.route('https://api.song.link/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entityUniqueId: odesliId,
        entitiesByUniqueId: {
          [odesliId]: { id: newId, type: 'album', title: 'New Album', artistName: 'New Artist',
            thumbnailUrl: null, apiProvider: 'spotify', platforms: ['spotify'] },
        },
        linksByPlatform: {
          spotify: { url: `https://open.spotify.com/album/${newId}`,
            nativeAppUriMobile: `spotify:album:${newId}`, entityUniqueId: odesliId },
        },
      }),
    }));

    await context.route('https://ws.audioscrobbler.com/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({}),
    }));

    await page.goto('/');
    await expect(page.locator('.stats')).toBeVisible();

    const putPromise = page.waitForRequest(
      req => req.url().includes('/playlists/' + PLAYLIST_ID + '/tracks') && req.method() === 'PUT',
      { timeout: 10000 }
    );

    await page.click('[data-action="toggle-add"]');
    const input = page.locator('#url-input');
    await input.fill(`https://open.spotify.com/album/${newId}`);
    await input.press('Enter');

    await putPromise;
  });
});

// ── Disable sync ──────────────────────────────────────────────────────────────

test('disabling sync stops future pushes', async ({ page, context }) => {
  const album = { id: 'alb002', title: 'No Push', artist: 'Test', url: '',
    cover: null, year: '2020', tags: [], addedAt: new Date().toISOString(),
    firstTrackUri: 'spotify:track:t002' };

  await seedLoggedIn({
    [KEYS.SYNC_ON]: '1',
    [KEYS.SYNC_PL]: PLAYLIST_ID,
    [KEYS.ALBUMS]:  JSON.stringify([album]),
  })({ context }, async () => {
    await stubSpotify(context);

    let putCalled = false;
    context.on('request', req => {
      if (req.url().includes('/playlists/' + PLAYLIST_ID + '/tracks') && req.method() === 'PUT')
        putCalled = true;
    });

    await page.goto('/');
    await expect(page.locator('.stats')).toBeVisible();

    // disable
    await page.click('[data-action="open-profile"]');
    await page.click('[data-action="toggle-sync"]');
    await expect(page.locator('.sync-toggle--on')).not.toBeVisible();
    await page.click('[data-action="close-profile"]');

    putCalled = false;
    // mark album done — no push should happen
    await page.click('[data-action="done"][data-index="0"]');
    await page.waitForTimeout(3000);
    expect(putCalled).toBe(false);
  });
});

// ── Restore from playlist ─────────────────────────────────────────────────────

test('restore replaces local queue on confirm', async ({ page, context }) => {
  const localAlbum = { id: 'local1', title: 'Local Album', artist: 'Local',
    url: '', cover: null, year: '2021', tags: [], addedAt: new Date().toISOString() };

  await seedLoggedIn({
    [KEYS.SYNC_ON]: '1',
    [KEYS.SYNC_PL]: PLAYLIST_ID,
    [KEYS.ALBUMS]:  JSON.stringify([localAlbum]),
  })({ context }, async () => {
    await stubSpotify(context);
    await stubLastfm(context);

    page.on('dialog', dialog => dialog.accept());

    await page.goto('/');
    await expect(page.locator('.stats')).toBeVisible();

    await page.click('[data-action="open-profile"]');
    await page.locator('.profile-advanced').evaluate(el => el.open = true);
    await page.click('[data-action="restore-sync"]');

    // After restore, the queue should contain the playlist album (Restored Album)
    await page.click('[data-action="close-profile"]');
    await expect(page.locator('.card')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.card-title')).toHaveText('Restored Album');
  });
});

test('restore is cancelled when user dismisses the confirm dialog', async ({ page, context }) => {
  const localAlbum = { id: 'local2', title: 'Keep Me', artist: 'Local',
    url: '', cover: null, year: '2021', tags: [], addedAt: new Date().toISOString() };

  await seedLoggedIn({
    [KEYS.SYNC_ON]: '1',
    [KEYS.SYNC_PL]: PLAYLIST_ID,
    [KEYS.ALBUMS]:  JSON.stringify([localAlbum]),
  })({ context }, async () => {
    await stubSpotify(context);
    await stubLastfm(context);

    page.on('dialog', dialog => dialog.dismiss());

    await page.goto('/');
    await expect(page.locator('.stats')).toBeVisible();

    await page.click('[data-action="open-profile"]');
    await page.locator('.profile-advanced').evaluate(el => el.open = true);
    await page.click('[data-action="restore-sync"]');
    await page.click('[data-action="close-profile"]');

    await expect(page.locator('.card-title')).toHaveText('Keep Me');
  });
});

// ── 403 re-auth path ──────────────────────────────────────────────────────────

test('enabling sync with 403 sets pending flag and redirects to Spotify auth', async ({ page, context }) => {
  await seedLoggedIn()({ context }, async () => {
    await stubSpotify(context);

    // Override playlist creation to return 403 (insufficient scope)
    await context.route('https://api.spotify.com/v1/users/' + USER_ID + '/playlists', async route => {
      await route.fulfill({ status: 403, contentType: 'application/json',
        body: JSON.stringify({ error: { status: 403, message: 'Insufficient client scope' } }) });
    });

    await page.goto('/');
    // No albums seeded → hero; logged-in header user-pill has open-profile
    await expect(page.locator('#auth-area [data-action="open-profile"]')).toBeVisible();

    let authUrl = null;
    const authRedirected = new Promise(resolve => {
      context.route('https://accounts.spotify.com/authorize**', async route => {
        authUrl = route.request().url();
        resolve(authUrl);
        await route.abort(); // prevent actual navigation away
      });
    });

    await page.click('#auth-area [data-action="open-profile"]');
    await page.click('[data-action="toggle-sync"]');

    await authRedirected;
    expect(authUrl).toContain('accounts.spotify.com/authorize');
    expect(authUrl).toContain('playlist-modify-private');
  });
});

// ── 404 playlist-deleted path ─────────────────────────────────────────────────

test('push with 404 disables sync and clears playlist id', async ({ page, context }) => {
  const album = { id: 'alb404', title: 'Gone Album', artist: 'Test',
    url: 'https://open.spotify.com/album/alb404', cover: null, year: '2023',
    tags: [], addedAt: new Date().toISOString(), firstTrackUri: 'spotify:track:gone1' };

  await seedLoggedIn({
    [KEYS.SYNC_ON]: '1',
    [KEYS.SYNC_PL]: PLAYLIST_ID,
    [KEYS.ALBUMS]:  JSON.stringify([album]),
  })({ context }, async () => {
    await stubSpotify(context);

    // Override PUT tracks to return 404 (playlist was deleted from Spotify)
    await context.route('https://api.spotify.com/v1/playlists/' + PLAYLIST_ID + '/tracks', async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      await route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ error: { status: 404, message: 'Not found' } }) });
    });

    await page.goto('/');
    await expect(page.locator('.stats')).toBeVisible();

    // Mark album done — triggers schedulePush after state change
    await page.click('[data-action="done"][data-index="0"]');

    // Wait for debounce (2s) + push to complete
    await page.waitForFunction(
      () => localStorage.getItem('gp_sync_enabled') === null,
      { timeout: 8000 }
    );

    const playlistId = await page.evaluate(() => localStorage.getItem('gp_sync_playlist_id'));
    expect(playlistId).toBeNull();
  });
});
