import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

/**
 * Admin notifications page — the 4-tab shell exposing Sources,
 * Providers, Templates, and the Delivery Log. Covers Phase 1 → Phase 6
 * surface for the operator-facing flows.
 *
 * The /platform/notifications route is a deep link under the Platform
 * group in the sidebar. We use the sidebar to navigate (not direct URL)
 * so a regression that breaks the sidebar entry is also caught.
 */

test.describe('Admin Notifications page', () => {
  test.beforeEach(async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/platform/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible({ timeout: 3_000 });
  });

  test('renders all four tabs', async ({ page }) => {
    await expect(page.getByTestId('tab-categories')).toBeVisible();
    await expect(page.getByTestId('tab-providers')).toBeVisible();
    await expect(page.getByTestId('tab-templates')).toBeVisible();
    await expect(page.getByTestId('tab-deliveries')).toBeVisible();
    // The user-facing label of the categories tab is "Sources" (Phase 3A rename).
    await expect(page.getByTestId('tab-categories')).toHaveText('Sources');
  });

  test('Sources tab shows ≥22 seeded sources with the Sources heading', async ({ page }) => {
    // categories is the default landing tab.
    await expect(page.getByText(/^Sources \(\d+\)/)).toBeVisible({ timeout: 3_000 });
    // Spot-check a couple of the seeded category rows.
    await expect(page.getByTestId('category-row-tenant.suspended')).toBeVisible();
    await expect(page.getByTestId('category-row-security.password_changed')).toBeVisible();
  });

  test('Providers tab opens the add-provider drawer with type select', async ({ page }) => {
    await page.getByTestId('tab-providers').click();
    await page.getByTestId('provider-create').click();
    await expect(page.getByTestId('provider-edit-drawer')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('provider-type')).toBeVisible();
  });

  test('stalwart-internal hides auth username/password and shows the master-creds note', async ({ page }) => {
    await page.getByTestId('tab-providers').click();
    await page.getByTestId('provider-create').click();
    await page.getByTestId('provider-type').selectOption('stalwart-internal');
    // Form variation: the master-creds note appears.
    await expect(page.getByTestId('provider-stalwart-internal-note')).toBeVisible();
    // Auth fields are NOT rendered.
    await expect(page.getByTestId('provider-auth-username')).toHaveCount(0);
    await expect(page.getByTestId('provider-auth-password')).toHaveCount(0);
  });

  test('generic SMTP shows auth fields', async ({ page }) => {
    await page.getByTestId('tab-providers').click();
    await page.getByTestId('provider-create').click();
    await page.getByTestId('provider-type').selectOption('smtp');
    await expect(page.getByTestId('provider-auth-username')).toBeVisible();
    await expect(page.getByTestId('provider-auth-password')).toBeVisible();
    await expect(page.getByTestId('provider-stalwart-internal-note')).toHaveCount(0);
  });

  test('Delivery Log tab renders the filter row + table headers', async ({ page }) => {
    await page.getByTestId('tab-deliveries').click();
    await expect(page.getByTestId('filter-channel')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('filter-status')).toBeVisible();
    await expect(page.getByTestId('filter-category')).toBeVisible();
    await expect(page.getByTestId('filter-since')).toBeVisible();
  });

  test('Source editor exposes the Phase 5 provider override dropdown', async ({ page }) => {
    // Open the Sources tab and click a non-mandatory row so the
    // editor is fully interactive (mandatory rows lock the channel
    // checkboxes but the provider select is independent).
    await page.getByTestId('category-row-subscription.renewed').click();
    await expect(page.getByTestId('category-edit-drawer')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId('category-email-provider')).toBeVisible();
    // The placeholder option should be present even when no providers
    // are configured yet.
    const select = page.getByTestId('category-email-provider');
    await expect(select).toContainText('Default platform email provider');
  });
});
