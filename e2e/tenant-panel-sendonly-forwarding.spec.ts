import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { loginAsAdminTenant } from './helpers';

/**
 * Send-only accounts + per-mailbox forwarding — real-browser flow over the
 * tenant panel (create form type selector, row badges, edit-modal forwarding
 * panel, send-only affordance hiding).
 *
 * Prerequisite (like the other email specs): the shared E2E tenant has at
 * least one email-enabled domain. The suite creates its mailboxes through
 * the REAL form and cleans them up through the REAL delete buttons.
 */

const API_BASE = process.env.API_URL ?? 'https://admin.k8s-platform.test:2011';

test.use({ ignoreHTTPSErrors: true });

const STAMP = Date.now().toString(36);
const SO_LOCAL = `no-reply-${STAMP}`;
const FWD_LOCAL = `fwd-ui-${STAMP}`;

async function ensureEmailDomain(): Promise<void> {
  // Admin-token bootstrap: make sure the shared tenant has an enabled
  // email domain so the Mailboxes tab renders its create form. Uses
  // Playwright's APIRequestContext (NOT node fetch — the worker's global
  // fetch mangles chunked responses from the dev ingress) and reuses the
  // token cached by the admin-setup project (a fresh login per worker
  // trips the shared login rate limiter).
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  try {
    let token: string | undefined;
    const adminAuthPath = path.join(__dirname, '.auth/admin-auth.json');
    if (fs.existsSync(adminAuthPath)) {
      token = (JSON.parse(fs.readFileSync(adminAuthPath, 'utf-8')) as { token?: string }).token;
    }
    if (!token) {
      const loginRes = await ctx.post(`${API_BASE}/api/v1/auth/login`, {
        data: { email: 'admin@k8s-platform.test', password: 'admin' },
      });
      token = ((await loginRes.json()) as { data: { token: string } }).data.token;
    }
    const headers = { Authorization: `Bearer ${token}` };

    const tenants = (await (await ctx.get(`${API_BASE}/api/v1/tenants?limit=100`, { headers })).json()) as {
      data: { id: string; primaryEmail?: string; companyEmail?: string }[];
    };
    let tenantId = tenants.data.find(
      (t) => (t.primaryEmail ?? t.companyEmail) === 'e2e-test@k8s-platform.test',
    )?.id;
    if (!tenantId) {
      // First spec to run — create the shared tenant the same way helpers.ts
      // getTenantAuth() does.
      const plans = (await (await ctx.get(`${API_BASE}/api/v1/plans`, { headers })).json()) as { data: { id: string }[] };
      const regions = (await (await ctx.get(`${API_BASE}/api/v1/regions`, { headers })).json()) as { data: { id: string }[] };
      const created = (await (
        await ctx.post(`${API_BASE}/api/v1/tenants`, {
          headers,
          data: {
            name: 'E2E Test Tenant',
            primary_email: 'e2e-test@k8s-platform.test',
            plan_id: plans.data[0]?.id,
            region_id: regions.data[0]?.id,
          },
        })
      ).json()) as { data?: { id: string } };
      tenantId = created.data?.id;
    }
    if (!tenantId) throw new Error('shared E2E tenant missing and could not be created');

    // Domain/email ops need an ACTIVE tenant; the shared tenant is created
    // pending (no auto-provision). Provision + wait, idempotent.
    const status = async () =>
      (((await (await ctx.get(`${API_BASE}/api/v1/tenants/${tenantId}`, { headers })).json()) as {
        data?: { status?: string };
      }).data?.status ?? '');
    if ((await status()) !== 'active') {
      await ctx.post(`${API_BASE}/api/v1/admin/tenants/${tenantId}/provision`, { headers, data: {} });
      for (let i = 0; i < 45 && (await status()) !== 'active'; i++) {
        await new Promise((r) => setTimeout(r, 4000));
      }
      if ((await status()) !== 'active') throw new Error('shared E2E tenant did not reach active');
    }

    // Sweep leftovers from earlier (interrupted) runs of THIS spec — the
    // shared tenant's plan caps total mailboxes, so orphans starve creates.
    const boxes = (await (await ctx.get(`${API_BASE}/api/v1/tenants/${tenantId}/mailboxes`, { headers })).json()) as {
      data?: { id: string; localPart: string }[];
    };
    for (const mb of boxes.data ?? []) {
      if (/^(no-reply|fwd-ui)-/.test(mb.localPart)) {
        await ctx.delete(`${API_BASE}/api/v1/tenants/${tenantId}/mailboxes/${mb.id}`, { headers });
      }
    }

    const eds = (await (await ctx.get(`${API_BASE}/api/v1/tenants/${tenantId}/email/domains`, { headers })).json()) as {
      data?: { id: string; enabled: number }[];
    };
    if ((eds.data ?? []).some((d) => d.enabled === 1)) return;

    const dom = (await (
      await ctx.post(`${API_BASE}/api/v1/tenants/${tenantId}/domains`, {
        headers,
        data: { domain_name: `sofui${STAMP}.com`, dns_mode: 'cname' },
      })
    ).json()) as { data?: { id: string } };
    if (!dom.data?.id) throw new Error('domain create failed');
    const enable = (await (
      await ctx.post(`${API_BASE}/api/v1/tenants/${tenantId}/email/domains/${dom.data.id}/enable`, {
        headers,
        data: {},
      })
    ).json()) as { data?: { id: string } };
    if (!enable.data?.id) throw new Error('email enable failed');
  } finally {
    await ctx.dispose();
  }
}

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
    await ensureEmailDomain();
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
