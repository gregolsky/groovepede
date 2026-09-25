import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Each worker is a headless Chromium; the default (half the cores) peaked at
  // ~6 of 8 cores locally, starving everything else on the machine. The tests
  // mostly wait on the app's own timers, so 2 workers costs little wall time.
  workers: process.env.CI ? undefined : 2,
  use: {
    baseURL: 'http://localhost:5173',
    // Every scripted animation (entrance, card fades, slide transitions) sits
    // under @media (prefers-reduced-motion: no-preference) in style.css. No
    // spec asserts on those classes; turning them off cuts compositor work on
    // every run without changing what a test can observe.
    reducedMotion: 'reduce',
  },
  webServer: {
    // e2e mode scales THROTTLE's minIntervalMs down (config.js) — every
    // remote host is stubbed in tests, so pacing against a real-world rate
    // limit only slows the suite down for nothing.
    command: 'npm run dev -- --mode e2e',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
