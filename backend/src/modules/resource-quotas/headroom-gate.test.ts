/**
 * Unit tests for the tenant-quota cluster-headroom gate.
 * Mocks getClusterFailoverHeadroom and the db.select chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vitest hoists vi.mock to the top — must reference functions defined
// later via dynamic import to avoid circular eval.
vi.mock('../platform-storage-policy/failover-headroom.js', () => ({
  getClusterFailoverHeadroom: vi.fn(),
}));

import { getClusterFailoverHeadroom } from '../platform-storage-policy/failover-headroom.js';
import { validateQuotaFitsHeadroom } from './headroom-gate.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const k8sStub = {} as K8sClients;

/**
 * `servers` matters now: the gate picks its budget by cluster SHAPE. With more
 * than one server it enforces failover survivability (tenantAvailable*); with
 * one it enforces plain capacity (total − system), because the failover
 * invariant is vacuous when there is nowhere to fail over to.
 *
 * Defaults to a 3-server cluster so the existing cases keep exercising the
 * failover path they were written for.
 */
function mockHeadroom(opts: {
  cpu: number;
  memoryGi: number;
  clamped?: boolean;
  servers?: number;
  totalCpu?: number;
  totalMemoryGi?: number;
  systemReservedCpu?: number;
  systemReservedMemoryGi?: number;
}) {
  const n = opts.servers ?? 3;
  vi.mocked(getClusterFailoverHeadroom).mockResolvedValueOnce({
    servers: Array.from({ length: n }, (_, i) => ({
      name: `n${i}`, allocatableCpu: 4, allocatableMemoryGi: 8,
    })) as never,
    totalCpu: opts.totalCpu ?? 0,
    totalMemoryGi: opts.totalMemoryGi ?? 0,
    systemReservedCpu: opts.systemReservedCpu ?? 0,
    systemReservedMemoryGi: opts.systemReservedMemoryGi ?? 0,
    failoverReservedCpu: 0,
    failoverReservedMemoryGi: 0,
    tenantAvailableCpu: opts.cpu,
    tenantAvailableMemoryGi: opts.memoryGi,
    tenantUsedCpu: 0,
    tenantUsedMemoryGi: 0,
    singleFailureSurvivable: !opts.clamped,
    headroomClamped: opts.clamped ?? false,
  });
}

/**
 * The gate now reads EFFECTIVE ceilings across all tenants, not the
 * `resource_quotas` override table — which is lazily created and was empty on
 * production, so the gate summed 0 and had never refused anything.
 *
 * `rows` here are what the effective-ceiling query returns: one row per
 * tenant, `cpu`/`mem` already coalesced through
 * quota-override → tenant-override → plan.
 */
