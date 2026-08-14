import { test, expect } from '@playwright/test';

const KEYS = {
  TOKEN:  'gp_token',
  EXPIRY: 'gp_expiry',
  ALBUMS: 'gp_albums',
};

const ALBUMS = [
  { id: 'a1', title: 'Kind of Blue', artist: 'Miles Davis',
    url: '', cover: null, year: '1959', tags: ['jazz'], addedAt: new Date().toISOString() },
  { id: 'a2', title: 'Blue Lines', artist: 'Massive Attack',
    url: '', cover: null, year: '1991', tags: ['trip-hop'], addedAt: new Date().toISOString() },
  { id: 'a3', title: 'Revolver', artist: 'The Beatles',
    url: '', cover: null, year: '1966', tags: ['rock'], addedAt: new Date().toISOString() },
];

async function seedWithAlbums(context, albums = ALBUMS) {
  await context.addInitScript(({ keys, albums }) => {
    localStorage.setItem(keys.TOKEN,  'valid_token');
    localStorage.setItem(keys.EXPIRY, String(Date.now() + 3600000));
    localStorage.setItem(keys.ALBUMS, JSON.stringify(albums));
  }, { keys: KEYS, albums });

  await context.route('https://api.spotify.com/v1/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ display_name: 'Test User', images: [] }),
    })
  );
}

// ── Search filtering ──────────────────────────────────────────────────────────

test('typing a query hides non-matching cards', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();
  await expect(page.locator('.card')).toHaveCount(3);

  await page.fill('#search-input', 'blue');

  await expect(page.locator('.card')).toHaveCount(2);
  await expect(page.locator('.card-title').nth(0)).toContainText('Kind of Blue');
  await expect(page.locator('.card-title').nth(1)).toContainText('Blue Lines');
});

test('search matches artist name', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'beatles');

  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card-title')).toContainText('Revolver');
});

test('search is case-insensitive', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'MILES');

  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card-title')).toContainText('Kind of Blue');
});

test('query with no matches shows empty state with clear button', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'zzznomatch');

  await expect(page.locator('.card')).toHaveCount(0);
  await expect(page.locator('.empty')).toBeVisible();
  await expect(page.locator('.empty-clear')).toBeVisible();
});

// ── Highlight ─────────────────────────────────────────────────────────────────

test('matching substring is wrapped in .hl mark', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'blue');

  const firstTitle = page.locator('.card-title').first();
  await expect(firstTitle.locator('mark.hl')).toBeVisible();
  await expect(firstTitle.locator('mark.hl')).toHaveText('Blue');
});

// ── Clear search ──────────────────────────────────────────────────────────────

test('× button clears search and restores full list', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'blue');
  await expect(page.locator('.card')).toHaveCount(2);

  await page.click('[data-action="clear-search"]');
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('#search-input')).toHaveValue('');
});

test('clear-search from empty-state button restores full list', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.fill('#search-input', 'zzznomatch');
  await expect(page.locator('.card')).toHaveCount(0);

  await page.click('[data-action="clear-search"]');
  await expect(page.locator('.card')).toHaveCount(3);
});

// ── AND with tag filter ───────────────────────────────────────────────────────

test('search ANDs with active tag filter', async ({ page, context }) => {
  // Two albums share "blue" in title but have different tags
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  // Activate "jazz" tag chip — should narrow to Kind of Blue only
  await page.click('[data-tag="jazz"]');
  await expect(page.locator('.card')).toHaveCount(1);

  // Now also search "blue" — intersection is still just Kind of Blue
  await page.fill('#search-input', 'blue');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(page.locator('.card-title')).toContainText('Kind of Blue');
});

test('tag filter AND search with no intersection shows empty state', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-tag="jazz"]');
  await page.fill('#search-input', 'beatles');

  await expect(page.locator('.card')).toHaveCount(0);
  await expect(page.locator('.empty')).toBeVisible();
});

// ── Tag bar collapse / More-Less toggle ───────────────────────────────────────

// Build 8 albums each with a unique tag so the tag bar has >7 tags → More button appears
function manyTagAlbums() {
  const tags = ['jazz', 'rock', 'pop', 'metal', 'folk', 'blues', 'soul', 'reggae'];
  return tags.map((tag, i) => ({
    id: `tag${i}`, title: `Album ${i}`, artist: `Artist ${i}`,
    url: '', cover: null, year: '2020', tags: [tag], addedAt: new Date().toISOString(),
  }));
}

test('tag bar shows More button when more than 7 tags', async ({ page, context }) => {
  await seedWithAlbums(context, manyTagAlbums());
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await expect(page.locator('[data-action="toggle-tags"]')).toBeVisible();
  // Only 6 tag chips visible by default (plus "All")
  await expect(page.locator('.filter-chip:not([data-tag="all"])')).toHaveCount(6);
});

test('More button expands to show all tags', async ({ page, context }) => {
  await seedWithAlbums(context, manyTagAlbums());
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-tags"]');

  await expect(page.locator('.filter-chip:not([data-tag="all"])')).toHaveCount(8);
  await expect(page.locator('[data-action="toggle-tags"]')).toContainText('Less');
});

test('Less button collapses back to 6 tags', async ({ page, context }) => {
  await seedWithAlbums(context, manyTagAlbums());
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-tags"]');
  await expect(page.locator('[data-action="toggle-tags"]')).toContainText('Less');

  await page.click('[data-action="toggle-tags"]');
  await expect(page.locator('.filter-chip:not([data-tag="all"])')).toHaveCount(6);
  await expect(page.locator('[data-action="toggle-tags"]')).toContainText('More');
});

test('no More button when 7 or fewer tags', async ({ page, context }) => {
  await seedWithAlbums(context); // 3 albums → 3 tags
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await expect(page.locator('[data-action="toggle-tags"]')).not.toBeVisible();
});

// ── Active tag pinned in collapsed view ───────────────────────────────────────

test('active tag outside top-6 is pinned into collapsed bar', async ({ page, context }) => {
  // 8 unique tags; activate the 8th one (reggae) which won't be in the top-6 by frequency
  const albums = manyTagAlbums();
  await seedWithAlbums(context, albums);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  // Expand first to reach the 8th tag, then click it
  await page.click('[data-action="toggle-tags"]');
  await page.click('[data-tag="reggae"]');

  // Now collapse — reggae should still be visible as the pinned slot
  await page.click('[data-action="toggle-tags"]');
  await expect(page.locator('[data-action="toggle-tags"]')).toContainText('More');
  await expect(page.locator('.filter-chip[data-tag="reggae"]')).toBeVisible();
  await expect(page.locator('.filter-chip:not([data-tag="all"])')).toHaveCount(6);
});

// ── Inline Add reveal ─────────────────────────────────────────────────────────

test('+ Add button reveals the url input', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await expect(page.locator('#url-input')).not.toBeVisible();
  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();
});

test('clicking + Add again hides the url input', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).not.toBeVisible();
});

test('Esc closes the add reveal', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  await page.click('[data-action="toggle-add"]');
  await expect(page.locator('#url-input')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#url-input')).not.toBeVisible();
});

test('+ Add button gets active style when reveal is open', async ({ page, context }) => {
  await seedWithAlbums(context);
  await page.goto('/');
  await expect(page.locator('.stats')).toBeVisible();

  const btn = page.locator('[data-action="toggle-add"]');
  await expect(btn).not.toHaveClass(/active/);
  await btn.click();
  await expect(btn).toHaveClass(/active/);
});
