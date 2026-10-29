/**
 * A custom container entering `failed` tells the operator AND the tenant. Only
 * the operator was told: the tenant, whose container and plan it is, found out
 * from the Custom Containers tab after a reload.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const adminMock = vi.fn();
const tenantMock = vi.fn();
vi.mock('../notifications/events.js', () => ({
  notifyAdminCustomDeploymentFailed: (...a: unknown[]) => adminMock(...a),
  notifyTenantCustomDeploymentFailed: (...a: unknown[]) => tenantMock(...a),
}));

const { applyReconcileOutcome, asSentence, capReason } = await import('./reconcile.js');

function fakeDb() {
  return {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ name: 'PHOENIX' }]) })) })) })),
  } as never;
}

const ROW = { id: 'd1', tenantId: 't1', name: 'collabora', status: 'deploying', statusMessage: null, currentNodeName: null } as never;
const QUOTA = 'Quota exceeded — memory limit: requesting 1524Mi, already claimed 3600Mi of 5Gi limit. Free up resources or upgrade the plan.';

beforeEach(() => { adminMock.mockReset(); tenantMock.mockReset(); });

describe('applyReconcileOutcome — entering failed', () => {
  it('★ tells the tenant too, with the reason and a link to their containers', async () => {
    await applyReconcileOutcome(fakeDb(), 'd1', ROW, { status: 'failed', statusMessage: QUOTA, node: null });
    expect(adminMock).toHaveBeenCalledTimes(1);
    expect(tenantMock).toHaveBeenCalledTimes(1);
    const [, tenantId, payload, dedupeKey] = tenantMock.mock.calls[0]!;
    expect(tenantId).toBe('t1');
    expect(payload).toEqual({ deploymentName: 'collabora', reason: QUOTA });
    expect(dedupeKey).toMatch(/^cdfail-t:d1:[0-9a-f]{12}$/);
    // The operator's reason ends in one full stop, not "plan.." as it did.
    expect(adminMock.mock.calls[0]![2]).toMatchObject({ reason: QUOTA });
  });

  it('cuts operator-only detail from what the tenant reads', async () => {
    const raw = 'app: CrashLoopBackOff — last exit 70 (Error), 5 restarts; diagnosis: pod app-7f on node sv1';
    await applyReconcileOutcome(fakeDb(), 'd1', ROW, { status: 'failed', statusMessage: raw, node: null });
    expect(tenantMock.mock.calls[0]![2]).toMatchObject({ reason: 'app: CrashLoopBackOff — last exit 70 (Error), 5 restarts.' });
    expect(JSON.stringify(tenantMock.mock.calls[0]![2])).not.toContain('sv1');
  });

  it('says nothing while it stays failed (no transition)', async () => {
    await applyReconcileOutcome(fakeDb(), 'd1', { ...(ROW as object), status: 'failed', statusMessage: 'old' } as never,
      { status: 'failed', statusMessage: QUOTA, node: null });
    expect(adminMock).not.toHaveBeenCalled();
    expect(tenantMock).not.toHaveBeenCalled();
  });
});

describe('capReason', () => {
  it('keeps a reason whole up to the cap, and marks a cut', () => {
    expect(capReason('short')).toBe('short');
    const cut = capReason('x'.repeat(1000));
    expect(cut).toHaveLength(400);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('asSentence', () => {
  it('ends a reason with exactly one full stop', () => {
    expect(asSentence('Free up resources or upgrade the plan.')).toBe('Free up resources or upgrade the plan.');
    expect(asSentence('app: CrashLoopBackOff ')).toBe('app: CrashLoopBackOff.');
    expect(asSentence('trailing dots..')).toBe('trailing dots.');
    expect(asSentence('really?')).toBe('really?');
    expect(asSentence('cut short…')).toBe('cut short…');
  });
});
