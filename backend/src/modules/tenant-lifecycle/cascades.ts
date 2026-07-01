import { eq, inArray } from 'drizzle-orm';
import { tenants, ingressMtlsConfigs, tenantMtlsProviders } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runTransition, type Transition } from './registry/index.js';
import { reapNamespaceVolumes, realReapDeps } from './reap-namespace-volumes.js';

/**
 * Client-lifecycle cascades.
 *
 * Every state transition (active, suspended, archived, deleted) goes
 * through ONE of these functions so we have a single place to reason
 * about what each state means for every resource type the platform
 * manages.
 *
 * All functions are idempotent: re-running `applySuspended` on an
 * already-suspended tenant is a no-op. That's critical because the
 * storage-lifecycle ops, the subscription-expiry cron, and the admin
 * API all call into here and can race.
 *
 * Storage lifecycle (snapshots, PVC delete) is intentionally NOT here:
 * those operations live in storage-lifecycle/service.ts and invoke
 * these cascades at the right moments.
 *
 * Phase 6: every state-mutation step previously inlined here is now
 * a registered LifecycleHook. These wrappers exist solely to
 * dispatch the transition through the registry so the hook runs +
 * audit trail land. The actual work is in
 * `tenant-lifecycle/hooks/*.ts`.
 */

export interface CascadeCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  /**
   * The admin / tenant_admin user that initiated the action. Threaded
   * through to `runTransition` so the Task Tracker chip lights up on
   * the initiator's session. Optional — cron-driven cascades pass null
   * (those tasks are scope='system' and only land in notifications on
   * failure, never in the chip).
   */
  readonly triggeredByUserId?: string | null;
  /**
   * When set, the per-tenant task row registered by the dispatcher
   * carries this parent_task_id. Bulk ops pass the parent task id
   * here so the chip can fold N children under one parent row.
   */
  readonly parentTaskId?: string | null;
}

/**
 * Run a transition through the registry. Errors from the dispatcher
 * are swallowed so a registry write failure cannot corrupt the
 * outer cascade — the orphan scanner + retry scheduler are the
 * safety nets if the in-band call fails.
 *
 * Returns the transitionId so callers (PATCH /tenants/:id route, bulk
 * ops, storage-lifecycle orchestrators) can include it in their
 * response. The UI uses it to open the progress modal immediately
 * with a stable id instead of latching by (kind + since-timestamp)
 * after a 1-2 s race.
 */