function makeDb(rows: Array<{ tenantId: string; cpuCoresLimit: string | null; memoryGbLimit: number | null }>): Database {
  const execute = vi.fn().mockResolvedValue({
    rows: rows.map((r) => ({
      tenant_id: r.tenantId,
      cpu: r.cpuCoresLimit,
      mem: r.memoryGbLimit === null ? null : String(r.memoryGbLimit),
    })),
  });
  return { execute } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The regression this repair exists for.
 *
 * `resource_quotas` is a lazily created OVERRIDE table — a row appears only
 * when an admin edits that tenant's quota. On production it had ZERO rows
 * across 30 tenants, so the old gate summed 0, every projection fitted, and
 * it had never refused anything in its life. The unit tests were green
 * throughout, because they fed the mock quota rows the real system did not
 * have.
 *
 * These assert the case that matters: tenants whose ceiling comes from their
 * PLAN, with no quota row at all, must still be counted.
 */
/**
 * Single-server clusters — this platform's DEFAULT deployment.
 *
 * computeFailoverHeadroom reports tenantAvailable = 0 there, correctly: losing
 * your only server loses everything, so no tenant load is survivable. But a
 * capacity gate built on that number refuses every request forever. Measured
 * on a single-node production cluster: 7.50 allocatable − 2.80 system − 7.50
 * failover reserve = −2.80, clamped to 0.
 *
 * So on one server the gate enforces the invariant that still means
 * something — do not sell more than the machine has, after the platform's
 * own share — and ignores headroomClamped, which is that cluster's permanent
 * resting state.
 */
/**
 * An ALREADY-OVERSOLD cluster — the state the repaired gate actually meets on
 * upgrade. Production when this shipped: ceilings summing to 8.90 cores
 * against a 4.70-core budget.
 *
 * The gate must still let the operator dig out. Refusing on the projected
 * TOTAL alone refuses reductions too, and the 409 tells them to lower another
 * tenant's quota first — the one thing it would have just forbidden.
 */
describe('validateQuotaFitsHeadroom — a cluster that is already oversold', () => {
  const oversold = () => mockHeadroom({
    cpu: 0, memoryGi: 0, clamped: true, servers: 1,
    totalCpu: 7.5, totalMemoryGi: 14,
    systemReservedCpu: 2.8, systemReservedMemoryGi: 4,
  });
  // Others hold 7 cores on their own; budget is 4.70. Nothing this tenant
  // does can bring the total under.
  const others = [{ tenantId: 'a', cpuCoresLimit: '7', memoryGbLimit: 3 }];
  // …and the tenant under edit currently holds 2 cores / 4 GiB.
  const selfAt2 = { tenantId: 'me', cpuCoresLimit: '2', memoryGbLimit: 4 };

  it('allows a REDUCTION even though the total stays over budget', async () => {
    oversold();
    const r = await validateQuotaFitsHeadroom(makeDb([...others, selfAt2]), k8sStub, {
      tenantId: 'me', newCpuLimit: 1, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(true);
    // The overage is still REPORTED — it describes the cluster, not the verdict.
    expect(r.details.overByCpu).toBeGreaterThan(0);
  });

  it('allows a no-op re-save of the same values', async () => {
    oversold();
    const r = await validateQuotaFitsHeadroom(makeDb([...others, selfAt2]), k8sStub, {
      tenantId: 'me', newCpuLimit: 2, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(true);
  });

  it('still refuses an INCREASE', async () => {
    oversold();
    const r = await validateQuotaFitsHeadroom(makeDb([...others, selfAt2]), k8sStub, {
      tenantId: 'me', newCpuLimit: 3, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('CPU over by');
  });

  // Per dimension, not per request: lowering CPU must not buy a memory rise.
  it('refuses the dimension that grows and ignores the one that shrinks', async () => {
    oversold();
    const r = await validateQuotaFitsHeadroom(
      makeDb([{ tenantId: 'a', cpuCoresLimit: '7', memoryGbLimit: 11 }, selfAt2]),
      k8sStub,
      { tenantId: 'me', newCpuLimit: 1, newMemoryLimitGi: 6 },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('memory over by');
    // CPU went DOWN — naming it in the refusal would send the operator to the
    // wrong dimension.
    expect(r.reason).not.toContain('CPU over by');
  });
});

/**
 * Nothing in the route blocks a quota PATCH on an archived tenant, and the sum
 * deliberately excludes archived rows. If the tenant under edit were filtered
 * out with them, selfRow would be null and a single-dimension patch would read
 * the OTHER dimension as the application default rather than its real value.
 */
/**
 * A tenant whose row the query cannot resolve — nonexistent, or (no foreign
 * key declares otherwise) pointing at a plan row that is gone. NOT a normal
 * new signup: a real one has a plan, so its ceiling resolves through the
 * COALESCE and is never null.
 *
 * The baseline for "is this growth?" is ZERO in that state, not the
 * application default. Baselining at the default would make a first grant of
 * exactly DEFAULT_CPU register as a non-increase and sail past a full
 * cluster, which is the case the gate exists for.
 */
/**
 * The gap the renamed test above leaves: a MULTI-server cluster whose failover
 * budget is clamped. The clamp is real there and still blocks growth — but it
 * must not block an operator shrinking their way back out of it.
 */
describe('validateQuotaFitsHeadroom — a clamped multi-server cluster', () => {
  const clampedPeer = () => mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true, servers: 3 });
  const selfAt5 = { tenantId: 'me', cpuCoresLimit: '5', memoryGbLimit: 8 };

  it('allows a reduction', async () => {
    clampedPeer();
    const r = await validateQuotaFitsHeadroom(makeDb([selfAt5]), k8sStub, {
      tenantId: 'me', newCpuLimit: 1, newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(true);
    expect(r.details.headroomClamped).toBe(true);
  });

  it('still blocks growth, and says the failover invariant is why', async () => {
    clampedPeer();
    const r = await validateQuotaFitsHeadroom(makeDb([selfAt5]), k8sStub, {
      tenantId: 'me', newCpuLimit: 6, newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(false);
    expect(r.details.refusedByFailover).toBe(true);
    expect(r.reason).toContain('no failover headroom');
  });
});

describe('validateQuotaFitsHeadroom — the tenant row cannot be resolved', () => {
  it('treats a first grant as growth and gates it on a full cluster', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, servers: 3 });
    const r = await validateQuotaFitsHeadroom(makeDb([]), k8sStub, {
      tenantId: 'brand-new', newCpuLimit: 2, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(false);
  });

  /**
   * A dimension the patch never named must never be the reason for a refusal.
   * With the tenant's row unresolvable the CPU projection falls back to
   * DEFAULT_CPU while its baseline is 0, so deriving "growth" from the
   * projection would refuse a memory-only patch and blame CPU — sending the
   * operator to a field they did not touch.
   */
  it('never refuses for a dimension the patch did not touch', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, servers: 3 });
    const r = await validateQuotaFitsHeadroom(makeDb([]), k8sStub, {
      tenantId: 'orphaned-plan', newCpuLimit: null, newMemoryLimitGi: 1,
    });
    expect(r.details.refusedByCpu).toBe(false);
    expect(r.reason).not.toContain('CPU over by');
    expect(r.details.refusedByMemory).toBe(true);
  });

  /**
   * The realistic new tenant: no resource_quotas row, but a plan that already
   * grants it a ceiling, so the COALESCE resolves. Its first quota PATCH
   * writing back exactly the plan value is a no-op, not growth.
   */
  it('treats a first PATCH that re-states the plan ceiling as a no-op', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, servers: 3 });
    const db = makeDb([{ tenantId: 'new-on-a-plan', cpuCoresLimit: '2', memoryGbLimit: 4 }]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'new-on-a-plan', newCpuLimit: 2, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(true);
  });
});

describe('validateQuotaFitsHeadroom — the tenant under edit is archived', () => {
  it('reads its real current values instead of falling back to defaults', async () => {
    mockHeadroom({ cpu: 10, memoryGi: 20, servers: 3 });
    // Archived tenant currently at 6 cores; the patch touches memory only.
    const db = makeDb([{ tenantId: 'me', cpuCoresLimit: '6', memoryGbLimit: 4 }]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'me', newCpuLimit: null, newMemoryLimitGi: 5,
    });
    // 6, not the DEFAULT_CPU of 2 — that is the whole point.
    expect(r.details.projectedSumCpu).toBe(6);
  });
});

describe('validateQuotaFitsHeadroom — single-server clusters', () => {
  const singleNode = () => mockHeadroom({
    cpu: 0, memoryGi: 0, clamped: true, servers: 1,
    totalCpu: 7.5, totalMemoryGi: 14,
    systemReservedCpu: 2.8, systemReservedMemoryGi: 4,
  });

  it('allows a quota that fits the machine, despite permanently-clamped failover headroom', async () => {
    singleNode();
    // Budget = 7.50 − 2.80 = 4.70 cores. Existing tenants hold 2, asking 2.
    const db = makeDb([{ tenantId: 'a', cpuCoresLimit: '2', memoryGbLimit: 2 }]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'new', newCpuLimit: 2, newMemoryLimitGi: 2,
    });
    expect(r.allowed).toBe(true);
    expect(r.details.headroomCpu).toBeCloseTo(4.7, 5);
  });

  it('still refuses a quota that oversells the machine', async () => {
    singleNode();
    const db = makeDb([{ tenantId: 'a', cpuCoresLimit: '4', memoryGbLimit: 2 }]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'new', newCpuLimit: 2, newMemoryLimitGi: 2,
    });
    expect(r.allowed).toBe(false);
    // Named for what it actually enforces here, not for failover.
    expect(r.reason).toContain('sell more than the server has');
    expect(r.reason).not.toContain('single-failure survivability');
    expect(r.details.overByCpu).toBeCloseTo(1.3, 5);
  });

  // The regression in the other direction: without this the naive read-fix
  // turns the gate from a no-op into a total block on the default deployment.
  it('does not let headroomClamped alone veto on a single server', async () => {
    singleNode();
    const r = await validateQuotaFitsHeadroom(makeDb([]), k8sStub, {
      tenantId: 'new', newCpuLimit: 1, newMemoryLimitGi: 1,
    });
    expect(r.details.headroomClamped).toBe(true);
    expect(r.allowed).toBe(true);
  });

  // On a real multi-server cluster the failover invariant still governs.
  it('keeps enforcing failover survivability when there IS a peer', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true, servers: 3, totalCpu: 12, systemReservedCpu: 1 });
    const r = await validateQuotaFitsHeadroom(makeDb([]), k8sStub, {
      tenantId: 'new', newCpuLimit: 1, newMemoryLimitGi: 1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no failover headroom');
  });
});

