// No horizontal overflow on real phone geometry, in both orientations, for the
// empty landing and for a populated queue with the widest tag row expanded.
// Same probe as the post-deploy viewport check (tests-lib/dom.js), but run on
// every device project and against the local production build.
import { test, expect } from '@playwright/test';
import { stubExternals, seedAlbums } from '../tests/helpers.js';
import { WIDE_TAG_ALBUMS } from '../tests-lib/albums.js';
import { overflowReport, assertNoOverflow } from '../tests-lib/dom.js';

const ORIENTATIONS = ['portrait', 'landscape'];

for (const orientation of ORIENTATIONS) {
  test.describe(orientation, () => {
    test.beforeEach(async ({ page }) => {
      const { width, height } = page.viewportSize();
      const [w, h] = orientation === 'landscape' ? [Math.max(width, height), Math.min(width, height)]
                                                  : [Math.min(width, height), Math.max(width, height)];
      await page.setViewportSize({ width: w, height: h });
    });

    test('landing fits', async ({ page, context }) => {
      await stubExternals(context);
      await page.goto('/');
      await expect(page.locator('.landing')).toBeVisible();
      assertNoOverflow(await overflowReport(page));
    });

    test('populated queue with the tag bar expanded fits', async ({ page, context }) => {
      await stubExternals(context);
      await seedAlbums(context, WIDE_TAG_ALBUMS, 2);
      await page.goto('/');
      await expect(page.locator('.card')).toHaveCount(6);

      // The collapsed default (top 6 tags) would hide the widest row.
      const moreToggle = page.locator('[data-action="toggle-tags"]');
      if (await moreToggle.isVisible()) await moreToggle.tap();

      assertNoOverflow(await overflowReport(page));
    });
  });
}

test('body overflow-x is not clipped (mask must stay off)', async ({ page, context }) => {
  // Clipping the body would make every assertion above go quiet.
  await stubExternals(context);
  await page.goto('/');
  const overflowX = await page.evaluate(() => getComputedStyle(document.body).overflowX);
  expect(overflowX).not.toBe('hidden');
});
