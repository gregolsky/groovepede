// Touch behaviour on phones: tap-target sizes, and the core flows driven with
// real taps (`tap()` dispatches touch events; `click()` would not).
import { test, expect } from '@playwright/test';
import { stubExternals, seedAlbums, makeAlbumResponse, SPOTIFY_URL } from '../tests/helpers.js';
import { WIDE_TAG_ALBUMS } from '../tests-lib/albums.js';

// WCAG 2.2 AA "Target Size (Minimum)", SC 2.5.8, is 24x24 CSS px. That is the
// hard gate. Inline text targets are exempt from it, so <span data-action> tag
// chips inside a card are not gated.
//
// The ideal is 44x44 (Apple HIG / WCAG 2.5.5 AAA). The app does not meet it
// today — most buttons are 28-32 px tall — so it is REPORTED, not enforced: a
// test that is red forever gets ignored. Raise MIN_ENFORCED to 44 once the
// controls are resized and the annotation below comes back empty.
const MIN_ENFORCED = 24;
const MIN_IDEAL = 44;

async function measureTargets(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-action]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: `${el.tagName.toLowerCase()}[${el.dataset.action}]`,
          inline: el.tagName === 'SPAN',
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
  );
}

test('tap targets meet WCAG 2.5.8; sub-44px ones are reported', async ({ page, context }, testInfo) => {
  await stubExternals(context);
  await seedAlbums(context, WIDE_TAG_ALBUMS, 2);
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(6);

  const targets = await measureTargets(page);
  expect(targets.length, 'found no tap targets — selector drifted?').toBeGreaterThan(0);

  const tooSmall = targets.filter((t) => !t.inline && (t.w < MIN_ENFORCED || t.h < MIN_ENFORCED));
  expect(tooSmall, `targets under ${MIN_ENFORCED}px: ${JSON.stringify(tooSmall)}`).toEqual([]);

  const belowIdeal = new Map();
  for (const t of targets.filter((t) => t.w < MIN_IDEAL || t.h < MIN_IDEAL)) {
    const k = `${t.label} ${t.w}x${t.h}`;
    belowIdeal.set(k, (belowIdeal.get(k) || 0) + 1);
  }
  if (belowIdeal.size) {
    testInfo.annotations.push({
      type: `below-${MIN_IDEAL}px`,
      description: [...belowIdeal].map(([k, n]) => `${k} x${n}`).join('; '),
    });
  }
});

test('profile opens and closes by tap', async ({ page, context }) => {
  await stubExternals(context);
  await seedAlbums(context, WIDE_TAG_ALBUMS, 2);
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(6);

  await page.locator('[data-action="open-profile"]').tap();
  await expect(page.locator('.profile')).toBeVisible();
  await page.locator('[data-action="close-profile"]').tap();
  await expect(page.locator('.profile')).not.toBeVisible();
});

test('tag chips filter and the More toggle expands, by tap', async ({ page, context }) => {
  await stubExternals(context);
  await seedAlbums(context, WIDE_TAG_ALBUMS, 2);
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(6);

  await page.locator('.filter-chip[data-tag="ambient"]').tap();
  await expect(page.locator('.card')).toHaveCount(1);
  await page.locator('.filter-chip[data-tag="all"]').tap();
  await expect(page.locator('.card')).toHaveCount(6);

  const more = page.locator('[data-action="toggle-tags"]');
  await more.tap();
  await expect(more).toHaveText(/Less/);
  await expect(page.locator('.filter-chip[data-tag="jazz"]')).toBeVisible();
});

test('marking an album done by tap removes it from the queue', async ({ page, context }) => {
  await stubExternals(context);
  await seedAlbums(context, WIDE_TAG_ALBUMS, 2);
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(6);

  await page.locator('[data-action="done"]').first().tap();
  await expect(page.locator('.card')).toHaveCount(5, { timeout: 5000 });
});

test('adding an album by pasting a link works with taps', async ({ page, context }) => {
  await stubExternals(context, { resolver: makeAlbumResponse({ title: 'Tapped In', artist: 'Touch Artist' }) });
  await page.goto('/');

  await page.locator('.landing-cta[data-action="toggle-add"]').tap();
  await page.locator('#url-input').fill(SPOTIFY_URL);
  await page.locator('[data-action="add"]').tap();

  await expect(page.locator('.card .card-title')).toHaveText('Tapped In');
  await expect(page.locator('.card--pending')).toHaveCount(0);
});
