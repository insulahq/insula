import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 10_000,
  retries: 1,
  workers: 3,
  use: {
    headless: true,
    // The dev stack serves the panels HTTPS-only (Traefik websecure) with a
    // local-CA cert — plain :2010 http has been an unrouted 404 since the
    // Traefik cutover, so the defaults point at :2011 https.
    ignoreHTTPSErrors: true,
    actionTimeout: 2_000,
    navigationTimeout: 5_000,
  },
  expect: {
    timeout: 2_000,
  },
  projects: [
    {
      name: 'admin-setup',
      testMatch: 'auth.setup.ts',
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'https://admin.k8s-platform.test:2011',
      },
    },
    {
      name: 'admin',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'https://admin.k8s-platform.test:2011',
        storageState: 'e2e/.auth/admin.json',
      },
      testIgnore: ['**/tenant-panel-*', '**/auth.setup.ts'],
    },
    {
      name: 'tenant',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.TENANT_URL ?? 'https://tenant.k8s-platform.test:2011',
      },
      testMatch: '**/tenant-panel-*',
    },
  ],
});
