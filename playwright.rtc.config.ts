import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'rtc-datachannel.spec.ts',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3401',
    // TURN credentials are passed into the page; do not persist them in traces.
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium-rtc',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
