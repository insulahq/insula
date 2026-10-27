import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { tenants, ingressMtlsConfigs, tenantMtlsProviders, tenantLifecycleTransitions } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { endTransition, runTransition, RESTORED_FROM_ARCHIVE, type DispatchResult, type Transition } from './registry/index.js';
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
  /**
   * When true, the `notify-tenant-on-transition` hook skips the tenant-facing
   * notification for this transition — the admin panel's "Notify tenant"
   * checkbox, unticked.
   *
   * It has to travel on the context because the decision is made per REQUEST
   * and the hook that honours it runs several layers down. it
   * did not travel at all: the contract declared the field, the UI sent it,
   * the hook read `ctx.suppressTenantNotification` — and nothing in between
   * ever set it, so unticking the box emailed the tenant anyway.
   */
  readonly suppressTenantNotification?: boolean;
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
  detail?: Record<string, unknown>,
  /** Finish this transition, cut off in the middle, instead of starting one. */
  resumeTransitionId?: string,
): Promise<string | null> {
  try {
    const result = await runTransition(ctx.db, ctx.k8s, {
      tenantId, namespace, transition, fromStatus, toStatus,
      ...(detail ? { detail } : {}),
      triggeredByUserId: ctx.triggeredByUserId ?? null,
      parentTaskId: ctx.parentTaskId ?? null,
      suppressTenantNotification: ctx.suppressTenantNotification === true,
      ...(resumeTransitionId ? { resumeTransitionId } : {}),
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

// No `applyRestored`: a restore from archive ends suspended
// (`applySuspendedFromArchive`). The `restored` kind and its hook branches stay
// for the transitions of that kind already recorded, which the retry scheduler
// and the pick-up of cut-off transitions may still finish.

export async function applySuspended(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'suspended', null, 'suspended');
}

/**
 * The end of a restore from archive: the tenant comes back SUSPENDED (an
 * operator decision) — its sites on the suspended page, its mail shut, its
 * applications stopped — until it is reactivated. The `suspended` hooks, with
 * `restoredFromArchive` on the transition: the status stamp also clears
 * `archivedAt`, and the tenant is told its account was restored.
 */
export async function applySuspendedFromArchive(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'suspended', 'archived', 'suspended', { [RESTORED_FROM_ARCHIVE]: true });
}

export async function applyArchived(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
): Promise<string | null> {
  return dispatchTransition(ctx, tenantId, namespace, 'archived', null, 'archived');
}

/**
 * A tenant's cascades for an operation that was picked up again after its
 * process died: run them, unless the first run already did — and finish them
 * where it died in the middle.
 *
 * "Already did" is not "the tenant's status has changed". The status is
 * stamped by one hook among several, and the ones after it — the ingress, the
 * tenant's message — had not run when the process died between two of them.
 * So the first run's own transition is looked up: started at or after `since`
 * (the operation's start), of this kind, for this tenant.
 *
 *   - none: the cascades never began — run them;
 *   - still `running`: nobody is, its process is gone — finish it, running
 *     only the hooks that had not ended;
 *   - ended, any way: nothing to do. Hooks that failed are the retry
 *     scheduler's, as after any transition.
 *
 * Returns the transition's id, or null when the registry could not be written.
 *
 * Every kind but a delete, whose cascades end with the tenant's row gone and
 * have their own second run (`applyDeleted`).
 */
export async function applyOnceSince(
  ctx: CascadeCtx,
  tenantId: string,
  namespace: string,
  transition: Exclude<Transition, 'deleted'>,
  since: Date,
  /** The `detail` a transition that never began is started with (`applySuspendedFromArchive`'s). */
  detail?: Record<string, unknown>,
): Promise<string | null> {
  const toStatus = transition === 'restored' ? 'active' : transition;
  const [first] = await ctx.db
    .select({ id: tenantLifecycleTransitions.id, state: tenantLifecycleTransitions.state })
    .from(tenantLifecycleTransitions)
    .where(and(
      eq(tenantLifecycleTransitions.tenantId, tenantId),
      eq(tenantLifecycleTransitions.transitionKind, transition),
      gte(tenantLifecycleTransitions.startedAt, since),
    ))
    .orderBy(desc(tenantLifecycleTransitions.startedAt))
    .limit(1);
  if (!first) return dispatchTransition(ctx, tenantId, namespace, transition, null, toStatus, detail);
  if (first.state !== 'running') return first.id;
  return dispatchTransition(ctx, tenantId, namespace, transition, null, toStatus, undefined, first.id);
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
  /**
   * Finish a delete whose process died among its hooks: the id of its
   * transition. The hooks that ended are not run again; the namespace and the
   * row are dropped as on a first run. Null, with nothing dropped, when the
   * transition turned out to be another process's to finish.
   */
  resumeTransitionId?: string,
): Promise<string | null> {
  // Step 1: dispatch hooks while domains/backup_jobs rows still exist.
  //
  // The transition row outlives the tenant (no FK), and so do its off-site
  // bundles (retained for the deleted-tenant window). It is the only place
  // left that can say WHO a deleted tenant was — the recover screens list
  // deleted tenants by this name. Read before anything is dropped.
  // A convenience: a failed read must never block the delete.
  let goneName: string | null = null;
  try {
    const [gone] = await ctx.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    goneName = gone?.name ?? null;
  } catch { /* named by its namespace slug later */ }
  // The transition is held open across the rest: the hooks are only the first
  // half of a delete, and a row that read `completed` between them and the
  // dropped tenant told the pick-up there was nothing left to finish.
  let dispatched: DispatchResult | null = null;
  try {
    dispatched = await runTransition(ctx.db, ctx.k8s, {
      tenantId, namespace, transition: 'deleted', toStatus: 'deleted',
      triggeredByUserId: ctx.triggeredByUserId ?? null,
      suppressTenantNotification: ctx.suppressTenantNotification === true,
      holdOpen: true,
      ...(resumeTransitionId
        ? { resumeTransitionId }
        : { fromStatus: null, parentTaskId: ctx.parentTaskId ?? null, ...(goneName ? { detail: { tenantName: goneName } } : {}) }),
    });
  } catch (err) {
    // A registry that cannot be written must not keep a tenant from being
    // deleted — the orphan scanner and the retry scheduler are the nets. But
    // a delete being finished goes no further without it: it is finished on a
    // later look, not half-finished now.
    console.warn(`[cascades.applyDeleted] registry write failed for tenant ${tenantId} deleted: ${(err as Error).message}`);
    if (resumeTransitionId) return null;
  }
  // `running` is the dispatcher's "not run": another process holds this
  // transition — the one that began the delete was only slow — and the
  // namespace and the row are that process's to drop as well. Its hooks still
  // read the tenant's rows.
  if (dispatched?.state === 'running') return null;
  const transitionId = dispatched?.transitionId ?? null;
  const endsAs = dispatched?.state ?? null;

  try {
    await dropTenant(ctx, tenantId, namespace);
  } finally {
    // Ended whether or not the drop went through: a delete that failed here
    // has told its caller so, and is the operator's to ask for again — only a
    // process that died leaves the transition open for the pick-up.
    if (transitionId && endsAs) {
      await endTransition(ctx.db, transitionId, endsAs).catch((err: unknown) => {
        console.warn(`[cascades.applyDeleted] could not end the transition ${transitionId}: ${(err as Error).message}`);
      });
    }
  }
  return transitionId;
}

/** A delete's second half: the namespace, then the tenant's row, then — detached — its volumes. */
async function dropTenant(ctx: CascadeCtx, tenantId: string, namespace: string): Promise<void> {
  // Step 2: drop the k8s namespace. `tenants.kubernetes_namespace` is
  // notNull in schema, so no truthy guard — an empty string would
  // indicate a seed bug upstream and should surface as an error.
  // A pending data relocation holds the tenant's volume attached; release it
  // first, or the PVC (and so the namespace) waits on it in Terminating.
  const { releaseRelocationsInNamespace } = await import('../tenant-placement/relocate.js');
  await releaseRelocationsInNamespace(ctx.k8s, namespace);
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
}