describe('validateQuotaFitsHeadroom — ceilings that come from the plan', () => {
  it('counts tenants that have no quota-override row', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    // Two tenants on a 1-core plan and one on 2 — none with an override.
    // Old behaviour: sum 0, accept anything. Correct: sum 4, so 5 overshoots.
    const db = makeDb([
      { tenantId: 'a', cpuCoresLimit: '1', memoryGbLimit: 2 },
      { tenantId: 'b', cpuCoresLimit: '1', memoryGbLimit: 2 },
      { tenantId: 'c', cpuCoresLimit: '2', memoryGbLimit: 2 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'new', newCpuLimit: 5, newMemoryLimitGi: 4,
    });
    expect(r.details.currentSumCpu).toBe(4);
    expect(r.allowed).toBe(false);
    expect(r.details.overByCpu).toBe(1);
  });

  it('would have accepted the same request under the old empty-table read', async () => {
    // The control: with nothing to sum, 5 cores fits in 8 and the gate is
    // silent. This is what production did on every call.
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const r = await validateQuotaFitsHeadroom(makeDb([]), k8sStub, {
      tenantId: 'new', newCpuLimit: 5, newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(true);
    expect(r.details.currentSumCpu).toBe(0);
  });

  // NULL means "fall through to the default", never "unlimited" — a tenant
  // with nothing configured must not escape accounting by being empty.
  it('charges the application default for a tenant with no ceiling anywhere', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([{ tenantId: 'a', cpuCoresLimit: null, memoryGbLimit: null }]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'new', newCpuLimit: 1, newMemoryLimitGi: 1,
    });
    expect(r.details.currentSumCpu).toBe(2);  // DEFAULT_CPU, not 0
  });
});

