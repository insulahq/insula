import { test, expect, type Page } from '@playwright/test';
import { loginAsAdminTenant, ensureSharedEmailDomain } from './helpers';

/**
 * Send-only accounts + per-mailbox forwarding — real-browser flow over the
 * tenant panel (create form type selector, row badges, edit-modal forwarding
 * panel, send-only affordance hiding).
 *
 * Prerequisite (like the other email specs): the shared E2E tenant has at
 * least one email-enabled domain. The suite creates its mailboxes through
 * the REAL form and cleans them up through the REAL delete buttons.
 */


test.use({ ignoreHTTPSErrors: true });

const STAMP = Date.now().toString(36);
const SO_LOCAL = `no-reply-${STAMP}`;
const FWD_LOCAL = `fwd-ui-${STAMP}`;

async function openMailboxesTab(page: Page): Promise<void> {
  await page.goto('/email');
  await expect(page.getByTestId('add-mailbox-button')).toBeVisible({ timeout: 10_000 });
}

async function deleteMailboxRow(page: Page, localPart: string): Promise<void> {
  const row = page.locator('tr', { hasText: localPart });
  if ((await row.count()) === 0) return;
  await row.first().locator('[data-testid^="delete-mailbox-"]').click();
  await row.first().getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('tr', { hasText: localPart })).toHaveCount(0, { timeout: 10_000 });
}

test.describe('send-only accounts + forwarding (tenant panel)', () => {
  test.beforeAll(async () => {
    await ensureSharedEmailDomain();
  });

  test('create form: selecting Send-only hides the quota field', async ({ page }) => {
    await loginAsAdminTenant(page);
    await openMailboxesTab(page);
    await page.getByTestId('add-mailbox-button').click();
    await expect(page.getByTestId('mailbox-type')).toBeVisible();
    await expect(page.getByTestId('mailbox-quota')).toBeVisible();
    await page.getByTestId('mailbox-type').selectOption('send_only');
    await expect(page.getByTestId('mailbox-quota')).toHaveCount(0);
  });

  test('send-only lifecycle: create → badge, no webmail, edit modal without quota/auto-reply', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdminTenant(page);
    await openMailboxesTab(page);

    await page.getByTestId('add-mailbox-button').click();
    await page.getByTestId('mailbox-local-part').fill(SO_LOCAL);
    await page.getByTestId('mailbox-type').selectOption('send_only');
    await page.getByTestId('submit-mailbox').click();

    // Create opens the one-time login-password reveal modal — close it
    // via its close button (it doesn't listen for Escape).
    const row = page.locator('tr', { hasText: SO_LOCAL });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('login-passwords-close').click();
    await expect(page.getByTestId('login-passwords-modal')).toHaveCount(0);

    const soId = (await row.locator('[data-testid^="send-only-badge-"]').getAttribute('data-testid'))!
      .replace('send-only-badge-', '');
    await expect(row.getByTestId(`send-only-badge-${soId}`)).toBeVisible();
    await expect(row.locator(`[data-testid="webmail-${soId}"]`)).toHaveCount(0);
    await expect(row.getByText('— no storage')).toBeVisible();

    await row.getByTestId(`edit-mailbox-${soId}`).click();
    await expect(page.getByTestId('edit-mailbox-modal')).toBeVisible();
    await expect(page.getByTestId('edit-mailbox-quota')).toHaveCount(0);
    await expect(page.getByTestId('edit-mailbox-auto-reply')).toHaveCount(0);
    await expect(page.getByTestId('edit-mailbox-forwarding')).toBeVisible();
    await expect(page.getByText(/incoming mail to this address is bounced/i)).toBeVisible();
    await page.getByTestId('edit-mailbox-close').click();

    await deleteMailboxRow(page, SO_LOCAL);
  });

  test('forwarding lifecycle: enable via edit modal → badge appears → clear', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdminTenant(page);
    await openMailboxesTab(page);

    await page.getByTestId('add-mailbox-button').click();
    await page.getByTestId('mailbox-local-part').fill(FWD_LOCAL);
    await page.getByTestId('submit-mailbox').click();
    const row = page.locator('tr', { hasText: FWD_LOCAL });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await page.getByTestId('login-passwords-close').click();
    await expect(page.getByTestId('login-passwords-modal')).toHaveCount(0);

    const mbId = (await row.locator('[data-testid^="edit-mailbox-"]').getAttribute('data-testid'))!
      .replace('edit-mailbox-', '');
    await row.getByTestId(`edit-mailbox-${mbId}`).click();
    await page.getByTestId('edit-mailbox-forwarding').check();
    await page.getByTestId('edit-mailbox-forwarding-addresses').fill('archive@example.org');
    await expect(page.getByText(/copy of each forwarded message is also kept/i)).toBeVisible();
    await page.getByTestId('submit-edit-mailbox').click();
    await expect(page.getByTestId('edit-mailbox-modal')).toHaveCount(0, { timeout: 15_000 });

    await expect(row.getByTestId(`forwarding-badge-${mbId}`)).toBeVisible({ timeout: 10_000 });

    // Clear it again through the same modal.
    await row.getByTestId(`edit-mailbox-${mbId}`).click();
    await page.getByTestId('edit-mailbox-forwarding').uncheck();
    await page.getByTestId('submit-edit-mailbox').click();
    await expect(page.getByTestId('edit-mailbox-modal')).toHaveCount(0, { timeout: 15_000 });
    await expect(row.locator(`[data-testid="forwarding-badge-${mbId}"]`)).toHaveCount(0, { timeout: 10_000 });

    await deleteMailboxRow(page, FWD_LOCAL);
  });
});
