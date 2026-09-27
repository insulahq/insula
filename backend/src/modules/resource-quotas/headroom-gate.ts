/**
 * Tenant-quota provisioning gate.
 *
 * Before saving a quota override, this module checks whether the new limit
 * would push the sum of all tenant commitments past what the cluster can
 * carry, and refuses the write if it would.
 *
 * WHAT IS SUMMED
 * Every non-archived tenant's EFFECTIVE ceiling, not the `resource_quotas`
 * table. That table is a lazily-created override — see sumCurrentQuotas below
 * for why reading it alone made this gate a no-op on every cluster that had
 * never hand-edited a quota. The ceiling is the per-tenant quota override if
 * one exists, else the tenant's plan override, else the plan, else the
 * application default.
 *
 * It is the LIMIT that is summed, not current allocation: the budget has to
 * hold in the worst case where every tenant scales to what it is allowed.
 *
 * WHAT IT IS COMPARED AGAINST depends on the cluster's shape:
 *   - more than one server → the failover-safe budget from
 *     getClusterFailoverHeadroom (allocatable − system baseline − one
 *     server's worth, so a single-node loss can still be rescheduled);
 *   - a single server → allocatable − system baseline. There is nowhere to
 *     fail over to, so reserving a node for it would zero the budget on this
 *     platform's default deployment. See the comment at the branch itself.
 *
 * WHAT IS REFUSED is only a change that makes a breach worse. A reduction or
 * a no-op always passes, even on a cluster that is already oversubscribed —
 * otherwise the gate would block the very remediation its own error message
 * recommends.
 *
 * A `force=true` query param lets a super_admin commit a quota the cluster
 * cannot survive — appropriate for "I accept this risk" (testing, capacity
 * expansion in flight). Both paths emit audit-log entries.
 *
 * KNOWN LIMITATION (deliberately deferred):
 * - No advisory lock around the read-compute-write sequence. Two admin
 *   PATCHes racing within milliseconds could both see "fits" and both
 *   succeed, summing past the limit. Mitigation: this is a UI-driven action
 *   and humans hit it at human cadence. A pg_advisory_xact_lock around the
 *   gate is a follow-up if quota allocation is ever automated.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { getClusterFailoverHeadroom } from '../platform-storage-policy/failover-headroom.js';

export interface QuotaGateInput {
  /** Client whose quota is about to change. */
  readonly tenantId: string;
  /**
   * New limit values. `null` means "leave the existing field alone" —
   * the gate then uses the current DB value for that dimension.
   */
  readonly newCpuLimit: number | null;
  readonly newMemoryLimitGi: number | null;
}

export interface QuotaGateResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly details: {
    readonly currentSumCpu: number;
    readonly currentSumMemoryGi: number;
    readonly projectedSumCpu: number;
    readonly projectedSumMemoryGi: number;
    readonly headroomCpu: number;
    readonly headroomMemoryGi: number;
    /**
     * How far the projected TOTAL sits past the budget. This measures the
     * CLUSTER, not the verdict: a reduction on an oversold cluster is allowed
     * with a positive overBy. Never decide, caption or alert from these —
     * use the refusedBy* flags below, which are the actual reason.
     */
    readonly overByCpu: number;
    readonly overByMemoryGi: number;
    /** The dimension(s) that actually caused a refusal. */
    readonly refusedByCpu: boolean;
    readonly refusedByMemory: boolean;
    readonly refusedByFailover: boolean;
    /** Which invariant was in force — the budget's meaning differs. */
    readonly isSingleServer: boolean;
    /** From getClusterFailoverHeadroom — surfaces structural over-commit. */
    readonly headroomClamped: boolean;
  };
}

interface QuotaRow {
  readonly tenantId: string;
  /**
   * Parsed once, here. Postgres returns these as strings (numeric), and
   * carrying one dimension as a string while the other is a number invites a
   * future "simplification" of one path that misses the other.
   */
  readonly cpuCoresLimit: number | null;
  readonly memoryGbLimit: number | null;
}

/**
 * Sum the EFFECTIVE quota ceiling of every tenant.
 *
 * ★ This used to read `resource_quotas` alone, and that table is a lazily
 * created OVERRIDE: a row appears only when someone edits a tenant's quota
 * through the admin endpoint. On a production cluster with 30 tenants it had
 * **zero rows**, so the sum was always 0, the projected total always fitted,
 * and the gate had never once refused anything. A guard reading a table
 * nothing populates is indistinguishable from no guard at all.
 *
 * A tenant's real ceiling comes from its plan, with two layers of override:
 *
 *   resource_quotas.cpu_cores_limit   explicit per-tenant quota override
 *   tenants.cpu_limit_override        per-tenant plan override
 *   hosting_plans.cpu_limit           the plan
 *   DEFAULT_CPU / DEFAULT_MEM         nothing configured at all
 *
 * NULL still means "fall through", never "unlimited" — the same contract
 * resource-quotas/service.ts uses. If truly-unlimited semantics are ever
 * wanted they need an explicit sentinel; silently reinterpreting NULL would
 * invalidate every existing row.
 *
 * Tenants in `archived` state are excluded: their workloads are torn down, so
 * counting their ceiling would refuse capacity that nothing is holding.
 * `pending` and `suspended` ARE counted — a pending tenant is about to be
 * provisioned and a suspended one is expected back.
 *
 * The tenant under edit is exempt from that exclusion (`OR t.id = …`). Nothing
 * stops an admin PATCHing the quota of an archived tenant, and if the row were
 * filtered out `selfRow` would be null — so a patch that sets only one
 * dimension would silently treat the OTHER as the application default rather
 * than the value the tenant actually has. It is excluded from the sum either
 * way; this only makes sure its current values are known.
 */
