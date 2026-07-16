import { eq } from 'drizzle-orm';
import { backupJobs } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { isHookAuthoritative } from '../registry/feature-flags.js';

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
 *   2. (this hook) on delete, backfill an expires_at on any reap-eligible bundle
 *      that never got one, so the reaper is guaranteed to eventually delete the
 *      orphan's data (no infinite-retention storage leak).
 *
 * Ordering / blocking: order=410 (after dns-zone-cleanup); blocking=continue — a
 * backfill hiccup must not abort the delete.
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
    retentionDays: backupJobs.retentionDays,
    status: backupJobs.status,
  })
    .from(backupJobs)
    .where(eq(backupJobs.tenantId, ctx.tenantId));

  if (jobs.length === 0) {
    return { status: 'noop', detail: 'tenant has no backup bundles to retain' };
  }

  // Backfill expires_at for reap-eligible bundles that never got one, so the
  // retention reaper is guaranteed to eventually delete this orphan's data.
  const nowMs = Date.now();
  let backfilled = 0;
  for (const j of jobs) {
    if (j.expiresAt) continue;
    if (!REAP_ELIGIBLE.includes(j.status as (typeof REAP_ELIGIBLE)[number])) continue;
    const days = j.retentionDays > 0 ? j.retentionDays : DEFAULT_RETENTION_DAYS;
    await ctx.db.update(backupJobs)
      .set({ expiresAt: new Date(nowMs + days * DAY_MS) })
      .where(eq(backupJobs.id, j.id));
    backfilled++;
  }

  return {
    status: 'ok',
    detail: `retained ${jobs.length} bundle(s) for retention-based reaping`
      + (backfilled ? ` (backfilled expires_at on ${backfilled})` : ''),
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
