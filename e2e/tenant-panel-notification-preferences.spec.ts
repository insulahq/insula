import { test, expect } from '@playwright/test';
import { loginAsAdminTenant } from './helpers';

/**
 * Tenant-panel notification preferences. Verifies the per-Source ×
 * per-channel matrix and the settings form (quiet hours, digest mode,
 * timezone) which together back the tenant's self-service control
 * over the notification dispatcher.
 */

test.describe('Tenant — Notification Preferences', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminTenant(page);
    await page.goto('/notification-preferences');
    await expect(page.getByTestId('notification-prefs-heading')).toBeVisible({ timeout: 3_000 });
  });

  test('renders the preferences matrix with at least one source row', async ({ page }) => {
    // Any seeded source × channel cell exposes a stable testid.
    await expect(page.locator('[data-testid^="pref-"]').first()).toBeVisible({ timeout: 3_000 });
  });

  test('mandatory sources show the lock icon and disable the checkbox', async ({ page }) => {
    // tenant.suspended is mandatory (audience=tenant, contract basis).
    await expect(page.getByTestId('mandatory-tenant.suspended')).toBeVisible({ timeout: 3_000 });
    const inApp = page.getByTestId('pref-tenant.suspended-in_app');
    await expect(inApp).toBeDisabled();
  });

  test('Save button is disabled until a non-mandatory preference is toggled', async ({ page }) => {
    const save = page.getByTestId('save-preferences');
    await expect(save).toBeDisabled();
    // tasks.scheduled_failure is non-mandatory.
    await page.getByTestId('pref-tasks.scheduled_failure-email').click();
    await expect(save).toBeEnabled();
  });

  test('settings form persists quiet hours + digest mode', async ({ page }) => {
    await page.getByTestId('quiet-start').fill('22:00');
    await page.getByTestId('quiet-end').fill('07:00');
    await page.getByTestId('digest-mode').selectOption('daily');
    await page.getByTestId('save-settings').click();
    // Re-navigate; the persisted values should be picked up from GET.
    await page.goto('/notification-preferences');
    await expect(page.getByTestId('notification-prefs-heading')).toBeVisible();
    await expect(page.getByTestId('quiet-start')).toHaveValue('22:00');
    await expect(page.getByTestId('quiet-end')).toHaveValue('07:00');
    await expect(page.getByTestId('digest-mode')).toHaveValue('daily');
  });
});
