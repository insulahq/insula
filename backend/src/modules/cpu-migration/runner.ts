/**
 * Assemble a real migration run (ADR-062 R2): pure decisions from apply.ts,
 * real effects from effects.ts, operator-visible progress via `tasks`.
 *
 * Kept apart from routes.ts so the HTTP layer stays about HTTP.
 */

import { eq, sql, and, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, hostingPlans, tasks } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { runTenantCpuMigration, type MigrationEffects, type MigrationOutcome } from './apply.js';
import { buildRevertPlan, runTenantCpuRevert, type RevertOutcome } from './revert.js';
import { resolveTenantCpu, DEFAULT_LEGACY_CPU_CORES } from './resolve.js';
import { tenantUsageBlocker, ceilingCores } from './tiers.js';
import { describeDeployment, type DeploymentFactsRow } from './describe.js';
import type { DeploymentToRetier } from './plan.js';
import { catalogRepositories } from '../../db/schema.js';
import { DEFAULT_CATALOG_URL } from '../catalog/service.js';
import * as fx from './effects.js';
import * as taskService from '../tasks/service.js';
import { toSafeText } from '@insula/api-contracts';
import * as deploymentService from '../deployments/service.js';

const TASK_KIND = 'cpu_migration';

interface TenantCtx {
  readonly namespace: string;
  readonly tier: ReturnType<typeof resolveTenantCpu>['tier'];
  readonly burstCores: number;
  readonly legacyCores: number;
  readonly mode: 'legacy' | 'tiered';
}

async function loadTenant(db: Database, tenantId: string): Promise<TenantCtx> {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!t) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
  if (!t.kubernetesNamespace) {
    throw new ApiError('TENANT_NOT_PROVISIONED', 'Tenant has no namespace yet', 409, { tenant_id: tenantId });
  }
  const [plan] = t.planId
    ? await db.select().from(hostingPlans).where(eq(hostingPlans.id, t.planId))
    : [undefined];

  // Resolve as if already tiered, to learn the tier/ceiling this tenant WOULD
  // get — the tenant is still legacy at this point, and legacy deliberately
  // reports neither.
  const target = resolveTenantCpu(
    plan ? { cpuLimit: plan.cpuLimit, cpuTier: plan.cpuTier, cpuBurstCores: plan.cpuBurstCores } : null,
    {
      cpuSchedulingMode: 'tiered',
      cpuLimitOverride: t.cpuLimitOverride,
      cpuTierOverride: t.cpuTierOverride,
      cpuBurstCoresOverride: t.cpuBurstCoresOverride,
    },
  );
  const legacy = resolveTenantCpu(
    plan ? { cpuLimit: plan.cpuLimit, cpuTier: null, cpuBurstCores: null } : null,
    {
      cpuSchedulingMode: 'legacy',
      cpuLimitOverride: t.cpuLimitOverride,
      cpuTierOverride: null,
      cpuBurstCoresOverride: null,
    },
  );
  return {
    namespace: t.kubernetesNamespace,
    tier: target.tier,
    burstCores: target.burstCores ?? 1,
    legacyCores: (legacy.requestMillis ?? DEFAULT_LEGACY_CPU_CORES * 1000) / 1000,
    mode: t.cpuSchedulingMode,
  };
}

/**
 * ★ The apply reads the tenant through the SAME describer the dry run uses.
 *
 * It previously re-derived the tier from the deployment's current
 * `cpu_request`, which disagrees with the preview for any catalog app that
 * was ever resized and for every custom deployment at the platform's `100m`
 * default. The operator approved one plan and would have got another. The
 * shared SQL and the shared function are what make that impossible now, not
 * a promise to keep the two in step.
 */
async function describeDeployments(db: Database, tenantId: string): Promise<{
  deployments: DeploymentToRetier[];
  blocked: Array<{ name: string; blocker: string }>;
}> {
  const officialRepo = await db
    .select({ id: catalogRepositories.id })
    .from(catalogRepositories)
    .where(eq(catalogRepositories.url, DEFAULT_CATALOG_URL));
  const officialRepoId = officialRepo[0]?.id ?? null;

  const rows = await db.execute<DeploymentFactsRow>(sql`
    SELECT d.id, d.name, d.tenant_id, d.cpu_request, d.source,
           d.custom_spec, e.resources AS entry_resources, e.source_repo_id
      FROM deployments d
      LEFT JOIN catalog_entries e ON e.id = d.catalog_entry_id
     WHERE d.tenant_id = ${tenantId} AND d.status = 'running'
     ORDER BY d.name
  `);

  const described = (rows.rows ?? []).map((r) => describeDeployment(r, officialRepoId));
  return {
    deployments: described.map((f) => ({
      id: f.id,
      name: f.name,
      currentCpuRequest: String(
        (rows.rows ?? []).find((r) => r.id === f.id)?.cpu_request ?? '',
      ),
      proposedTier: f.proposedTier,
      pinsOwnCpu: f.pinsOwnCpu,
      containerCount: f.containerCount,
      isComposeStack: f.isComposeStack,
    })),
    blocked: described
      .filter((f) => f.blocker !== null)
      .map((f) => ({ name: f.name, blocker: f.blocker as string })),
  };
}

