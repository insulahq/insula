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

/**
 * Regression (2026-08-25): the panels' SPA asset-cache regex location
 * (`~* \.(js|css|...)$`) used to OUTRANK the plain `/api/` prefix
 * location, so preview-proxied asset paths like
 * /api/v1/preview/<token>/styles.css were 404'd by the PANEL nginx and
 * previewed sites rendered with no CSS/JS. With `^~` on the API
 * locations, asset-suffixed API paths must reach platform-api — whose
 * preview handler answers 403 (bad token) WITH the sandbox CSP header.
 */
test('asset-suffixed preview paths reach the API proxy, not the SPA asset location', async ({ request, baseURL }) => {
  for (const path of ['/api/v1/preview/garbage/x.css', '/api/v1/preview/garbage/sub/app.js', '/api/v1/preview/garbage/logo.png']) {
    const resp = await request.get(`${baseURL}${path}`);
    expect(resp.status(), path).toBe(403);
    expect(resp.headers()['content-security-policy'], path).toContain('sandbox');
  }
});
