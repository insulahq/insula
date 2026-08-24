import { test, expect } from '@playwright/test';
import { injectAdminAuth } from './helpers';

test('DR → Secrets Bundle shows the operator-key loss-recovery note', async ({ page }) => {
  await injectAdminAuth(page);
  await page.goto('/backups/disaster-recovery');
  const tab = page.getByRole('tab', { name: /Secrets Bundle/i }).first();
  await tab.click();
  const note = page.getByTestId('operator-key-loss-note');
  await expect(note).toBeVisible({ timeout: 10_000 });
  await expect(note).toContainText('insula operator-key rotate');
  await expect(note).toContainText('before');
});
