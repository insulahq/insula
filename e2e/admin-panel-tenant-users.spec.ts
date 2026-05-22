import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { injectAdminAuth } from './helpers';

const ARTIFACTS_DIR = path.join(__dirname, '..', 'test-artifacts');

// Resolve an existing tenant ID dynamically — the prior hardcoded UUID
// doesn't exist in every environment. Prefer the e2e-test tenant that
// helpers.ts creates (it's guaranteed to have a tenant_admin user), fall
// back to the first tenant in the list.
async function resolveTenantId(): Promise<string> {
  const API_BASE = process.env.API_URL ?? 'http://admin.k8s-platform.test:2010';
  const authPath = path.join(__dirname, '.auth/admin-auth.json');
  const adminAuth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  const res = await fetch(`${API_BASE}/api/v1/tenants?limit=100`, {
    headers: { 'Authorization': `Bearer ${adminAuth.token}` },
  });
  const body = await res.json() as { data: { id: string; companyEmail: string }[] };
  const e2eTenant = body.data?.find((c) => c.companyEmail === 'e2e-test@k8s-platform.test');
  const tenantId = e2eTenant?.id ?? body.data?.[0]?.id;
  if (!tenantId) throw new Error('No tenants exist — cannot resolve a tenant id for this test');
  return tenantId;
}

test.describe('Admin Panel — Tenant Users Tab (Phase 5)', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    const tenantId = await resolveTenantId();
    await page.goto(`/tenants/${tenantId}`);
    // Wait for the page to settle — the tenant detail page has multiple tabs
    await expect(page.getByTestId('resource-tabs')).toBeVisible({ timeout: 5000 });
  });

  test('Users tab is present in the tab bar and navigates to the users view', async ({ page }) => {
    const usersTabBtn = page.getByTestId('tab-users');
    await expect(usersTabBtn).toBeVisible();
    await expect(usersTabBtn).toContainText('Users');

    await usersTabBtn.click();

    // The TenantUsersTab wrapper must appear
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-tab-loaded.png'),
      fullPage: false,
    });
  });

  test('users table renders with existing users', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    // The tenant has 3+ users from prior phase testing — table must be visible
    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    // At least one row should exist in tbody
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-table-populated.png'),
      fullPage: false,
    });
  });

  test('Add User button is visible on the Users tab', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    const addButton = page.getByTestId('tenant-users-add-button');
    await expect(addButton).toBeVisible();
    await expect(addButton).toContainText('Add User');
  });

  test('clicking Add User opens the create form with all required fields', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    await page.getByTestId('tenant-users-add-button').click();

    const form = page.getByTestId('tenant-users-create-form');
    await expect(form).toBeVisible({ timeout: 2000 });

    // All required inputs must be present
    await expect(page.getByTestId('tenant-users-name-input')).toBeVisible();
    await expect(page.getByTestId('tenant-users-email-input')).toBeVisible();
    await expect(page.getByTestId('tenant-users-password-input')).toBeVisible();
    await expect(page.getByTestId('tenant-users-role-select')).toBeVisible();
    await expect(page.getByTestId('tenant-users-submit')).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-create-form-open.png'),
      fullPage: false,
    });
  });

  test('clicking the Add User toggle button again (Cancel) closes the create form', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    // Open the form
    await page.getByTestId('tenant-users-add-button').click();
    await expect(page.getByTestId('tenant-users-create-form')).toBeVisible({ timeout: 2000 });

    // The button now acts as a Cancel toggle — clicking it again closes the form
    await page.getByTestId('tenant-users-add-button').click();
    await expect(page.getByTestId('tenant-users-create-form')).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-create-form-closed.png'),
      fullPage: false,
    });
  });

  test('edit button on first user opens the edit modal with pre-filled name', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    // Wait for the table to be populated
    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    // Get the id from the first edit button via its data-testid attribute
    const firstEditBtn = table.locator('[data-testid^="tenant-users-edit-"]').first();
    await expect(firstEditBtn).toBeVisible();

    // Read the user's name from the table row for cross-check
    const firstRow = table.locator('tbody tr').first();
    const userName = await firstRow.locator('td').first().textContent();

    await firstEditBtn.click();

    const editModal = page.getByTestId('tenant-users-edit-modal');
    await expect(editModal).toBeVisible({ timeout: 2000 });

    // The name input should be pre-filled with the user's current name
    const nameInput = page.getByTestId('tenant-users-edit-name-input');
    await expect(nameInput).toBeVisible();
    if (userName) {
      await expect(nameInput).toHaveValue(userName.trim());
    }

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-edit-modal-open.png'),
      fullPage: false,
    });
  });

  test('Cancel button in the edit modal closes it without submitting', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    await table.locator('[data-testid^="tenant-users-edit-"]').first().click();
    const editModal = page.getByTestId('tenant-users-edit-modal');
    await expect(editModal).toBeVisible({ timeout: 2000 });

    // Click Cancel inside the modal (the button labelled "Cancel")
    await editModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(editModal).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-edit-modal-closed.png'),
      fullPage: false,
    });
  });

  test('reset password button opens the reset modal for the correct user', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    const firstResetBtn = table.locator('[data-testid^="tenant-users-reset-"]').first();
    await expect(firstResetBtn).toBeVisible();
    await firstResetBtn.click();

    const resetModal = page.getByTestId('tenant-users-reset-modal');
    await expect(resetModal).toBeVisible({ timeout: 2000 });

    // Modal should contain the password inputs
    await expect(page.getByTestId('tenant-users-reset-new-input')).toBeVisible();
    await expect(page.getByTestId('tenant-users-reset-confirm-input')).toBeVisible();
    await expect(page.getByTestId('tenant-users-reset-save')).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-reset-modal-open.png'),
      fullPage: false,
    });
  });

  test('Cancel button in the reset modal closes it without submitting', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    await table.locator('[data-testid^="tenant-users-reset-"]').first().click();
    const resetModal = page.getByTestId('tenant-users-reset-modal');
    await expect(resetModal).toBeVisible({ timeout: 2000 });

    await resetModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(resetModal).not.toBeVisible({ timeout: 2000 });

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, 'tenant-users-reset-modal-closed.png'),
      fullPage: false,
    });
  });

  test('each table row shows edit, reset-password, toggle, and delete action buttons', async ({ page }) => {
    await page.getByTestId('tab-users').click();
    await expect(page.getByTestId('tenant-users-tab')).toBeVisible({ timeout: 3000 });

    const table = page.getByTestId('tenant-users-table');
    await expect(table).toBeVisible({ timeout: 4000 });

    const firstRow = table.locator('tbody tr').first();
    const editBtn = firstRow.locator('[data-testid^="tenant-users-edit-"]');
    const resetBtn = firstRow.locator('[data-testid^="tenant-users-reset-"]');
    const toggleBtn = firstRow.locator('[data-testid^="tenant-users-toggle-"]');
    const deleteBtn = firstRow.locator('[data-testid^="tenant-users-delete-"]');

    await expect(editBtn).toBeVisible();
    await expect(resetBtn).toBeVisible();
    await expect(toggleBtn).toBeVisible();
    await expect(deleteBtn).toBeVisible();
  });
});
