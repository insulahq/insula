/**
 * Move every tenant still on the old reservation model to CPU shares,
 * automatically (ADR-062, final step).
 *
 * CPU cores are no longer a plan parameter, so nothing is left to size a
 * reservation tenant from. Moving one used to be an operator's click on
 * Cluster → CPU Scheduling, one tenant at a time, with a review of flagged
 * tenants. This runs that same migration — the same paced pipeline, health
 * gate and task record (runner.ts) — for every tenant left on the old model,
 * one at a time, in the background:
 *
 *   - Flagged tenants are migrated too. The review flags were a tenant whose
 *     measured load exceeds the ceiling its plan grants, and applications the
 *     platform cannot size (a custom image that pins its own CPU, a third-party
 *     catalog manifest). The operator chose automatic migration knowing that;
 *     the flags are logged with the result.
 *   - A tenant whose namespace does not exist (never provisioned, or
 *     archived) has nothing in the cluster to move: it is marked tiered, and
 *     provisioning builds any namespace it gets later on shares.
 *   - A failed or stopped migration is retried a day later, not at once: a
 *     failure the health gate found will not fix itself in fifteen minutes,
 *     and an operator who pressed Stop meant it for now. Each run is a task in
 *     the Task Center, so a failure is visible where the operator looks.
 *
 * One replica at a time (leased); one tenant at a time within it, and at
 * most three a pass. A suspended tenant is migrated like any other: its
 * workloads are scaled to zero, which the health gate counts as healthy.
 */
import type { Logger } from 'pino';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments, platformSettings, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';

/** A failed or stopped migration is tried again after this long. */
export const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_KEY_PREFIX = 'cpu_auto_migrate_attempt:';

export interface LegacyTenant {
  readonly id: string;
  readonly name: string;
  readonly namespace: string | null;
}

export type AttemptOutcome = 'completed' | 'failed' | 'stopped';

export interface Attempt {
  readonly at: string;
  readonly outcome: AttemptOutcome;
  readonly reason: string | null;
}