async function dispatchTransition(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
  transition: Transition,
  fromStatus: string | null,
  toStatus: string,
): Promise<string | null> {
  try {
    const result = await runTransition(ctx.db, ctx.k8s, {
      tenantId, namespace, transition, fromStatus, toStatus,
      triggeredByUserId: ctx.triggeredByUserId ?? null,
      parentTaskId: ctx.parentTaskId ?? null,
    });
    return result.transitionId;
  } catch (err) {
    console.warn(
      `[cascades.dispatchTransition] registry write failed for tenant ${tenantId} ${transition}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── suspended → active ─────────────────────────────────────────────────

/**
 * Reverse the suspend cascades: re-enable mail, webcron, domains, and
 * restore the ingress backends. Does NOT scale workloads back up —
 * that's the storage-lifecycle resume op's responsibility (it needs
 * to know the pre-suspend replica counts from the QuiesceSnapshot).
 *
 * Hooks fired (in topo order):
 *   domains-status, cronjobs-enable, mailboxes-status,
 *   email-aliases-enable, deployments-status, tenants-status-stamp,
 *   ingress-resume, ingress-reconcile.
 */
export async function applyActive(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'active', null, 'active');
}

export async function applyRestored(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'restored', null, 'active');
}

export async function applySuspended(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'suspended', null, 'suspended');
}

export async function applyArchived(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'archived', null, 'archived');
}

// ─── active → suspended ──────────────────────────────────────────────────

// ─── * → deleted (hard remove) ──────────────────────────────────────────

/**
 * Delete cascades: hard-remove EVERYTHING owned by this tenant.
 * Sequence:
 *   1. Open a transitions row + run the registry's `deleted` hooks
 *      (pv-cleanup-released, dns-zone-cleanup, tenant-bundles-bundle-
 *      cleanup, etc.). This happens BEFORE the FK cascade so the
 *      hooks can read domains/backup_jobs rows.
 *   2. Drop the k8s namespace — brings pods, PVCs, ingress, services,
 *      configmaps, secrets with it.
 *   2b. Reap this tenant's Released PVs + stranded Longhorn volume CRs
 *      (scoped to THIS namespace), bounded + best-effort. Runs after the
 *      namespace delete (when PVs actually go Released) and catches the
 *      volume CR that outlives its PV — the leak the by-PV-name
 *      `pv-cleanup-released` hook cannot reach. See reap-namespace-volumes.ts.
 *   3. Drop the tenant row — LAST, after teardown is initiated + volumes
 *      reaped, so there is no DB-less-orphan window for the orphan scanner
 *      to trip on. FK cascades reap domains, deployments, mailboxes,
 *      sftp_users, backups, etc. `audit_logs` and
 *      `tenant_lifecycle_transitions` intentionally retain `tenant_id` as a
 *      tombstone.
 *
 * Storage-lifecycle snapshots for this tenant are purged by the
 * caller (storage-lifecycle/service.ts handles snapshot store
 * cleanup) before we hit applyDeleted.
 */
export async function applyDeleted(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  // Step 1: dispatch hooks while domains/backup_jobs rows still exist.
  const transitionId = await dispatchTransition(ctx, tenantId, namespace, 'deleted', null, 'deleted');

  // Step 2: drop the k8s namespace. `tenants.kubernetes_namespace` is
  // notNull in schema, so no truthy guard — an empty string would
  // indicate a seed bug upstream and should surface as an error.
  try {
    await ctx.k8s.core.deleteNamespace({ name: namespace });
  } catch (err) {
    const status = (err as { statusCode?: number; code?: number; body?: { code?: number } }).statusCode
      ?? (err as { code?: number }).code
      ?? (err as { body?: { code?: number } }).body?.code;
    if (status !== 404) {
      console.warn(`[cascades.applyDeleted] deleteNamespace ${namespace} failed: ${(err as Error).message}`);
    }
  }

  // Step 3: drop the tenant row. FK cascades take care of children. Done
  // SYNCHRONOUSLY (and now BEFORE the volume reap) so the DELETE request
  // returns promptly and the tenant disappears from the API immediately —
  // the reap below can wait up to DEFAULT_REAP_TIMEOUT_MS (45 s) for the PV to
  // Release, which used to hold the request open (>25 s observed) and pile up
  // under concurrent deletes.
  // Clear mTLS configs that reference this tenant's mTLS providers BEFORE the
  // tenant-row delete cascade fires. ingress_mtls_configs.provider_id →
  // tenant_mtls_providers is ON DELETE RESTRICT (a bound provider must not be
  // deletable out from under a route via the API), but during a tenant delete
  // the providers cascade too — and PG's cascade ordering can reach a provider
  // before the route→config cascade, tripping RESTRICT and failing the whole
  // delete. Removing the provider-backed configs first lets the cascade run
  // cleanly. Inline-CA configs (null provider_id) still cascade via their
  // ingress_route_id FK when the routes go. (ADR-054.)
  await ctx.db.delete(ingressMtlsConfigs).where(
    inArray(
      ingressMtlsConfigs.providerId,
      ctx.db
        .select({ id: tenantMtlsProviders.id })
        .from(tenantMtlsProviders)
        .where(eq(tenantMtlsProviders.tenantId, tenantId)),
    ),
  );

  await ctx.db.delete(tenants).where(eq(tenants.id, tenantId));

  // Step 4 (BACKGROUND): reap this namespace's Released PVs + any stranded
  // Longhorn volume CR. Scoped to the NAMESPACE (not the now-deleted row), so
  // it stays correct after the row drop. Best-effort, time-bounded, idempotent;
  // its up-to-45 s PV-Release wait must NOT block the response, so run it
  // detached. Any straggler or failure here is caught by the
  // pv-cleanup-released retry hook + the Orphaned Volumes reaper/UI — the same
  // safety nets that already cover the reap's own internal timeout. (Backgrounding
  // re-opens a brief row-gone-but-volume-pending window the in-line reap used to
  // close, but this detached reap closes it within seconds and the safety nets
  // back it up — strictly better than the pre-reap code, which had no reap.)
  void reapNamespaceVolumes(realReapDeps(ctx.k8s), namespace)
    .then((reap) => {
      if (reap.pvsReaped.length > 0 || reap.lhVolsReaped.length > 0) {
        console.log(
          `[cascades.applyDeleted] reaped ${reap.pvsReaped.length} PV(s) + ${reap.lhVolsReaped.length} Longhorn volume(s) for ${namespace}`
          + (reap.timedOut ? ' (timed out — stragglers left to pv-cleanup retry + orphan UI)' : ''),
        );
      }
    })
    .catch((err) => {
      console.warn(`[cascades.applyDeleted] background volume reap for ${namespace} failed (non-fatal): ${(err as Error).message}`);
    });

  return transitionId;
}
