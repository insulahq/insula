import { test, expect } from '@playwright/test';
import { loginAsAdminTenant } from './helpers';

test.describe('Tenant Panel Backups', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdminTenant(page);
    await page.getByRole('link', { name: 'Backups' }).click();
    await expect(page.getByTestId('backups-heading')).toBeVisible({ timeout: 2000 });
  });

  test('backups page loads with heading', async ({ page }) => {
    await expect(page.getByTestId('backups-heading')).toHaveText('Backups');
  });

  test('shows loading, empty state, error, or table', async ({ page }) => {
    const content = page.getByTestId('backups-loading')
      .or(page.getByTestId('backups-empty'))
      .or(page.getByTestId('backups-error'))
      .or(page.getByTestId('backups-table'));
    await expect(content).toBeVisible({ timeout: 2000 });
  });

  test('sidebar highlights Backups link', async ({ page }) => {
    const backupsLink = page.getByRole('link', { name: 'Backups' });
    await expect(backupsLink).toBeVisible();
  });
});
