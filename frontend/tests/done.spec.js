import { test, expect } from '@playwright/test';
import { stubExternals, seedAlbums, loginAs } from './helpers.js';

const ALBUMS = [
  { id: 'a1', title: 'Kind of Blue',  artist: 'Miles Davis',    url: '', cover: null, year: '1959', tags: [], addedAt: new Date().toISOString() },
  { id: 'a2', title: 'Blue Lines',    artist: 'Massive Attack', url: '', cover: null, year: '1991', tags: [], addedAt: new Date().toISOString() },
  { id: 'a3', title: 'Nevermind',     artist: 'Nirvana',        url: '', cover: null, year: '1991', tags: [], addedAt: new Date().toISOString() },
];

async function seedWithAlbums(context, albums = ALBUMS) {
  await seedAlbums(context, albums);
  await loginAs(context);
  await stubExternals(context, { resolver: null });
}

// ── Done from list view ───────────────────────────────────────────────────────

test('clicking Done in list view marks the album done without opening explore', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);

  await page.click('[data-action="done"][data-index="0"]');

  // Wait for the 550 ms flash animation + applyDone rerender
  await page.waitForTimeout(700);

  // The explore overlay must NOT have opened
  await expect(page.locator('.explore')).toHaveCount(0);

  // Two cards remain (the Done'd album was removed)
  await expect(page.locator('.card')).toHaveCount(2);

  // The remaining cards should be the other two albums (not the done one)
  await expect(page.locator('.card-title').nth(0)).toContainText('Blue Lines');
  await expect(page.locator('.card-title').nth(1)).toContainText('Nevermind');
});

// ── Done from explore view (regression guard) ─────────────────────────────────

test('clicking Done inside explore mode removes the album and shows the next one', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  // Open explore for the first album
  await page.locator('.card').first().click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.explore')).toBeVisible();
  await expect(page.locator('.explore-album-title')).toContainText('Kind of Blue');

  // Click Done inside explore
  await page.click('.explore [data-action="explore-done"]');

  // Explore should still be open after 700 ms (showing next album)
  await page.waitForTimeout(700);
  await expect(page.locator('.explore')).toBeVisible();
  await expect(page.locator('.explore-album-title')).toContainText('Blue Lines');
});
