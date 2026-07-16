import { eq } from 'drizzle-orm';
import { backupJobs } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { isHookAuthoritative } from '../registry/feature-flags.js';
import { getSettings } from '../../system-settings/service.js';

/**
 * tenant-bundles-bundle-cleanup hook.
 *
 * POLICY (2026-07-16): deleting a tenant RETAINS its off-site backup bundles —
 * they are a deleted tenant's ONLY recovery path (the DR recover-tenant flow and
 * cross-cluster migration import both read them back from the off-site store).
 * The `retention.ts` reaper deletes each bundle once its `expires_at` passes
 * (retentionDays, default 30), so a deleted tenant's data is auto-reaped after
 * its retention window instead of being purged immediately on delete.
 *
 * Two things make that reliable for a now-orphaned tenant:
 *   1. (schema) backup_jobs.tenant_id is a LOOSE reference to tenants.id — NO
 *      `ON DELETE CASCADE` — so the tracking rows SURVIVE the tenant row's
 *      deletion. The reaper needs them (id + targetConfigId + expires_at) to
 *      find + delete the remote bytes, and the restic password derives from the
 *      preserved tenant_id.
 *   2. (this hook) on delete, floor every reap-eligible bundle's expires_at to
 *      now + the admin-configured deletion grace window
 *      (system_settings.deleted_tenant_bundle_retention_days, migration 0071;
 *      default 30). "Floor" = extend-never-shorten: a retain-forever (null)
 *      bundle finally gets an expiry so it can't leak; a bundle already
 *      scheduled to live LONGER keeps its later expiry (we never destroy a
 *      deleted tenant's recovery copy earlier than already planned). The
 *      retention.ts reaper then deletes each bundle once its expires_at passes.
 *
 * Ordering / blocking: order=410 (after dns-zone-cleanup); blocking=continue — a
 * grace-window hiccup must not abort the delete.
 *
 * (Was: this hook eagerly `store.delete()`d every bundle on delete, on the
 * now-obsolete premise that "bundle bytes are never cleaned up by anything" —
 * the retention reaper does exactly that. Eager purge destroyed a deleted
 * tenant's recovery bundles, breaking DR recover + cross-cluster migration.)
 */

const HOOK_NAME = 'tenant-bundles-bundle-cleanup';
const REAP_ELIGIBLE = ['completed', 'partial', 'failed'] as const;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'deleted') {
    return { status: 'noop', detail: 'only runs on deleted' };
  }
  if (!isHookAuthoritative(HOOK_NAME)) {
    return { status: 'noop', detail: 'hook disabled by feature flag' };
  }

  const jobs = await ctx.db.select({
    id: backupJobs.id,
    expiresAt: backupJobs.expiresAt,
    status: backupJobs.status,
  })
    .from(backupJobs)
    .where(eq(backupJobs.tenantId, ctx.tenantId));

  if (jobs.length === 0) {
    return { status: 'noop', detail: 'tenant has no backup bundles to retain' };
  }

  // Admin-configured deletion grace window (system_settings, migration 0071).
  // Fall back to the historical 30-day default if the read fails so a transient
  // DB hiccup never leaves a now-orphaned bundle with no expiry (storage leak).
  let retentionDays = DEFAULT_RETENTION_DAYS;
  try {
    const settings = await getSettings(ctx.db);
    if (settings.deletedTenantBundleRetentionDays > 0) {
      retentionDays = settings.deletedTenantBundleRetentionDays;
    }
  } catch {
    // keep DEFAULT_RETENTION_DAYS
  }

  // Floor every reap-eligible bundle's expires_at to the grace window
  // (extend-never-shorten): set it on the retain-forever (null) ones so they
  // can't leak, and on those expiring SOONER than the window so the operator's
  // grace period is honoured — but leave alone any bundle already scheduled to
  // live longer (never shorten a deleted tenant's only recovery copy).
  const graceExpiry = new Date(Date.now() + retentionDays * DAY_MS);
  let floored = 0;
  for (const j of jobs) {
    if (!REAP_ELIGIBLE.includes(j.status as (typeof REAP_ELIGIBLE)[number])) continue;
    if (j.expiresAt && j.expiresAt.getTime() >= graceExpiry.getTime()) continue;
    await ctx.db.update(backupJobs)
      .set({ expiresAt: graceExpiry })
      .where(eq(backupJobs.id, j.id));
    floored++;
  }

  return {
    status: 'ok',
    detail: `retained ${jobs.length} bundle(s) for a ${retentionDays}-day deletion grace window`
      + (floored ? ` (set expires_at on ${floored})` : ''),
  };
}

export const backupsV2BundleCleanupHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['deleted'],
  order: 410,
  blocking: 'continue',
  maxAttempts: 3,
  // Run after dns-zone-cleanup so DNS finishes first.
  after: ['dns-zone-cleanup'],
  run: runImpl,
};

let _registered = false;
export function registerTenantBundlesBundleCleanupHook(): void {
  if (_registered) return;
  registerLifecycleHook(backupsV2BundleCleanupHook);
  _registered = true;
}