interface EffectiveCeilingRow extends Record<string, unknown> {
  tenant_id: string;
  cpu: string | null;
  mem: string | null;
}

async function sumCurrentQuotas(
  db: Database,
  excludeTenantId: string,
): Promise<{ sumCpu: number; sumMemoryGi: number; selfRow: QuotaRow | null }> {
  const DEFAULT_CPU = 2;
  const DEFAULT_MEM = 4;

  const res = await db.execute<EffectiveCeilingRow>(sql`
    SELECT t.id AS tenant_id,
           COALESCE(rq.cpu_cores_limit, t.cpu_limit_override, p.cpu_limit)      AS cpu,
           COALESCE(rq.memory_gb_limit, t.memory_limit_override, p.memory_limit) AS mem
      FROM tenants t
      LEFT JOIN resource_quotas rq ON rq.tenant_id = t.id
      LEFT JOIN hosting_plans   p  ON p.id = t.plan_id
     WHERE t.status <> 'archived' OR t.id = ${excludeTenantId}
  `);

  let sumCpu = 0;
  let sumMemoryGi = 0;
  let selfRow: QuotaRow | null = null;
  for (const r of res.rows ?? []) {
    const cpu = r.cpu != null ? Number(r.cpu) : DEFAULT_CPU;
    const mem = r.mem != null ? Number(r.mem) : DEFAULT_MEM;
    if (r.tenant_id === excludeTenantId) {
      // The tenant under edit is excluded from the sum and returned so the
      // caller can substitute the value it is about to write.
      selfRow = {
        tenantId: r.tenant_id,
        cpuCoresLimit: r.cpu != null ? cpu : null,
        memoryGbLimit: r.mem != null ? mem : null,
      };
      continue;
    }
    sumCpu += Number.isFinite(cpu) ? cpu : DEFAULT_CPU;
    sumMemoryGi += Number.isFinite(mem) ? mem : DEFAULT_MEM;
  }
  return { sumCpu, sumMemoryGi, selfRow };
}

