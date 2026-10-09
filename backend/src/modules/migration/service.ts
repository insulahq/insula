/**
 * Cross-cluster tenant migration (R20) — service.
 *
 * Cluster B mounts cluster A's tenant backup target read-only (a backup
 * target config on B), scans it for tenants, and imports single/all. Import
 * reuses the DR recover route (recreate-from-bundle + reconcile) with the
 * migration source's `targetConfigId`, so the tenant is rebuilt straight from
 * A's target with no prep on A. Tenants that already exist locally are skipped.
 */

import type { FastifyInstance } from 'fastify';
import { inArray, eq } from 'drizzle-orm';
import { tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type {
  BackupMetaV2,
  MigrationTenant,
  MigrationImportResult,
} from '@insula/api-contracts';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';
import { pickNewestPerTenant, type ScannedBundle } from './bundle-pick.js';

async function openSourceStore(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const { resolveDirectStoreForBundle } = await import('../backup-restore/shared.js');
  try {
    // Tenant bundles live under <prefix>/tenant/<bundleId> (the shim class
    // segment) — scan there, not the bare prefix.
    return await resolveDirectStoreForBundle(app, targetConfigId, { classSubpath: 'tenant' });
  } catch (err) {
    throw new ApiError(
      'MIGRATION_SOURCE_INVALID',
      `Could not open the migration source target '${targetConfigId}': ${(err as Error).message}`,
      400,
      { target_config_id: targetConfigId },
      'Configure a backup target (Backups → Targets) pointing at the source cluster’s tenant store (S3/SFTP), then retry.',
    );
  }
}

export interface MigrationScan {
  readonly tenants: MigrationTenant[];
  readonly scanned: number;
  readonly skipped: number;
}

/** Scan the source target, group bundles by tenant, keep the newest per tenant. */
export async function listMigrationTenants(
  app: FastifyInstance,
  targetConfigId: string,
): Promise<MigrationScan> {
  const store = await openSourceStore(app, targetConfigId);

  let bundleIds: string[];
  try {
    bundleIds = await store.listBundleIds();
  } catch (err) {
    throw new ApiError(
      'MIGRATION_SOURCE_UNREADABLE',
      `Could not list bundles on the migration source: ${(err as Error).message}`,
      502,
      { target_config_id: targetConfigId },
      'Check the source target credentials + connectivity, then retry.',
    );
  }

  const found: ScannedBundle<BackupMetaV2>[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const bundleId of bundleIds) {
    scanned++;
    let meta: BackupMetaV2;
    try {
      const handle = await store.open(bundleId);
      if (!handle) { skipped++; continue; }
      meta = await store.getMeta(handle);
    } catch { skipped++; continue; }   // in-flight / foreign / invalid meta
    if (!meta.tenantId) { skipped++; continue; }
    found.push({ bundleId, meta });
  }
  const byTenant = pickNewestPerTenant(found);

  const ids = [...byTenant.keys()];
  const present = ids.length
    ? await app.db.select({ id: tenants.id }).from(tenants).where(inArray(tenants.id, ids))
    : [];
  const presentSet = new Set(present.map((r) => r.id));

  const out: MigrationTenant[] = [...byTenant.entries()].map(([tid, v]) => {
    const present = Object.entries(v.meta.components ?? {}).filter(([, c]) => c);
    const componentNames = present.map(([k]) => k);
    const totalSizeBytes = present.reduce((s, [, c]) => s + Number(c?.sizeBytes ?? 0), 0);
    return {
      tenantId: tid,
      tenantName: v.meta.tenant?.name ?? '(unknown)',
      primaryEmail: v.meta.tenant?.primaryEmail ?? null,
      latestBundleId: v.bundleId,
      latestCreatedAt: v.capturedAt,
      bundleCount: v.count,
      totalSizeBytes,
      components: componentNames,
      platformVersion: v.meta.platformVersion ?? null,
      alreadyPresent: presentSet.has(tid),
      effectiveResources: v.meta.tenant?.effectiveResources ?? null,
    };
  }).sort((a, b) => a.tenantName.localeCompare(b.tenantName));

  return { tenants: out, scanned, skipped };
}

function skippedResult(t: MigrationTenant, status: string, error: string | null): MigrationImportResult {
  return {
    tenantId: t.tenantId, tenantName: t.tenantName, bundleId: t.latestBundleId,
    ok: status === 'dry-run', status, recreated: false, alreadyPresent: t.alreadyPresent,
    cartId: null, residualGaps: [], error,
  };
}

/** Import selected/all discovered tenants (skips those already present locally). */
export async function importMigrationTenants(
  app: FastifyInstance,
  input: { targetConfigId: string; scope: 'selected' | 'all'; tenantIds?: string[]; dryRun: boolean },
  authHeader: string,
): Promise<{ results: MigrationImportResult[] }> {
  const { tenants: discovered } = await listMigrationTenants(app, input.targetConfigId);
  const wanted = new Set(input.tenantIds ?? []);
  const selected = input.scope === 'all' ? discovered : discovered.filter((t) => wanted.has(t.tenantId));

  const results: MigrationImportResult[] = [];
  for (const t of selected) {
    if (t.alreadyPresent) {
      results.push(skippedResult(t, 'skipped', 'A tenant with this id already exists on this cluster — skipped to avoid overwrite.'));
      continue;
    }
    if (input.dryRun) {
      results.push(skippedResult(t, 'dry-run', null));
      continue;
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/dr/tenants/${encodeURIComponent(t.tenantId)}/recover`,
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload: { bundleId: t.latestBundleId, targetConfigId: input.targetConfigId },
      });
      const body = JSON.parse(res.body || '{}') as {
        data?: { status?: string; recreated?: boolean; cartId?: string; residualGaps?: string[] };
        error?: { message?: string };
      };
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const d = body.data ?? {};
        const ok = (d.status ?? '') !== 'failed';
        // Pin the captured effective resources as EXPLICIT overrides on this
        // cluster, so the tenant's quotas stay identical to the source
        // regardless of how THIS cluster's plans are defined (plan-independent
        // migration). Legacy bundles without effectiveResources are left to
        // inherit the restored plan_id + whatever overrides the config carried.
        if (ok && t.effectiveResources) {
          const e = t.effectiveResources;
          await app.db.update(tenants).set({
            cpuLimitOverride: String(e.cpuLimit),
            memoryLimitOverride: String(e.memoryLimit),
            storageLimitOverride: String(e.storageLimit),
            maxSubUsersOverride: e.maxSubUsers,
            maxMailboxesOverride: e.maxMailboxes,
            maxMailboxSizeMbOverride: e.maxMailboxSizeMb,
            emailSendRateLimit: e.emailHourlySendLimit,
            emailSendRateLimitDaily: e.emailDailySendLimit,
            monthlyPriceOverride: String(e.monthlyPriceUsd),
          }).where(eq(tenants.id, t.tenantId)).catch((err: unknown) => {
            app.log.warn({ err, tenantId: t.tenantId }, 'migration: failed to pin effective-resource overrides');
          });
        }
        results.push({
          tenantId: t.tenantId, tenantName: t.tenantName, bundleId: t.latestBundleId,
          ok, status: d.status ?? 'done',
          recreated: !!d.recreated, alreadyPresent: false, cartId: d.cartId ?? null,
          residualGaps: d.residualGaps ?? [], error: null,
        });
      } else {
        results.push({
          tenantId: t.tenantId, tenantName: t.tenantName, bundleId: t.latestBundleId,
          ok: false, status: 'failed', recreated: false, alreadyPresent: false, cartId: null,
          residualGaps: [], error: body.error?.message ?? `recover HTTP ${res.statusCode}`,
        });
      }
    } catch (err) {
      results.push({
        tenantId: t.tenantId, tenantName: t.tenantName, bundleId: t.latestBundleId,
        ok: false, status: 'failed', recreated: false, alreadyPresent: false, cartId: null,
        residualGaps: [], error: (err as Error).message,
      });
    }
  }
  return { results };
}
