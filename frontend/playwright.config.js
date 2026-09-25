import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Each worker is a headless Chromium; the default (half the cores) peaked at
  // ~6 of 8 cores locally, starving everything else on the machine. The tests
  // mostly wait on the app's own timers, so 2 workers costs little wall time.
  workers: process.env.CI ? undefined : 2,
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
