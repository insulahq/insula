import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase A2: bulk operations now route every per-client step through
// the cascade module (applySuspended/applyActive/applyDeleted), which
// in turn dispatches the lifecycle registry. Mocking the entire
// dispatcher stack is impractical at unit-test resolution, so we
// mock the cascade entry points and the bulk-tag helper directly —
// the cascade behaviour itself is exhaustively tested by the
// registry/dispatcher/hook unit tests + the integration-lifecycle
// E2E harness.
const { applySuspendedSpy, applyActiveSpy, applyDeletedSpy, tagSpy, runTransitionSpy } = vi.hoisted(() => ({
  applySuspendedSpy: vi.fn(async () => undefined),
  applyActiveSpy: vi.fn(async () => undefined),
  applyDeletedSpy: vi.fn(async () => undefined),
  tagSpy: vi.fn(async (_db: unknown, _clientId: string, _bulkOpId: string) => 'tx-stub'),
  runTransitionSpy: vi.fn(async () => ({ transitionId: 'tx-stub', state: 'completed' as const, hooksAttempted: 0, hooksOk: 0, hooksFailed: 0 })),
}));
vi.mock('../client-lifecycle/cascades.js', () => ({
  applySuspended: applySuspendedSpy,
  applyActive: applyActiveSpy,
  applyDeleted: applyDeletedSpy,
}));
vi.mock('../client-lifecycle/registry/index.js', () => ({
  runTransition: runTransitionSpy,
}));
vi.mock('../client-lifecycle/bulk-tag.js', () => ({
  tagBulkOpOnLatestTransition: tagSpy,
}));

import { bulkUpdateClientStatus, bulkDeleteClients } from './bulk.js';

function makeDb(byId: Map<string, { id: string; status: string; kubernetesNamespace: string }>) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((cond: { val?: string }) => {
          // The bulk fns call eq(clients.id, id) — our cond.val is the id.
          const id = cond?.val;
          if (id && byId.has(id)) return Promise.resolve([byId.get(id)]);
          return Promise.resolve([]);
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  };
}

const fakeK8s = { core: {}, custom: {}, batch: {} } as never;

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __testEq: true, col, val }),
  };
});

describe('bulkUpdateClientStatus', () => {
  beforeEach(() => {
    applySuspendedSpy.mockClear();
    applyActiveSpy.mockClear();
    tagSpy.mockClear();
  });

  it('bulk suspend: dispatches applySuspended per client + stamps bulkOpId', async () => {
    const db = makeDb(new Map([
      ['c1', { id: 'c1', status: 'active', kubernetesNamespace: 'client-c1' }],
      ['c2', { id: 'c2', status: 'active', kubernetesNamespace: 'client-c2' }],
    ]));
    const result = await bulkUpdateClientStatus(db as never, ['c1', 'c2'], 'suspend', fakeK8s);
    expect(result.bulkOpId).toBeTruthy();
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(applySuspendedSpy).toHaveBeenCalledTimes(2);
    expect(tagSpy).toHaveBeenCalledTimes(2);
    // Both per-client tags carry the SAME bulkOpId.
    expect(tagSpy.mock.calls[0][2]).toBe(result.bulkOpId);
    expect(tagSpy.mock.calls[1][2]).toBe(result.bulkOpId);
  });

  it('bulk reactivate: dispatches applyActive per client', async () => {
    const db = makeDb(new Map([
      ['c3', { id: 'c3', status: 'suspended', kubernetesNamespace: 'client-c3' }],
    ]));
    const result = await bulkUpdateClientStatus(db as never, ['c3'], 'reactivate', fakeK8s);
    expect(applyActiveSpy).toHaveBeenCalledTimes(1);
    expect(result.succeeded).toHaveLength(1);
  });

  it('partial failure: missing clients reported as failed; cascade not called', async () => {
    const db = makeDb(new Map([
      ['c1', { id: 'c1', status: 'active', kubernetesNamespace: 'client-c1' }],
    ]));
    const result = await bulkUpdateClientStatus(db as never, ['c1', 'missing'], 'suspend', fakeK8s);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('missing');
    expect(result.failed[0].error).toContain('not found');
    expect(applySuspendedSpy).toHaveBeenCalledTimes(1); // only c1
  });

  it('empty array returns empty results with valid bulkOpId', async () => {
    const result = await bulkUpdateClientStatus({} as never, [], 'suspend', fakeK8s);
    expect(result.bulkOpId).toBeTruthy();
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(applySuspendedSpy).not.toHaveBeenCalled();
  });

  it('cascade exception: reports per-client failure, does not abort batch', async () => {
    applySuspendedSpy
      .mockRejectedValueOnce(new Error('quiesce-failed'))
      .mockResolvedValueOnce(undefined);
    const db = makeDb(new Map([
      ['c1', { id: 'c1', status: 'active', kubernetesNamespace: 'client-c1' }],
      ['c2', { id: 'c2', status: 'active', kubernetesNamespace: 'client-c2' }],
    ]));
    const result = await bulkUpdateClientStatus(db as never, ['c1', 'c2'], 'suspend', fakeK8s);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('c1');
    expect(result.failed[0].error).toContain('quiesce-failed');
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0].id).toBe('c2');
  });
});

describe('bulkDeleteClients', () => {
  beforeEach(() => {
    applyDeletedSpy.mockClear();
    tagSpy.mockClear();
  });

  it('dispatches applyDeleted per client + stamps bulkOpId', async () => {
    const db = makeDb(new Map([
      ['c1', { id: 'c1', status: 'active', kubernetesNamespace: 'client-c1' }],
      ['c2', { id: 'c2', status: 'active', kubernetesNamespace: 'client-c2' }],
    ]));
    const result = await bulkDeleteClients(db as never, ['c1', 'c2'], fakeK8s);
    expect(result.bulkOpId).toBeTruthy();
    expect(applyDeletedSpy).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toHaveLength(2);
  });

  it('without k8s, falls back to direct DB delete (unit-test path)', async () => {
    const db = makeDb(new Map([
      ['c1', { id: 'c1', status: 'active', kubernetesNamespace: 'client-c1' }],
    ]));
    const result = await bulkDeleteClients(db as never, ['c1']);
    expect(applyDeletedSpy).not.toHaveBeenCalled();
    expect(result.succeeded).toHaveLength(1);
  });
});