export interface AutoMigrateDeps {
  readonly listLegacy: () => Promise<readonly LegacyTenant[]>;
  readonly namespaceExists: (namespace: string) => Promise<boolean>;
  /** An application of this tenant is mid-rollout (deploying, upgrading, pending). */
  readonly rollingOut: (tenantId: string) => Promise<boolean>;
  /** Flip a tenant with no namespace to tiered — nothing in the cluster to move. */
  readonly markTiered: (tenantId: string) => Promise<void>;
  /** Run the migration to its end (runner.ts), acknowledging any review flags. */
  readonly migrate: (tenantId: string) => Promise<{ outcome: AttemptOutcome; reason: string | null }>;
  readonly lastAttempt: (tenantId: string) => Promise<Attempt | null>;
  readonly recordAttempt: (tenantId: string, attempt: Attempt) => Promise<void>;
  readonly now: () => Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface AutoMigrateResult {
  readonly migrated: number;
  readonly markedWithoutNamespace: number;
  readonly failed: number;
  readonly waiting: number;
  readonly remaining: number;
}

/** One pass: every legacy tenant not waiting out a retry, oldest first, within the budget. */
export async function autoMigrateLegacyTenants(
  deps: AutoMigrateDeps,
  opts: { readonly budgetMs: number; readonly maxTenants: number },
): Promise<AutoMigrateResult> {
  const started = deps.now().getTime();
  const legacy = await deps.listLegacy();
  let migrated = 0;
  let markedWithoutNamespace = 0;
  let failed = 0;
  let waiting = 0;
  let handled = 0;

  for (const t of legacy) {
    if (deps.now().getTime() - started > opts.budgetMs) break;
    if (migrated + failed >= opts.maxTenants) break;
    handled += 1;

    // Everything about one tenant is inside this try: a cluster read that
    // fails for it (a 403, a timeout) must cost that tenant a day, not abort
    // the pass — oldest first, a tenant that always fails would otherwise
    // starve every tenant behind it on every tick.
    try {
      const prior = await deps.lastAttempt(t.id);
      if (prior && prior.outcome !== 'completed'
        && deps.now().getTime() - Date.parse(prior.at) < RETRY_AFTER_MS) {
        waiting += 1;
        continue;
      }

      if (!t.namespace || !(await deps.namespaceExists(t.namespace))) {
        await deps.markTiered(t.id);
        markedWithoutNamespace += 1;
        deps.log.info({ tenantId: t.id, tenant: t.name }, 'cpu auto-migrate: no namespace — marked tiered');
        continue;
      }

      // The migration re-tiers RUNNING applications only. One mid-rollout
      // would be passed over and keep its old reservation, with the tenant
      // marked tiered and nobody to press Re-apply. Its turn comes next pass.
      if (await deps.rollingOut(t.id)) {
        waiting += 1;
        deps.log.info({ tenantId: t.id, tenant: t.name }, 'cpu auto-migrate: an application is mid-rollout — next pass');
        continue;
      }

      let result: { outcome: AttemptOutcome; reason: string | null };
      try {
        result = await deps.migrate(t.id);
      } catch (err) {
        // A migration someone started by hand is already doing the job.
        if ((err as { code?: string }).code === 'CPU_MIGRATION_IN_PROGRESS') {
          deps.log.info({ tenantId: t.id }, 'cpu auto-migrate: a migration is already running for this tenant');
          continue;
        }
        throw err;
      }
      await deps.recordAttempt(t.id, { at: deps.now().toISOString(), ...result });
      if (result.outcome === 'completed') {
        migrated += 1;
        deps.log.info({ tenantId: t.id, tenant: t.name }, 'cpu auto-migrate: moved to CPU shares');
      } else {
        failed += 1;
        deps.log.warn({ tenantId: t.id, tenant: t.name, outcome: result.outcome, reason: result.reason },
          'cpu auto-migrate: not moved — retried in a day');
      }
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      deps.log.warn({ tenantId: t.id, tenant: t.name, err: reason }, 'cpu auto-migrate: not moved — retried in a day');
      await deps.recordAttempt(t.id, { at: deps.now().toISOString(), outcome: 'failed', reason })
        .catch(() => undefined);
    }
  }

  return { migrated, markedWithoutNamespace, failed, waiting, remaining: legacy.length - handled };
}

// ─── Real dependencies ──────────────────────────────────────────────────────

export function createAutoMigrateDeps(
  db: Database,
  k8s: K8sClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): AutoMigrateDeps {
  return {
    listLegacy: async () => (await db
      .select({ id: tenants.id, name: tenants.name, namespace: tenants.kubernetesNamespace })
      .from(tenants)
      .where(eq(tenants.cpuSchedulingMode, 'legacy'))
      .orderBy(asc(tenants.createdAt), asc(tenants.id))),
    namespaceExists: async (namespace) => {
      try {
        await k8s.core.readNamespace({ name: namespace } as never);
        return true;
      } catch (err) {
        const status = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
        if (status === 404) return false;
        // Not knowing is not "absent": flipping a tenant whose namespace is
        // there would leave its pods sized for the old model.
        throw err;
      }
    },
    rollingOut: async (tenantId) => {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(deployments)
        .where(and(
          eq(deployments.tenantId, tenantId),
          inArray(deployments.status, ['deploying', 'upgrading', 'pending']),
        ));
      return (row?.n ?? 0) > 0;
    },
    markTiered: async (tenantId) => {
      await db.update(tenants)
        .set({ cpuSchedulingMode: 'tiered', cpuMigratedAt: new Date() })
        .where(and(eq(tenants.id, tenantId), eq(tenants.cpuSchedulingMode, 'legacy')));
    },
    migrate: async (tenantId) => {
      const { startTenantCpuMigration } = await import('./runner.js');
      const { outcome } = await startTenantCpuMigration(db, k8s, tenantId, 'system', true);
      return {
        outcome: outcome.status === 'completed' ? 'completed' : outcome.status === 'stopped' ? 'stopped' : 'failed',
        reason: outcome.status === 'failed' ? outcome.reason : null,
      };
    },
    lastAttempt: async (tenantId) => {
      const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
        .where(eq(platformSettings.key, `${ATTEMPT_KEY_PREFIX}${tenantId}`)).limit(1);
      if (!row) return null;
      try { return JSON.parse(row.value) as Attempt; } catch { return null; }
    },
    recordAttempt: async (tenantId, attempt) => {
      await db.execute(sql`
        INSERT INTO platform_settings (setting_key, setting_value, updated_at)
        VALUES (${`${ATTEMPT_KEY_PREFIX}${tenantId}`}, ${JSON.stringify(attempt)}, now())
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()
      `);
    },
    now: () => new Date(),
    log,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;
/** Stop starting new tenants after this; one already running finishes. */
const PASS_BUDGET_MS = 45 * 60 * 1000;
/**
 * At most this many migrations a pass (every 15 minutes). Each one recreates
 * a tenant's pods; a fault that is not the tenant's — a full node, a broken
 * image pull — then shows on a few tenants before the next pass, not on every
 * tenant of the cluster in one go.
 */
const MAX_TENANTS_PER_PASS = 3;

export function startCpuAutoMigrateScheduler(
  db: Database,
  k8s: K8sClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): { stop: () => void } {
  const deps = createAutoMigrateDeps(db, k8s, log);
  const tick = async (): Promise<void> => {
    try {
      // A migration bounds itself (paced steps, health-gate timeouts), so the
      // pass is never given up while one runs; the lease is renewed.
      const leased = await withSchedulerLease(db, 'cpu-auto-migrate', TICK_INTERVAL_MS * 1.5,
        () => autoMigrateLegacyTenants(deps, { budgetMs: PASS_BUDGET_MS, maxTenants: MAX_TENANTS_PER_PASS }),
        { maxHoldMs: Number.POSITIVE_INFINITY, log });
      if (leased.ran && (leased.value.migrated + leased.value.markedWithoutNamespace + leased.value.failed) > 0) {
        log.info({ ...leased.value }, 'cpu auto-migrate: pass complete');
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'cpu auto-migrate: tick threw');
    }
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    interval.unref?.();
  }, INITIAL_DELAY_MS);
  first.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
