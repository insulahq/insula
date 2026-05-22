import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 10_000,
  retries: 1,
  workers: 3,
  use: {
    headless: true,
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
        baseURL: process.env.BASE_URL ?? 'http://admin.k8s-platform.test:2010',
      },
    },
    {
      name: 'admin',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'http://admin.k8s-platform.test:2010',
        storageState: 'e2e/.auth/admin.json',
      },
      testIgnore: ['**/tenant-panel-*', '**/auth.setup.ts'],
    },
    {
      name: 'tenant',
      dependencies: ['admin-setup'],
      use: {
        browserName: 'chromium',
        baseURL: process.env.TENANT_URL ?? 'http://tenant.k8s-platform.test:2010',
      },
      testMatch: '**/tenant-panel-*',
    },
  ],
});
