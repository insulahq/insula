import { test, expect, request as pwRequest } from '@playwright/test';
import { injectAdminAuth } from './helpers';

/**
 * Backup-UX regression pack (2026-08-24):
 *  1. Cluster → Storage shows the 3 backup-class assignment tiles AND a
 *     clearly-scoped "Longhorn volume backups" section (the old card
 *     claimed "no backup target" even with all classes assigned).
 *  2. First-enable of WAL streaming / scheduled base backups asks for
 *     confirmation (CNPG rolling restart, ~5 min).
 *  3. When a backup task reaches a terminal state the affected pages
 *     refresh without a manual reload (task-completion refresher).
 */

const API = process.env.API_URL ?? 'https://admin.insula.host:2011';

async function adminToken(): Promise<string> {
  const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const resp = await ctx.post(`${API}/api/v1/auth/login`, {
    data: { email: 'admin@insula.host', password: 'admin' },
  });
  const body = (await resp.json()) as { data?: { token?: string } };
  await ctx.dispose();
  if (!body.data?.token) throw new Error('admin login failed');
  return body.data.token;
}

test.describe('backup UX', () => {
  test('storage page shows class assignments and scoped Longhorn section', async ({ page }) => {
    await injectAdminAuth(page);
    await page.goto('/cluster/storage');

    await expect(page.getByTestId('storage-class-assignments')).toBeVisible();
    for (const cls of ['system', 'tenant', 'mail']) {
      await expect(page.getByTestId(`storage-assignment-${cls}`)).toBeVisible();
    }
    const lh = page.getByTestId('longhorn-volume-backup-target');
    await expect(lh).toBeVisible();
    await expect(lh).toContainText('Longhorn volume backups');
    // When no target is activated, the message must scope the gap to
    // Longhorn volume-level backups — not claim nothing is configured.
    const noActive = page.getByTestId('no-active-target');
    if (await noActive.isVisible().catch(() => false)) {
      await expect(noActive).toContainText('Longhorn volume-level');
      await expect(noActive).toContainText('Class backups');
    }
  });

  test('WAL streaming first enable asks for DB-restart confirmation', async ({ page }) => {
    test.setTimeout(180_000);
    const token = await adminToken();
    const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // The enable button requires a bound SYSTEM target — provision a
    // throwaway one for the duration of the dialog check.
    let cfgId: string | null = null;
    let assignedSystem = false;
    try {
      await injectAdminAuth(page);
      await page.goto('/backups/system?tab=routing');
      await expect(page.getByTestId('routing-tab-wal-streaming')).toBeVisible({ timeout: 10_000 });

      const enableBtn = page.locator('[data-testid^="wal-streaming-enable-"]').first();
      if (!(await enableBtn.isVisible().catch(() => false))) {
        test.skip(true, 'WAL streaming already enabled on this stack — first-enable path not reachable');
        return;
      }
      if (!(await enableBtn.isEnabled())) {
        const stamp = Date.now();
        const created = (await (await ctx.post(`${API}/api/v1/admin/backup-configs`, {
          headers: auth,
          data: {
            name: `wal-e2e-${stamp}`, storage_type: 's3',
            s3_endpoint: 'http://minio.dev-minio.svc.cluster.local:9000',
            s3_bucket: 'system-backups', s3_prefix: `wal-e2e-${stamp}`, s3_region: 'us-east-1',
            s3_access_key: 'minio-dev-access-key', s3_secret_key: 'minio-dev-secret-key',
            retention_days: 7,
          },
        })).json()) as { data?: { id?: string } };
        cfgId = created.data?.id ?? null;
        expect(cfgId).toBeTruthy();
        const assignResp = await ctx.put(`${API}/api/v1/admin/backup-rclone-shim/assignments/system`, {
          headers: auth, data: { targetId: cfgId, force: true },
        });
        expect(assignResp.ok()).toBeTruthy();
        assignedSystem = true;
        // The assignment applies via a background task; reload until the
        // button unlocks (bounded).
        await expect(async () => {
          await page.reload();
          await expect(page.locator('[data-testid^="wal-streaming-enable-"]').first()).toBeEnabled({ timeout: 5_000 });
        }).toPass({ timeout: 120_000, intervals: [5_000] });
      }

      let dialogMessage = '';
      page.once('dialog', (d) => {
        dialogMessage = d.message();
        void d.dismiss();
      });
      await enableBtn.click();
      expect(dialogMessage).toContain('rolling restart');
      expect(dialogMessage).toContain('5 minutes');
      // Dismissed → still showing the enable button (nothing mutated).
      await expect(enableBtn).toBeVisible();
    } finally {
      if (assignedSystem) {
        await ctx.put(`${API}/api/v1/admin/backup-rclone-shim/assignments/system`, {
          headers: auth, data: { targetId: null, force: true },
        }).catch(() => undefined);
        // Config delete 409s while the unassign task drains — retry briefly.
        if (cfgId) {
          for (let i = 0; i < 12; i++) {
            const del = await ctx.delete(`${API}/api/v1/admin/backup-configs/${cfgId}`, { headers: auth }).catch(() => null);
            if (del?.ok()) break;
            await new Promise((r) => setTimeout(r, 5_000));
          }
        }
      }
      await ctx.dispose();
    }
  });

  test('assignment task completion refreshes the storage tiles without reload', async ({ page }) => {
    test.setTimeout(240_000);
    const token = await adminToken();
    const ctx = await pwRequest.newContext({ ignoreHTTPSErrors: true });
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Precondition: mail class unassigned.
    const putResp = await ctx.put(`${API}/api/v1/admin/backup-rclone-shim/assignments/mail`, {
      headers: auth, data: { targetId: null, force: true },
    });
    expect(putResp.ok()).toBeTruthy();

    let cfgId: string | null = null;
    const cfgName = `refresh-e2e-${Date.now()}`;
    try {
      await injectAdminAuth(page);
      await page.goto('/cluster/storage');
      await expect(page.getByTestId('storage-assignment-mail')).toContainText('Unassigned', { timeout: 30_000 });

      const created = (await (await ctx.post(`${API}/api/v1/admin/backup-configs`, {
        headers: auth,
        data: {
          name: cfgName, storage_type: 's3',
          s3_endpoint: 'http://minio.dev-minio.svc.cluster.local:9000',
          s3_bucket: 'snapshots', s3_prefix: cfgName, s3_region: 'us-east-1',
          s3_access_key: 'minio-dev-access-key', s3_secret_key: 'minio-dev-secret-key',
          retention_days: 7,
        },
      })).json()) as { data?: { id?: string } };
      cfgId = created.data?.id ?? null;
      expect(cfgId).toBeTruthy();
      const assignResp = await ctx.put(`${API}/api/v1/admin/backup-rclone-shim/assignments/mail`, {
        headers: auth, data: { targetId: cfgId, force: true },
      });
      expect(assignResp.ok()).toBeTruthy();

      // NO reload: the task-center poll must observe the terminal task and
      // invalidate the assignments query → tile flips to the target name.
      await expect(page.getByTestId('storage-assignment-mail')).toContainText(cfgName, { timeout: 180_000 });
    } finally {
      await ctx.put(`${API}/api/v1/admin/backup-rclone-shim/assignments/mail`, {
        headers: auth, data: { targetId: null, force: true },
      }).catch(() => undefined);
      if (cfgId) {
        for (let i = 0; i < 12; i++) {
          const del = await ctx.delete(`${API}/api/v1/admin/backup-configs/${cfgId}`, { headers: auth }).catch(() => null);
          if (del?.ok()) break;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
      await ctx.dispose();
    }
  });
});
