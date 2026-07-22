import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'product-transfer.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8787',
    // Ephemeral TURN credentials are injected into the page for this test.
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium-product-transfer',
      use: { browserName: 'chromium' },
    },
  ],
});