/**
 * The tenant's measured p95, in millicores, or null when nothing was sampled.
 *
 * Same query and same granularity as the dry run — `usage_metrics.
 * deployment_id` is NULL on every CPU row, so a per-deployment p95 does not
 * exist to be read, and the ceiling it is compared against is tenant-wide
 * anyway.
 *
 * A failure here must NOT read as "no usage": null makes tenantUsageBlocker
 * return `no_usage_data`, which is a review flag, not a pass.
 */
async function readTenantP95Millis(db: Database, tenantId: string): Promise<number | null> {
  const rows = await db.execute<{ p95: string | null }>(sql`
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
      FROM usage_metrics
     WHERE "metricType" = 'cpu_cores'
       AND resolution = 'hourly'
       AND tenant_id = ${tenantId}
       AND measurement_timestamp > now() - interval '7 days'
  `);
  const p95 = rows.rows?.[0]?.p95;
  return p95 === null || p95 === undefined ? null : Number(p95) * 1000;
}

export async function startTenantCpuMigration(
  db: Database, k8s: K8sClients, tenantId: string, userId: string,
  acknowledgeBlockers = false,
): Promise<{ taskId: string; outcome: MigrationOutcome }> {
  const ctx = await loadTenant(db, tenantId);
  if (ctx.mode === 'tiered') {
    throw new ApiError('ALREADY_TIERED', 'This tenant is already on tiered CPU scheduling', 409, { tenant_id: tenantId });
  }
  /**
   * ★ Exactly one run per tenant at a time.
   *
   * tasks.start UPSERTs on (kind, ref_id), so a second call does NOT bounce —
   * it resets the SAME row to running and hands back the same id, and two
   * unsynchronised loops then interleave re-tiers, pod deletions and quota
   * patches on one namespace, with whichever finishes last overwriting the
   * other's terminal status. The operator does not have to double-click to
   * reach this: `schedulingMode` stays `legacy` until the very last step, so
   * a page reload mid-run shows an ordinary enabled Migrate button.
   */
  /**
   * ★ Claimed only AFTER the tenant has passed every check.
   *
   * The claim used to come first, so a refusal — a flagged tenant without an
   * acknowledgement being the common one — threw with the task already
   * marked `running`. The next attempt, including the acknowledged retry the
   * error message invites, was then refused with CPU_MIGRATION_IN_PROGRESS
   * until the 15-minute staleness window expired. Found by the edge-case
   * harness on its first run.
   *
   * ★ Atomic, not check-then-act.
   *
   * A plain SELECT followed by tasks.start() is a race, and tasks.start()
   * does not close it: its ON CONFLICT clause UPSERTs, resetting an
   * already-running row to `running` and handing back the same id rather
   * than refusing. Two applies for one tenant would then run two
   * unsynchronised loops over one namespace, interleaving re-tiers, pod
   * replacements and quota patches — and whichever finished last would
   * overwrite the other's terminal status.
   *
   * The advisory lock is taken inside the transaction that performs the
   * check, so the window between deciding and claiming does not exist. It is
   * released when the transaction ends; the `tasks` row is what holds the
   * claim for the run itself.
   */
  const { deployments: deps, blocked } = await describeDeployments(db, tenantId);

  /**
   * ★ Enforce the review the dry run asked for.
   *
   * The page flags a tenant whose applications the platform cannot size
   * safely — a bring-your-own image that pins its own CPU, a manifest from a
   * catalog we do not publish — and a tenant whose MEASURED load already
   * exceeds the ceiling its plan would grant, which would migrate it
   * straight into throttling. Those flags were computed, displayed, and then
   * not checked here at all: `acknowledgeBlockers` was parsed and discarded,
   * so the whole per-tenant review was advisory in the UI and absent on the
   * server.
   */
  const usageBlocker = tenantUsageBlocker(await readTenantP95Millis(db, tenantId), ctx.burstCores);
  if (!acknowledgeBlockers && (blocked.length > 0 || usageBlocker)) {
    const reasons = [
      ...blocked.map((b) => `${b.name}: ${b.blocker}`),
      ...(usageBlocker ? [`tenant: ${usageBlocker}`] : []),
    ];
    throw new ApiError(
      'CPU_MIGRATION_NEEDS_REVIEW',
      `This tenant needs a decision before migrating: ${reasons.join('; ')}`,
      409,
      { tenant_id: tenantId, blockers: reasons },
    );
  }


  await db.transaction(async (tx) => {
    const got = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`cpu_migration:${tenantId}`})) AS locked`,
    );
    if (got.rows?.[0]?.locked !== true) {
      throw new ApiError(
        'CPU_MIGRATION_IN_PROGRESS',
        'A CPU migration is already starting for this tenant',
        409,
        { tenant_id: tenantId },
      );
    }
    const running = await tx.execute<{ id: string; stale: boolean }>(sql`
      SELECT id, (updated_at < NOW() - INTERVAL '15 minutes') AS stale
        FROM tasks
       WHERE kind = ${TASK_KIND} AND ref_id = ${tenantId}
         AND status IN ('running', 'queued')
    `);
    // A run that has not reported progress in 15 minutes is not running — the
    // process died. Every step reports before it starts and the longest is
    // bounded by the health timeout, so silence that long means nobody is
    // driving it. Without this a crash costs the tenant 24 hours, until the
    // orphan reaper.
    const live = (running.rows ?? []).filter((r) => !r.stale);
    if (live.length > 0) {
      throw new ApiError(
        'CPU_MIGRATION_IN_PROGRESS',
        'A CPU migration is already running for this tenant',
        409,
        { tenant_id: tenantId, task_id: live[0].id },
      );
    }
    // Claimed inside the same lock, so a second caller sees `running`.
    await taskService.start(tx as unknown as Database, {
      kind: TASK_KIND,
      refId: tenantId,
      scope: 'admin',
      userId,
      tenantId,
      label: toSafeText('CPU tier migration'),
      target: { type: 'route', href: `/tenants/${tenantId}` },
      details: { tenantId, namespace: ctx.namespace },
      progressPct: 0,
    });
  });

  const claimed = await db.execute<{ id: string }>(sql`
    SELECT id FROM tasks WHERE kind = ${TASK_KIND} AND ref_id = ${tenantId} LIMIT 1
  `);
  const taskId = claimed.rows?.[0]?.id;
  if (!taskId) throw new ApiError('CPU_MIGRATION_FAILED', 'Could not claim a migration task', 500, { tenant_id: tenantId });

  const effects: MigrationEffects = {
    retier: async (deploymentId, from, to) => {
      // Baseline FIRST: if the update fails afterwards we still know what to
      // restore, whereas storing it after a successful change would lose the
      // original on a crash between the two.
      await fx.storePriorRequest(db, deploymentId, from);
      await deploymentService.updateDeploymentResources(db, tenantId, deploymentId, { cpu_request: to }, k8s);
    },
    recreatePods: async (deploymentId) => {
      const row = deps.find((d) => d.id === deploymentId);
      if (row) await fx.recreatePods(k8s, ctx.namespace, row.name, row.proposedTier);
    },
    widenQuotaHeadroom: () => fx.widenQuotaHeadroom(k8s, ctx.namespace, fx.QUOTA_SCOPE_PRIORITY_CLASS),
    ensureLimitRange: (tier, burst) => fx.ensureLimitRange(k8s, ctx.namespace, tier, burst),
    limitRangeExists: () => fx.limitRangeExists(k8s, ctx.namespace),
    readWorkloads: () => fx.readWorkloads(k8s, ctx.namespace),
    readPodCpuLimits: () => fx.readPodCpuLimits(k8s, ctx.namespace),
    deletePods: (names) => fx.deletePods(k8s, ctx.namespace, names),
    applyQuotaLimits: (burst, tiers) => fx.applyQuotaLimits(
      k8s, ctx.namespace, burst, tiers, fx.QUOTA_SCOPE_PRIORITY_CLASS,
    ),
    quotaScopePriorityClass: fx.QUOTA_SCOPE_PRIORITY_CLASS,
    markTiered: () => fx.setSchedulingMode(db, tenantId, 'tiered'),
    report: async (pct, text) => taskService.progress(db, taskId, { pct, text: toSafeText(text) }),
    stopRequested: () => fx.isStopRequested(db, taskId),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };

  // Belt and braces: the claim is live from here, so ANY escape must release
  // it. Reordering the checks above removes the known path; this covers the
  // ones nobody has thought of yet, because a leaked claim locks the tenant
  // out of its own recovery.
  let outcome: MigrationOutcome;
  try {
    outcome = await runTenantCpuMigration(effects, {
      namespace: ctx.namespace,
      deployments: deps,
      tier: ctx.tier ?? 'high',
      burstCores: ctx.burstCores,
    });
  } catch (err) {
    await taskService.finish(db, taskId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    throw err;
  }

  await taskService.finish(db, taskId, {
    status: outcome.status === 'completed' ? 'succeeded'
      : outcome.status === 'stopped' ? 'cancelled' : 'failed',
    error: outcome.status === 'failed' ? outcome.reason : null,
  });
  return { taskId, outcome };
}

/**
 * Evidence that a migration ran, whether or not it finished. Used so a
 * half-applied tenant can still be reverted.
 */
async function migrationArtifacts(
  db: Database, k8s: K8sClients, tenantId: string, namespace: string,
): Promise<{ any: boolean; baselines: number; limitRange: boolean }> {
  const [row] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM deployments
     WHERE tenant_id = ${tenantId} AND cpu_request_pre_migration IS NOT NULL
  `).then((r) => r.rows ?? []);
  const baselines = Number(row?.n ?? 0);
  // A cluster read that fails must not be reported as "no artifacts" — that
  // would resurrect the lock-out this exists to remove.
  const limitRange = await fx.limitRangeExists(k8s, namespace).catch(() => true);
  return { any: baselines > 0 || limitRange, baselines, limitRange };
}

