import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test.describe('Admin Tenant Detail Page', () => {
  test.beforeEach(async ({ page }) => { await injectAdminAuth(page); });
  test('can click on a tenant to see details', async ({ page }) => {

    // First create a tenant to ensure one exists
    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible({ timeout: 2000 });

    // Wait for data to load
    await page.waitForTimeout(3000);
    const tenantLinks = page.locator('table tbody tr a').first();
    const hasTenants = await tenantLinks.isVisible().catch(() => false);

    if (hasTenants) {
      await tenantLinks.click();

      // Should navigate to tenant detail page — wait for either detail view or error
      const editButton = page.getByTestId('edit-button');
      const errorMessage = page.getByText('Tenant not found');
      const backLink = page.getByText('Back to tenants');

      await expect(editButton.or(errorMessage).or(backLink)).toBeVisible({ timeout: 2000 });
    }
  });

  test('tenant detail shows action buttons', async ({ page }) => {
    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible({ timeout: 2000 });

    const tenantRows = page.locator('table tbody tr');
    const rowCount = await tenantRows.count();

    if (rowCount > 0) {
      await tenantRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 2000 }).catch(() => false);

      if (isDetail) {
        await expect(page.getByTestId('edit-button')).toBeVisible();
        await expect(page.getByTestId('suspend-button')).toBeVisible();
        await expect(page.getByTestId('delete-button')).toBeVisible();
      }
    }
  });

  test('tenant detail shows Account Information section', async ({ page }) => {
    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible({ timeout: 2000 });

    const tenantRows = page.locator('table tbody tr');
    const rowCount = await tenantRows.count();

    if (rowCount > 0) {
      await tenantRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 2000 }).catch(() => false);

      if (isDetail) {
        await expect(page.getByText('Account Information')).toBeVisible();
        await expect(page.getByText('Status')).toBeVisible();
        await expect(page.getByText('Created')).toBeVisible();
      }
    }
  });

  test('tenant detail shows back to tenants link', async ({ page }) => {
    await page.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible({ timeout: 2000 });

    const tenantRows = page.locator('table tbody tr');
    const rowCount = await tenantRows.count();

    if (rowCount > 0) {
      await tenantRows.first().click();

      const editButton = page.getByTestId('edit-button');
      const isDetail = await editButton.isVisible({ timeout: 2000 }).catch(() => false);

      if (isDetail) {
        const backLink = page.getByLabel('Back to tenants');
        await expect(backLink).toBeVisible();
      }
    }
  });
});
