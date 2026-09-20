// The installable-app surface, checked against the production build: what
// Bubblewrap reads to package the TWA (manifest, icons, share target, asset
// links) and what makes it work offline (service worker).
import { test, expect } from '@playwright/test';
import { stubExternals } from '../tests/helpers.js';

test.describe('manifest', () => {
  test('declares what the Play Store TWA is built from', async ({ request }) => {
    const res = await request.get('/manifest.json');
    expect(res.status()).toBe(200);
    const m = await res.json();

    expect(m.id).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');

    // Android's adaptive icon mask crops the full-bleed badge, so the manifest
    // needs a dedicated maskable icon AND must not mark the badge as maskable.
    const purposes = m.icons.map((i) => i.purpose);
    expect(purposes).toContain('maskable');
    expect(m.icons.filter((i) => i.purpose === 'any maskable')).toEqual([]);
  });

  test('every icon it lists is actually served as a PNG', async ({ request }) => {
    const m = await (await request.get('/manifest.json')).json();
    for (const icon of m.icons) {
      const res = await request.get(`/${icon.src}`);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toMatch(/image\/png/);
    }
  });

  test('share_target is a GET on / using params the app reads', async ({ request }) => {
    const { share_target: st } = await (await request.get('/manifest.json')).json();
    expect(st.action).toBe('/');
    expect(st.method).toBe('GET');
    // app.js reads `text` and `url` from the launch URL (boot sequence).
    expect(st.params.text).toBe('text');
    expect(st.params.url).toBe('url');
  });
});

test('/.well-known/assetlinks.json ships in the build and names the app', async ({ request }) => {
  const res = await request.get('/.well-known/assetlinks.json');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/json/);
  const links = await res.json();
  const target = links.find((l) => l.target?.package_name === 'pl.gregolsky.groovepede')?.target;
  expect(target, 'no statement for pl.gregolsky.groovepede').toBeTruthy();
  expect(target.namespace).toBe('android_app');
  // Fingerprint *format* is deliberately not checked here — that is the
  // post-deploy smoke test's job; a local build may carry placeholders.
  expect(target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
});

test.describe('service worker', () => {
  test('takes control of the page', async ({ page, context }) => {
    await stubExternals(context);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // sw.js calls clients.claim() on activate, so control arrives without a reload.
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10_000 })
      .toBe(true);
  });

  test('renders the app shell with the network off', async ({ page, context }) => {
    await stubExternals(context);
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 10_000 })
      .toBe(true);

    // sw.js is network-first and only caches what it has seen, so one controlled
    // online load is what populates the cache with the hashed JS/CSS bundles.
    await page.reload();
    await expect(page.locator('.landing')).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.landing')).toBeVisible();
    await expect(page.locator('.landing-cta[data-action="toggle-add"]')).toBeVisible();
  });
});
