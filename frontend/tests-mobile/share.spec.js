// The Android share-sheet launch on phone geometry. The e2e suite (tests/share.spec.js)
// covers the overlay's logic; this checks it FITS a phone screen in every phase
// while running as an installed app (display-mode: standalone).
import { test, expect } from '@playwright/test';
import { stubExternals, fakeStandalone, gatedResolver, makeAlbumResponse, SPOTIFY_URL } from '../tests/helpers.js';
import { overflowReport } from '../tests-lib/dom.js';

async function assertOverlayFits(page) {
  const overlay = page.locator('#share-overlay');
  const box = await overlay.boundingBox();
  const vp = page.viewportSize();
  expect(box, 'overlay has no box').toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  const report = await overflowReport(page);
  expect(report.wide, `overflowing elements: ${report.wide.join(', ')}`).toEqual([]);
}

test('share launch: overlay fits the screen while adding and once added', async ({ page, context }) => {
  const album = makeAlbumResponse({ title: 'A Rather Long Album Title That Must Wrap Not Overflow', artist: 'An Equally Long Artist Name Featuring Others' });
  await fakeStandalone(context);
  await stubExternals(context, { resolver: album });
  const release = await gatedResolver(context, album);

  await page.goto(`/?url=${encodeURIComponent(SPOTIFY_URL)}`, { waitUntil: 'commit' });

  const overlay = page.locator('#share-overlay');
  await expect(overlay).toHaveClass(/share-overlay--adding/, { timeout: 5000 });
  await assertOverlayFits(page);

  release();
  await expect(overlay).toHaveClass(/share-overlay--added/, { timeout: 6000 });
  // Long metadata is the case most likely to push the confirmation off-screen.
  await assertOverlayFits(page);
});

test('share launch: an error message fits the screen', async ({ page, context }) => {
  await fakeStandalone(context);
  await stubExternals(context, { resolver: 404 });

  await page.goto(`/?url=${encodeURIComponent(SPOTIFY_URL)}`, { waitUntil: 'commit' });

  await expect(page.locator('#share-overlay')).toHaveClass(/share-overlay--error/, { timeout: 6000 });
  await assertOverlayFits(page);
});
