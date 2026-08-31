import { defineConfig } from '@playwright/test';

// Post-deploy smoke suite — opens the REAL production site (or SMOKE_BASE_URL)
// and clicks through it. Deliberately separate from playwright.config.js:
// that one has an unconditional webServer (boots `npm run dev`) and is what
// `npm test` runs on every PR. This config has no webServer, hits real
// network, and only runs after a deploy (see .github/workflows/deploy.yml).
export default defineConfig({
  testDir: './tests-smoke',
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'https://groovepede.gregolsky.pl',
    trace: 'retain-on-failure',
  },
  fullyParallel: false,
  workers: 1, // the resolver is a home Raspberry Pi — don't hammer it in parallel
  retries: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report-smoke', open: 'never' }]],
  timeout: 60_000, // real network, real page-fetch + extraction round-trips
});
