import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

/**
 * App-preview UI regression (2026-08-24): the admin Applications list shows a
 * Preview button on running deployments; clicking it opens the sandboxed
 * iframe modal and the proxied app actually renders inside it.
 *
 * Relies on a running deployment existing (the API E2E harness creates one);
 * skips cleanly on an empty cluster.
 */

test('admin Applications: Preview opens a sandboxed iframe of the running app', async ({ page }) => {
  test.setTimeout(120_000);
  await injectAdminAuth(page);
  await page.goto('/applications');
  // Deployment rows live under the Installed tab (default tab is Catalog).
  await page.getByTestId('tab-installed').click();

  const previewBtn = page.locator('[data-testid^="preview-btn-"]').first();
  const present = await previewBtn
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true, () => false);
  if (!present) {
    test.skip(true, 'no running deployment on this cluster — API E2E creates one');
    return;
  }
  await previewBtn.click();

  const modal = page.getByTestId('app-preview-modal');
  await expect(modal).toBeVisible();
  const iframe = page.getByTestId('app-preview-iframe');
  await expect(iframe).toBeVisible({ timeout: 20_000 });
  // The sandbox attribute must NOT include allow-same-origin — that's the
  // browser-side wall between tenant JS and the panel session.
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
  // The proxied app really renders (nginx welcome page from the E2E harness,
  // or any body text for other apps).
  const frame = page.frameLocator('[data-testid="app-preview-iframe"]');
  await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('app-preview-close').click();
  await expect(modal).not.toBeVisible();
});
