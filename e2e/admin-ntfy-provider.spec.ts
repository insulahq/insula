import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

/**
 * ntfy provider UI (2026-08-25): the Providers tab offers the "ntfy push"
 * type with its own field set (server URL, topic, auth method) and hides
 * the SMTP-only fields, and the per-source channel toggles include ntfy.
 */

test('Notifications → Providers: ntfy type renders its field set', async ({ page }) => {
  await injectAdminAuth(page);
  await page.goto('/platform/notifications?tab=providers');
  const createBtn = page.getByTestId('provider-create');
  await createBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await createBtn.click();

  const drawer = page.getByTestId('provider-edit-drawer');
  await expect(drawer).toBeVisible();
  await page.getByTestId('provider-type').selectOption('ntfy');

  await expect(page.getByTestId('provider-ntfy-server-url')).toBeVisible();
  await expect(page.getByTestId('provider-ntfy-server-url')).toHaveValue('https://ntfy.sh');
  await expect(page.getByTestId('provider-ntfy-topic')).toBeVisible();
  await expect(page.getByTestId('provider-ntfy-auth-method')).toBeVisible();
  // SMTP-only fields hidden for ntfy.
  await expect(page.getByTestId('provider-smtp-host')).not.toBeVisible();
  await expect(page.getByTestId('provider-from-address')).not.toBeVisible();
  // Token field appears when token auth is picked.
  await page.getByTestId('provider-ntfy-auth-method').selectOption('token');
  await expect(page.getByTestId('provider-ntfy-token')).toBeVisible();
});

test('Notifications → Sources: category editor offers the ntfy channel toggle', async ({ page }) => {
  await injectAdminAuth(page);
  await page.goto('/platform/notifications');
  const row = page.locator('[data-testid^="category-row-"]').first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId('category-edit-drawer')).toBeVisible();
  await expect(page.getByTestId('channel-checkbox-ntfy')).toBeVisible();
  await expect(page.getByTestId('channel-checkbox-email')).toBeVisible();
});
