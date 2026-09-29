import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    // The e2e container shares the app container's network namespace, so
    // localhost is the app and counts as a secure context.
    baseURL: process.env.BASE_URL ?? 'http://localhost:8080',
    acceptDownloads: true,
    launchOptions: {
      args: [
        // Expose real host candidates so two pages in the container can connect.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--enable-precise-memory-info',
      ],
    },
  },
});
