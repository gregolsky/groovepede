// Post-deploy production smoke suite. Opens the REAL deployed site (default
// https://groovepede.gregolsky.pl, override with SMOKE_BASE_URL) and clicks
// through it. Run via `npm run test:smoke` — this is NOT part of `npm test`
// (see playwright.smoke.config.js).
//
// Scope is deliberately narrow: no metadata/"looks ok" assertions, just
// (a) real resolution actually works end-to-end against the live resolver,
// (b) no JS errors, (c) no viewport overflow (see viewport.spec.js).
import { test, expect } from '@playwright/test';
import { watchForErrors, seedAlbums } from './helpers.js';

// One real, long-lived album per service, verified resolvable via the public
// Odesli API (api.song.link) while writing this suite:
//   curl 'https://api.song.link/v1-alpha.1/links?url=<encoded>&userCountry=US'
// All four returned 200 with a populated entitiesByUniqueId.
//
// youtube is intentionally omitted: the public Odesli API never returned a
// youtubeMusic link for any anonymous request tried here (checked against 4
// popular albums), so no candidate URL could be confirmed resolvable from
// this environment. The live resolver may carry a server-side ODESLI_KEY
// with fuller platform coverage — add a verified youtube URL here once
// confirmed directly against https://api.groovepede.gregolsky.pl.
const SERVICE_ALBUMS = [
  { slug: 'spotify', url: 'https://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp' },
  { slug: 'apple', url: 'https://music.apple.com/us/album/random-access-memories/617154241' },
  { slug: 'tidal', url: 'https://tidal.com/browse/album/77640617' },
  { slug: 'deezer', url: 'https://www.deezer.com/album/302127' },
];

test.describe('landing', () => {
  test('loads clean, no login wall', async ({ page, baseURL }) => {
    const errors = watchForErrors(page, baseURL);
    await page.goto('/');

    await expect(page.locator('.landing')).toBeVisible();
    await expect(page.locator('.landing-cta[data-action="toggle-add"]')).toBeVisible();
    await expect(page.locator('.landing-feature')).toHaveCount(3);

    expect(errors).toEqual([]);
  });
});

test.describe('resolves a real link per service', () => {
  for (const { slug, url } of SERVICE_ALBUMS) {
    test(`${slug}: ${url}`, async ({ page, baseURL }) => {
      const errors = watchForErrors(page, baseURL);
      await page.goto('/');

      await page.click('[data-action="toggle-add"]');
      await page.fill('#url-input', url);

      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/v1/resolve')),
        page.click('[data-action="add"]'),
      ]);
      expect(response.status(), `resolver returned ${response.status()} for ${url}`).toBe(200);

      await expect(page.locator('.card')).toHaveCount(1, { timeout: 15_000 });
      // Load-bearing: a failed resolve still renders a visible `.card`, just
      // with class `.card--pending` (see src/js/render.js, src/js/app.js).
      // A dead resolver would still pass a plain ".card is visible" check.
      await expect(page.locator('.card--pending')).toHaveCount(0);

      expect(errors).toEqual([]);
    });
  }
});

test.describe('click-through on a populated app', () => {
  test('profile, search, tag filter, tag bar expand, mark done', async ({ page, baseURL }) => {
    const errors = watchForErrors(page, baseURL);
    await seedAlbums(page); // 6 synthetic albums, 9 distinct tags, no network calls
    await page.goto('/');
    await expect(page.locator('.card')).toHaveCount(6);

    // Profile panel open / close
    await page.click('[data-action="open-profile"]');
    await expect(page.locator('.profile')).toBeVisible();
    await page.click('[data-action="close-profile"]');
    await expect(page.locator('.profile')).not.toBeVisible();

    // Search narrows the list, clearing restores it
    await page.fill('#search-input', 'Radiohead');
    await expect(page.locator('.card')).toHaveCount(1);
    await page.click('[data-action="clear-search"]');
    await expect(page.locator('.card')).toHaveCount(6);

    // Tag bar filter (top-6-by-frequency chip, visible without expanding)
    await page.click('.filter-chip[data-tag="ambient"]');
    await expect(page.locator('.card')).toHaveCount(1);
    await page.click('.filter-chip[data-tag="all"]');
    await expect(page.locator('.card')).toHaveCount(6);

    // Tag bar expand/collapse — 9 distinct tags > 7 triggers the More toggle
    const moreToggle = page.locator('[data-action="toggle-tags"]');
    await expect(moreToggle).toBeVisible();
    await moreToggle.click();
    await expect(moreToggle).toHaveText(/Less/);
    // A tag outside the top 6 only appears once expanded
    await expect(page.locator('.filter-chip[data-tag="jazz"]')).toBeVisible();
    await moreToggle.click();
    await expect(moreToggle).toHaveText(/More/);

    // Mark an album done — removes it from the list after its flash animation
    await page.locator('[data-action="done"]').first().click();
    await expect(page.locator('.card')).toHaveCount(5, { timeout: 5000 });

    expect(errors).toEqual([]);
  });
});
