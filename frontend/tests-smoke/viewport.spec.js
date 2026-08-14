// Post-deploy viewport-overflow check. Companion to smoke.spec.js — same
// config, same "run after deploy" trigger. Checks the fix landed in
// 74e8bb8 (Pixel 8 Pro overflow) stays landed, across the widths that have
// mattered historically, in both the empty-queue and populated states.
import { test, expect } from '@playwright/test';
import { overflowReport, seedAlbums } from './helpers.js';

const VIEWPORTS = [
  { name: 'narrow-360', width: 360, height: 800 },
  { name: 'pixel-8-pro', width: 412, height: 915 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'landing-logo-rings-1100', width: 1100, height: 800 },
  { name: 'desktop-1280', width: 1280, height: 800 },
];

function assertNoOverflow(report) {
  expect(report.wide, `overflowing elements: ${report.wide.join(', ')}`).toEqual([]);
  expect(report.scrollWidth).toBeLessThanOrEqual(report.clientWidth + 1);
}

for (const { name, width, height } of VIEWPORTS) {
  test(`${name} (${width}x${height}): landing fits, no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.locator('.landing')).toBeVisible();
    assertNoOverflow(await overflowReport(page));
  });

  test(`${name} (${width}x${height}): populated queue with tag bar expanded fits`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await seedAlbums(page);
    await page.goto('/');
    await expect(page.locator('.card')).toHaveCount(6);

    // Expanded tag bar lays out the widest row (all 9 chips), the collapsed
    // default (top 6) would hide the overflow this is meant to catch.
    const moreToggle = page.locator('[data-action="toggle-tags"]');
    if (await moreToggle.isVisible()) await moreToggle.click();

    assertNoOverflow(await overflowReport(page));
  });
}

test('body overflow-x is not clipped (mask must stay off)', async ({ page }) => {
  // Removed deliberately in 74e8bb8 so future overflow fails loudly instead
  // of being silently clipped. If this ever comes back, every assertion
  // above goes quiet without this check.
  await page.goto('/');
  const overflowX = await page.evaluate(() => getComputedStyle(document.body).overflowX);
  expect(overflowX).not.toBe('hidden');
});
