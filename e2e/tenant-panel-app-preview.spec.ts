import { test, expect } from '@playwright/test';
import { loginAsAdminTenant } from './helpers';

/**
 * Tenant-panel app preview (2026-08-24): running deployments show a Preview
 * button (installed apps cards + custom containers tab) that opens the
 * sandboxed iframe modal. Skips when the shared E2E tenant has no running
 * deployment — the modal itself is the same component the admin-panel spec
 * exercises against a live app.
 */

test('tenant Applications: Preview button opens the sandboxed preview modal', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAsAdminTenant(page);
  await page.goto('/applications');

  const anyPreview = page.locator('[data-testid^="preview-app-"], [data-testid^="custom-preview-"]').first();
  const present = await anyPreview
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true, () => false);
  if (!present) {
    test.skip(true, 'shared tenant has no running deployment — admin spec covers the live modal');
    return;
  }
  await anyPreview.click();
  await expect(page.getByTestId('app-preview-modal')).toBeVisible();
  await expect(page.getByTestId('app-preview-iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-forms', { timeout: 20_000 });
  await page.getByTestId('app-preview-close').click();
  await expect(page.getByTestId('app-preview-modal')).not.toBeVisible();
});