export async function validateQuotaFitsHeadroom(
  db: Database,
  k8s: K8sClients,
  input: QuotaGateInput,
): Promise<QuotaGateResult> {
  const headroom = await getClusterFailoverHeadroom(k8s);
  const { sumCpu, sumMemoryGi, selfRow } = await sumCurrentQuotas(db, input.tenantId);

  const DEFAULT_CPU = 2;
  const DEFAULT_MEM = 4;

  // What this tenant already has established, or null when it has no row at
  // all. `null` in the patch means "leave this dimension alone", so what the
  // patch projects is the established value, or the default if there is none.
  const establishedCpu = selfRow?.cpuCoresLimit ?? null;
  const establishedMemoryGi = selfRow?.memoryGbLimit ?? null;
  const projectedThisCpu = input.newCpuLimit ?? establishedCpu ?? DEFAULT_CPU;
  const projectedThisMemoryGi = input.newMemoryLimitGi ?? establishedMemoryGi ?? DEFAULT_MEM;

  // The baseline the "is this growth?" test measures against. A tenant with
  // nothing established baselines at ZERO, not at the application default:
  // it holds no prior commitment to be no-worse-than, so every core it gains
  // is growth and must be gated. Baselining it at the default instead would
  // let a fresh tenant take DEFAULT_CPU on a full cluster unchecked — the
  // gate would wave through exactly the case it exists to catch.
  const baselineCpu = establishedCpu ?? 0;
  const baselineMemoryGi = establishedMemoryGi ?? 0;

  const projectedSumCpu = sumCpu + projectedThisCpu;
  const projectedSumMemoryGi = sumMemoryGi + projectedThisMemoryGi;

  /**
   * ★ Which budget applies depends on the cluster's SHAPE.
   *
   * `computeFailoverHeadroom` answers "how much tenant load survives losing
   * one server", and on a single-server cluster the honest answer is zero:
   * there is nowhere to reschedule to. That function is right, and its test
   * pins it deliberately — but using it as a CAPACITY budget on one node
   * means the gate refuses every request forever, because the failover
   * reserve is the only node. Measured on a single-node production cluster:
   * 7.50 allocatable − 2.80 system − 7.50 reserve = −2.80, clamped to 0.
   *
   * Single-node is this platform's default deployment, so a gate that is
   * either a no-op (what it was) or a total block (what a naive read-fix
   * makes it) is no better than absent. On one server the failover invariant
   * is vacuous, so enforce the invariant that still means something:
   * do not sell more than the machine has, after the platform's own share.
   */
  const isSingleServer = headroom.servers.length <= 1;
  const budgetCpu = isSingleServer
    ? Math.max(0, headroom.totalCpu - headroom.systemReservedCpu)
    : headroom.tenantAvailableCpu;
  const budgetMemoryGi = isSingleServer
    ? Math.max(0, headroom.totalMemoryGi - headroom.systemReservedMemoryGi)
    : headroom.tenantAvailableMemoryGi;

  const overByCpu = Math.max(0, projectedSumCpu - budgetCpu);
  const overByMemoryGi = Math.max(0, projectedSumMemoryGi - budgetMemoryGi);

  /**
   * ★ Refuse what makes the breach WORSE — never a reduction.
   *
   * `overBy*` measures the projected TOTAL against the budget, so once the
   * other tenants alone exceed it the figure is positive for every possible
   * value of this one. Deciding on that figure alone would refuse a tenant
   * being lowered from 2 cores to 1 exactly as it refuses a rise to 4 — and
   * the 409 this produces tells the operator to "lower another tenant's quota
   * first", which is the one action it would have just made impossible. The
   * only way out would be `?force=true` on every subsequent edit, which turns
   * a safety gate into a nuisance and trains operators to bypass it.
   *
   * Measured on production before this shipped: 30 tenants, ceilings summing
   * to 8.90 cores against a 4.70-core single-node budget. Every quota edit on
   * that cluster — in either direction — would have been refused on the first
   * PATCH after upgrade.
   *
   * So each dimension is refused only when it is over budget AND this patch
   * raises it. A reduction or a no-op always passes: it cannot take the
   * cluster anywhere it is not already.
   */
  // A dimension the patch does not name cannot be growth, whatever the
  // baseline resolves to. Deriving this from the projection instead would
  // read an UNTOUCHED dimension as a DEFAULT_CPU-sized increase whenever the
  // established value is unresolvable — e.g. a tenant whose plan row is
  // missing (nothing declares a foreign key from tenants.plan_id) — and
  // refuse a memory-only patch while citing CPU.
  const increasesCpu = input.newCpuLimit != null && input.newCpuLimit > baselineCpu;
  const increasesMemory =
    input.newMemoryLimitGi != null && input.newMemoryLimitGi > baselineMemoryGi;
  const refusedByCpu = overByCpu > 0 && increasesCpu;
  const refusedByMemory = overByMemoryGi > 0 && increasesMemory;
  // `headroomClamped` means the FAILOVER budget went negative. On a single
  // server that is its permanent resting state and says nothing about
  // capacity, so it must not veto there. Where it does apply it still only
  // blocks growth, for the same reason as above.
  const refusedByFailover =
    !isSingleServer && headroom.headroomClamped && (increasesCpu || increasesMemory);
  const allowed = !refusedByCpu && !refusedByMemory && !refusedByFailover;

  let reason: string | null = null;
  if (!allowed) {
    const parts: string[] = [];
    if (refusedByFailover) {
      parts.push(
        'cluster has no failover headroom (system baseline + one-server reserve ≥ total allocatable)',
      );
    }
    if (refusedByCpu) parts.push(`CPU over by ${overByCpu.toFixed(2)} cores`);
    if (refusedByMemory) parts.push(`memory over by ${overByMemoryGi.toFixed(2)} GiB`);
    const invariant = isSingleServer
      ? 'Granting this quota would sell more than the server has'
      : 'Granting this quota would breach single-failure survivability';
    reason = `${invariant}: ${parts.join('; ')}. Tenant total ${projectedSumCpu.toFixed(2)} CPU / ${projectedSumMemoryGi} GiB vs budget ${budgetCpu.toFixed(2)} CPU / ${budgetMemoryGi.toFixed(2)} GiB.`;
  }

  return {
    allowed,
    reason,
    details: {
      currentSumCpu: sumCpu,
      currentSumMemoryGi: sumMemoryGi,
      projectedSumCpu,
      projectedSumMemoryGi,
      // The budget the decision was made against, not the failover figure —
      // reporting one while deciding on the other is how a refusal becomes
      // impossible to explain.
      headroomCpu: budgetCpu,
      headroomMemoryGi: budgetMemoryGi,
      overByCpu,
      overByMemoryGi,
      refusedByCpu,
      refusedByMemory,
      refusedByFailover,
      isSingleServer,
      headroomClamped: headroom.headroomClamped,
    },
  };
}

/**
 * Re-export for tests that want to stub getClusterFailoverHeadroom +
 * sumCurrentQuotas independently. Kept internal otherwise.
 */
export const __testing = { sumCurrentQuotas };
