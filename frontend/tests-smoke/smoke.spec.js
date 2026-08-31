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

// One real, long-lived album per service, verified live while writing this
// suite by fetching each page/API directly (see backend/resolver-core.mjs for
// the extraction routine each one exercises) — spotify (embed page), apple
// (iTunes lookup), tidal and deezer (page + API) all confirmed to extract a
// non-null title/artist.
//
// youtube and pandora are intentionally omitted:
//  - youtube: no specific album-playlist URL was confirmed live during
//    development (the oEmbed endpoint itself works — verified against a
//    plain video URL — just not a specific album candidate). Add a verified
//    one here once confirmed against a live YouTube Music album page.
//  - pandora: Pandora is US-geofenced and every probe from a non-US host
//    during development came back geo-blocked, so the extractor's og:title
//    pattern could not be confirmed live at all. The Pi resolver itself may
//    face the same geo-block depending on where it's hosted — this is the
//    test that would catch it, once a candidate URL can be verified.
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
        page.waitForResponse((res) => res.url().includes('/v1/album')),
        page.click('[data-action="add"]'),
      ]);
      expect(response.status(), `resolver returned ${response.status()} for ${url}`).toBe(200);

      await expect(page.locator('.card')).toHaveCount(1, { timeout: 15_000 });
      // Load-bearing: a failed resolve still renders a visible `.card`, just
      // with class `.card--pending` (see src/js/render.js, src/js/app.js).
      // A dead resolver would still pass a plain ".card is visible" check.
      await expect(page.locator('.card--pending')).toHaveCount(0);
      // The real canary: extraction can 200 with a body that has no title/artist
      // (markup changed) — that's a 422 from the resolver, not this branch, but
      // guard the actual rendered text too since that's what a user sees.
      await expect(page.locator('.card .card-title')).not.toHaveText(/^unknown album$/i);
      await expect(page.locator('.card .card-artist')).not.toBeEmpty();

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
