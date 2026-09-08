import { describe, it, expect, vi } from 'vitest';
import { getResourceQuota, updateResourceQuota } from './service.js';

const QUOTA = {
  id: 'q1', tenantId: 'c1', cpuCoresLimit: '4.00', memoryGbLimit: 8,
  storageGbLimit: 100, bandwidthGbLimit: 500, cpuCoresCurrent: '1.50',
  memoryGbCurrent: 3, storageGbCurrent: 25, cpuWarningThreshold: '80.00',
  memoryWarningThreshold: 80, storageWarningThreshold: 80, updatedAt: new Date(),
};

function createMockDb(selectResults: unknown[][] = []) {
  let callIdx = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return { select: selectFn, insert: insertFn, update: updateFn } as unknown as Parameters<typeof getResourceQuota>[0];
}

describe('getResourceQuota', () => {
  it('should return existing quota', async () => {
    const db = createMockDb([[QUOTA]]);
    const result = await getResourceQuota(db, 'c1');
    expect(result).toEqual(QUOTA);
  });

  it('should auto-create quota when none exists', async () => {
    const db = createMockDb([[], [QUOTA]]); // first empty, then created
    const result = await getResourceQuota(db, 'c1');
    expect(result).toEqual(QUOTA);
    expect((db as any).insert).toHaveBeenCalled();
  });
});

describe('updateResourceQuota', () => {
  it('should update quota fields', async () => {
    const db = createMockDb([[QUOTA], [QUOTA]]); // get then get after update
    const result = await updateResourceQuota(db, 'c1', { cpu_cores_limit: 8, memory_gb_limit: 16 });
    expect((db as any).update).toHaveBeenCalled();
  });
});

// ─── Float accumulation (production report, 2026-09-08) ──────────────────
//
// A tenant was blocked from deploying with
//   "CPU: 0.10 cores available (0.10 cores required) — Insufficient"
//
// cpuUsed summed per-deployment floats: "100m" parses to 0.1, and IEEE754
// makes 19 x 0.1 = 1.9000000000000006, so `cpuLimit - cpuUsed` lands a few
// ulps BELOW the true remainder. Both numbers render as "0.10" via
// toFixed(2) while `available >= required` is false — the panel says there
// is exactly enough and refuses to deploy in the same sentence.
describe('getTenantResourceAvailability — exact arithmetic', () => {
  const TENANT = { id: 'c1', planId: 'p1', cpuLimitOverride: null, memoryLimitOverride: null, storageLimitOverride: null };
  const PLAN = { id: 'p1', cpuLimit: '2', memoryLimit: '4', storageLimit: '50' };
  const dep = (cpu: string, memory: string) => ({ cpuRequest: cpu, memoryRequest: memory, status: 'running' });

  async function availability(deps: readonly { cpuRequest: string; memoryRequest: string }[]) {
    const { getTenantResourceAvailability } = await import('./service.js');
    return getTenantResourceAvailability(createMockDb([[TENANT], [PLAN], deps]), 'c1');
  }

  it('leaves exactly 0.1 cores after 19x100m against a 2-core limit', async () => {
    const r = await availability(Array.from({ length: 19 }, () => dep('100m', '128Mi')));
    // The float path yields 0.09999999999999942 here.
    expect(r.cpuAvailable).toBe(0.1);
    expect(r.cpuAvailable >= 0.1).toBe(true);
  });

  it('leaves exactly 0.1 cores after mixed sizes summing to 1.9', async () => {
    const r = await availability([dep('1', '1Gi'), dep('500m', '512Mi'), dep('250m', '256Mi'), dep('100m', '128Mi'), dep('50m', '64Mi')]);
    expect(r.cpuAvailable).toBe(0.1);
  });

  it('keeps memory exact (Mi -> Gi is a power-of-two divide, so it never drifted)', async () => {
    // Recorded deliberately: only CPU drifted, because milli-cores divide
    // by 1000 while MiB divide by 1024. A future refactor that routes
    // memory through a decimal unit would reintroduce the same class.
    const r = await availability(Array.from({ length: 5 }, () => dep('10m', '512Mi')));
    expect(r.memoryUsedGi).toBe(2.5);
    expect(r.memoryAvailableGi).toBe(1.5);
  });

  it('still reports a genuine shortfall', async () => {
    const r = await availability(Array.from({ length: 19 }, () => dep('100m', '128Mi')).concat([dep('50m', '64Mi')]));
    expect(r.cpuAvailable).toBe(0.05);
    expect(r.cpuAvailable >= 0.1).toBe(false);
  });
});
