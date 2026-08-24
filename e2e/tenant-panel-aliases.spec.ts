import { test, expect, type Page } from '@playwright/test';
import { loginAsAdminTenant, ensureSharedEmailDomain } from './helpers';

/**
 * Email aliases (real since R28) — full tenant-panel flow: create via the
 * form, edit destinations + disable via the unified edit modal, delete
 * with the confirm pattern. Runs against the live dev stack; the backend
 * provisions a Stalwart MailingList per alias.
 */

test.use({ ignoreHTTPSErrors: true });

const STAMP = Date.now().toString(36);
const ALIAS_LOCAL = `team-${STAMP}`;

async function openAliasesTab(page: Page): Promise<void> {
  await page.goto('/email');
  await expect(page.getByTestId('add-mailbox-button')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /Aliases/ }).click();
  await expect(page.getByTestId('add-alias-button')).toBeVisible();
}

test.describe('email aliases (tenant panel)', () => {
  test.beforeAll(async () => {
    await ensureSharedEmailDomain();
  });

  test('alias lifecycle: create → edit destinations → disable badge → delete', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAsAdminTenant(page);
    await openAliasesTab(page);

    // Create
    await page.getByTestId('add-alias-button').click();
    await page.getByTestId('alias-source').fill(ALIAS_LOCAL);
    await page.getByTestId('alias-destinations').fill('one@example.org, two@example.org');
    await page.getByTestId('submit-alias').click();
    const row = page.locator('div', { hasText: ALIAS_LOCAL }).locator('visible=true').first();
    await expect(page.getByText(`${ALIAS_LOCAL}@`, { exact: false })).toBeVisible({ timeout: 15_000 });

    // Edit destinations via the unified modal
    const editBtn = page.locator('[data-testid^="edit-alias-"]').last();
    const aliasId = (await editBtn.getAttribute('data-testid'))!.replace('edit-alias-', '');
    await editBtn.click();
    await expect(page.getByTestId('edit-alias-modal')).toBeVisible();
    await page.getByTestId('edit-alias-destinations').fill('three@example.org');
    await page.getByTestId('submit-edit-alias').click();
    await expect(page.getByTestId('edit-alias-modal')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('three@example.org')).toBeVisible({ timeout: 10_000 });

    // Disable → badge appears
    await page.getByTestId(`edit-alias-${aliasId}`).click();
    await page.getByTestId('edit-alias-enabled').uncheck();
    await page.getByTestId('submit-edit-alias').click();
    await expect(page.getByTestId('edit-alias-modal')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`alias-disabled-badge-${aliasId}`)).toBeVisible({ timeout: 10_000 });

    // Delete with confirm
    await page.getByTestId(`delete-alias-${aliasId}`).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByTestId(`delete-alias-${aliasId}`)).toHaveCount(0, { timeout: 10_000 });
    void row;
  });

  test('self-target destination is rejected visibly in the form', async ({ page }) => {
    test.setTimeout(60_000);
    await loginAsAdminTenant(page);
    await openAliasesTab(page);
    const { domainName } = await ensureSharedEmailDomain();

    await page.getByTestId('add-alias-button').click();
    await page.getByTestId('alias-source').fill(`loop-${STAMP}`);
    await page.getByTestId('alias-destinations').fill(`loop-${STAMP}@${domainName}`);
    await page.getByTestId('submit-alias').click();
    await expect(page.getByText(/own address/i)).toBeVisible({ timeout: 15_000 });
  });
});