describe('validateQuotaFitsHeadroom — basic accept/reject decisions', () => {
  it('accepts a quota that fits in the headroom (no other tenants)', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.details.projectedSumCpu).toBe(4);
    expect(r.details.headroomCpu).toBe(8);
  });

  it('rejects a quota that overshoots CPU headroom', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    // One existing tenant at 6 CPU; this tenant adds 4 → sum 10 > 8.
    const db = makeDb([
      { tenantId: 'other', cpuCoresLimit: '6', memoryGbLimit: 4 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 4,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('CPU over by 2');
    expect(r.details.overByCpu).toBe(2);
  });

  it('rejects a quota that overshoots memory headroom even if CPU fits', async () => {
    mockHeadroom({ cpu: 100, memoryGi: 8 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 4,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('memory over by 8');
    expect(r.details.overByMemoryGi).toBe(8);
  });

  // Named for what it proves: a clamped cluster refuses a FIRST GRANT however
  // small it is (baseline 0, so 0.1 is growth). It is NOT "regardless of patch
  // values" any more — a reduction on a clamped cluster is allowed, which the
  // multi-server test below pins.
  it('rejects a first grant on a clamped cluster, however small', async () => {
    mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 0.1,
      newMemoryLimitGi: 0.1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no failover headroom');
    expect(r.details.headroomClamped).toBe(true);
  });

  it('reason string lists BOTH clamp and overage when both conditions hold (review fix)', async () => {
    // Clamped headroom AND request that would also overshoot — the
    // original implementation only mentioned the clamp; the fix lists
    // every reason so operators see the full picture.
    mockHeadroom({ cpu: 0, memoryGi: 0, clamped: true });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 5,
      newMemoryLimitGi: 8,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no failover headroom');
    expect(r.reason).toContain('CPU over by 5');
    expect(r.reason).toContain('memory over by 8');
  });
});

describe('validateQuotaFitsHeadroom — sum across tenants', () => {
  it('uses the application default (2 CPU, 4 GiB) for any tenant whose limit is NULL', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    // Two existing tenants with NULL limits — should each count as 2 CPU + 4 GiB.
    // Plus the patch tenant adding 5 CPU → projected sum 9 > 8.
    const db = makeDb([
      { tenantId: 'a', cpuCoresLimit: null, memoryGbLimit: null },
      { tenantId: 'b', cpuCoresLimit: null, memoryGbLimit: null },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 5,
      newMemoryLimitGi: 4,
    });
    expect(r.details.currentSumCpu).toBe(4); // 2 + 2 from NULL defaults
    expect(r.details.projectedSumCpu).toBe(9); // 4 + 5
    expect(r.allowed).toBe(false);
  });

  it('excludes the patch-target tenant from the current sum (avoids double counting their old quota)', async () => {
    mockHeadroom({ cpu: 10, memoryGi: 16 });
    // The patch target already has a 6 CPU quota in the DB; the patch
    // raises it to 8. Current sum (excluding self) should be 0; projected
    // sum should be 8 (new), not 6 + 8 = 14.
    const db = makeDb([
      { tenantId: 'c1', cpuCoresLimit: '6', memoryGbLimit: 8 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 8,
      newMemoryLimitGi: 8,
    });
    expect(r.details.currentSumCpu).toBe(0); // self excluded
    expect(r.details.projectedSumCpu).toBe(8);
    expect(r.allowed).toBe(true);
  });

  it('falls back to existing DB value when the patch leaves a field unset (null)', async () => {
    mockHeadroom({ cpu: 10, memoryGi: 16 });
    // Existing tenant has 4 CPU / 8 GiB; the patch only raises memory.
    // The gate must keep using 4 for CPU (existing) and combine with 12 GiB (new).
    const db = makeDb([
      { tenantId: 'c1', cpuCoresLimit: '4', memoryGbLimit: 8 },
    ]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: null,
      newMemoryLimitGi: 12,
    });
    expect(r.details.projectedSumCpu).toBe(4); // existing kept
    expect(r.details.projectedSumMemoryGi).toBe(12); // new memory limit
    expect(r.allowed).toBe(true);
  });
});

describe('validateQuotaFitsHeadroom — boundary cases', () => {
  it('accepts a quota that lands exactly on the headroom limit', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 8,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(true);
    expect(r.details.overByCpu).toBe(0);
    expect(r.details.overByMemoryGi).toBe(0);
  });

  it('rejects a quota that lands one unit past the headroom', async () => {
    mockHeadroom({ cpu: 8, memoryGi: 16 });
    const db = makeDb([]);
    const r = await validateQuotaFitsHeadroom(db, k8sStub, {
      tenantId: 'c1',
      newCpuLimit: 8.01,
      newMemoryLimitGi: 16,
    });
    expect(r.allowed).toBe(false);
    expect(r.details.overByCpu).toBeCloseTo(0.01, 6);
  });
});