export async function revertTenantCpuMigration(
  db: Database, k8s: K8sClients, tenantId: string,
): Promise<RevertOutcome> {
  const ctx = await loadTenant(db, tenantId);
  /**
   * ★ Refuse only when there is genuinely nothing to undo.
   *
   * `mark_tiered` is the LAST step, so a crash — a killed pod, an eviction,
   * an OOM, anything that is not a caught error — leaves the tenant `legacy`
   * with a LimitRange installed, pods re-tiered, and baselines stored.
   * Gating revert on the mode alone made that state unrecoverable: apply was
   * blocked by the still-"running" task and revert by NOT_TIERED, and the
   * only thing that freed it was the orphan reaper, 24 HOURS later.
   *
   * So the question is not "does the flag say tiered" but "is there any
   * evidence of a migration to undo".
   */
  const artifacts = await migrationArtifacts(db, k8s, tenantId, ctx.namespace);
  if (ctx.mode === 'legacy' && !artifacts.any) {
    throw new ApiError(
      'NOT_TIERED',
      'This tenant is not on tiered CPU scheduling, so there is nothing to revert',
      409,
      { tenant_id: tenantId },
    );
  }
  const rows = await fx.listMigratableDeployments(db, tenantId);
  const plan = buildRevertPlan(rows.map((d) => ({
    id: d.id,
    name: d.name,
    currentCpuRequest: d.cpuRequest,
    cpuRequestPreMigration: d.cpuRequestPreMigration,
  })));

  return runTenantCpuRevert({
    restore: async (deploymentId, to) => {
      await deploymentService.updateDeploymentResources(db, tenantId, deploymentId, { cpu_request: to }, k8s);
      // Only after the restore lands: clearing first would lose the target if
      // the update throws.
      await fx.clearPriorRequest(db, deploymentId);
    },
    removeQuotaLimits: () => fx.removeQuotaLimits(k8s, ctx.namespace, ctx.legacyCores),
    removeLimitRange: () => fx.removeLimitRange(k8s, ctx.namespace),
    rollPodsStillCapped: () => fx.rollPodsStillCapped(
      k8s, ctx.namespace, fx.QUOTA_SCOPE_PRIORITY_CLASS,
    ),
    markLegacy: () => fx.setSchedulingMode(db, tenantId, 'legacy'),
    report: async () => {},
  }, plan);
}

export async function stopTenantCpuMigration(db: Database, tenantId: string, userId: string): Promise<void> {
  const rows = await taskService.snapshot(db, { userId, includeOtherAdmins: true, includeSystem: true });
  const active = rows.find((r) => r.kind === TASK_KIND && r.refId === tenantId
    && (r.status === 'running' || r.status === 'queued'));
  if (!active) {
    throw new ApiError('NO_ACTIVE_MIGRATION', 'No CPU migration is running for this tenant', 409, { tenant_id: tenantId });
  }
  await fx.requestStop(db, active.id);
}
