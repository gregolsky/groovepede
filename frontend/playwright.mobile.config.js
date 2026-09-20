import { defineConfig, devices } from '@playwright/test';

// Mobile device suite — `npm run test:mobile`. Emulated phones (real viewport,
// DPR, touch, mobile UA) against the PRODUCTION build served by `vite preview`,
// not the dev server: the service worker, the manifest and .well-known/ only
// behave like the real thing once built. Third-party hosts are stubbed exactly
// as in the e2e suite (tests/helpers.js), so it needs no network.
//
// Separate from playwright.config.js on purpose: that one boots the dev server
// and is what `npm test` runs on every PR.
//
// The iPhone (WebKit) project is opt-in: WebKit needs system libraries that not
// every machine has (`sudo npx playwright install-deps webkit`). Enable it with
// MOBILE_WEBKIT=1 once that is set up.
const PORT = 4173;

const projects = [
  { name: 'pixel-7',      use: { ...devices['Pixel 7'] } },
  { name: 'galaxy-s9',    use: { ...devices['Galaxy S9+'] } },
];
if (process.env.MOBILE_WEBKIT) {
  projects.push({ name: 'iphone-14', use: { ...devices['iPhone 14'] } });
}

export default defineConfig({
  testDir: './tests-mobile',
  projects,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-mobile', open: 'never' }]],
});
