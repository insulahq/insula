import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * placement.ts unit tests — covers the 2026-05-14 streamline self-heal:
 * `getMailPlacement` reads the live Stalwart pod's nodeName and
 * lazily updates `system_settings.mailActiveNode` if it differs from
 * the stored value. Catches the drift the streamline E2E harness G4
 * exposed: pod is on staging3 but DB.mailActiveNode is null because
 * the column is only written by migration runs.
 */

const mockListNode = vi.fn();
const mockListNamespacedPod = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'CoreV1Api') {
        return {
          listNode: mockListNode,
          listNamespacedPod: mockListNamespacedPod,
        };
      }
      return {};
    }
  },
  CoreV1Api: { name: 'CoreV1Api' },
}));

function buildDb(storedActiveNode: string | null = null) {
  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: updateSetWhere })),
  }));
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{
            mailPrimaryNode: 'staging1',
            mailSecondaryNode: 'staging2',
            mailTertiaryNode: null,
            mailActiveNode: storedActiveNode,
            mailDrState: 'healthy',
            mailAutoFailoverEnabled: false,
            mailFailoverThresholdSeconds: 300,
            mailLastFailoverAt: null,
            mailPortExposureMode: 'activeNodeOnly',
          }]),
        })),
      })),
      update,
    } as unknown as import('../../db/index.js').Database,
    update,
    updateSetWhere,
  };
}

describe('mail-admin/placement.getMailPlacement self-heal', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockListNode.mockResolvedValue({ items: [] });
    // Reset the per-process debounce cache between tests so each test
    // sees a fresh "never written" state.
    const { _resetPlacementSelfHealCache } = await import('./placement.js');
    _resetPlacementSelfHealCache();
  });

  it('writes mailActiveNode to DB when live pod differs from stored value', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging3');
    expect(update).toHaveBeenCalled();
  });

  it('does NOT write when live and stored agree (avoid pointless writes)', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb('staging3');
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging3');
    expect(update).not.toHaveBeenCalled();
  });

  it('excludes pods with deletionTimestamp (rollover race protection)', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [
        // Old terminating pod on staging3 — should be ignored
        {
          metadata: { name: 'stalwart-mail-old', deletionTimestamp: '2026-05-14T18:00:00Z' },
          spec: { nodeName: 'staging3' },
          status: { phase: 'Running' },
        },
        // New running pod on staging1 — should be picked
        {
          metadata: { name: 'stalwart-mail-new' },
          spec: { nodeName: 'staging1' },
          status: { phase: 'Running' },
        },
      ],
    });
    const { db } = buildDb('staging3');
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBe('staging1');
  });

  it('falls back to stored value when K8s pod query throws + logs warn', async () => {
    mockListNamespacedPod.mockRejectedValue(new Error('apiserver unreachable'));
    const { db, update } = buildDb('staging2');
    const warn = vi.fn();
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, {
      kubeconfigPath: undefined,
      logger: { warn },
    });
    expect(r.activeNode).toBe('staging2');
    expect(update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('debounces consecutive identical self-heal writes (within 10s)', async () => {
    // Two GET /admin/mail/placement calls landing on the same
    // platform-api pod within the 10s window MUST result in only one
    // DB write — avoid log spam during rollover polling. After 10s,
    // a third call with the same value would write again, but that's
    // outside this test's window.
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' },
        status: { phase: 'Running' },
      }],
    });
    const { db, update } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    await getMailPlacement(db, { kubeconfigPath: undefined });
    await getMailPlacement(db, { kubeconfigPath: undefined });
    await getMailPlacement(db, { kubeconfigPath: undefined });
    // First call writes; subsequent two within debounce window skip.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('returns null activeNode when both live and stored are null', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    const { db } = buildDb(null);
    const { getMailPlacement } = await import('./placement.js');
    const r = await getMailPlacement(db, { kubeconfigPath: undefined });
    expect(r.activeNode).toBeNull();
  });
});

// ─── primaryNode startup self-heal (2026-05-28) ─────────────────────
//
// ensureMailStackPlacementApplied is called once at platform-api boot.
// If `mail_primary_node IS NULL` (fresh bootstrap, or DB row scrubbed)
// it must be backfilled from the most-authoritative source available:
//   1. The Stalwart pod's spec.nodeName (live cluster state)
//   2. mail_active_node (last-known active from prior migration)
// If neither is available, leave primary null + log — the next
// placement update will set it.

function buildDbWithRow(row: Record<string, unknown>) {
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const update = vi.fn((_table: unknown) => ({
    set: vi.fn((patch: Record<string, unknown>) => ({
      where: vi.fn(async () => {
        writes.push({ table: '_systemSettings', patch });
        return undefined;
      }),
    })),
  }));
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([row]),
        })),
      })),
      update,
    } as unknown as import('../../db/index.js').Database,
    writes,
  };
}

describe('mail-admin/placement.ensureMailStackPlacementApplied primary self-heal', () => {
  const mockPatchDeployment = vi.fn(async () => undefined);
  const mockReadDeployment = vi.fn(async () => ({}));
  const mockPatchNode = vi.fn(async () => undefined);
  const mockCreateNamespacedJob = vi.fn(async () => undefined);
  // listNode handle for the sole-server primary-election path. Defaults
  // to empty (most self-heal tests infer primary from the pod, not a
  // node list); the election tests override it.
  const mockSelfHealListNode = vi.fn(async () => ({ items: [] as unknown[] }));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSelfHealListNode.mockResolvedValue({ items: [] });
    // Re-mock k8s client to expose AppsV1Api + BatchV1Api for this
    // describe block (the file-level mock only handles CoreV1Api).
    vi.doMock('@kubernetes/client-node', () => ({
      KubeConfig: class {
        loadFromCluster() {}
        loadFromFile() {}
        makeApiClient(api: unknown) {
          const name = (api as { name?: string })?.name ?? '';
          if (name === 'CoreV1Api') {
            return {
              listNode: mockSelfHealListNode,
              listNamespacedPod: mockListNamespacedPod,
              patchNode: mockPatchNode,
            };
          }
          if (name === 'AppsV1Api') {
            return {
              readNamespacedDeployment: mockReadDeployment,
              patchNamespacedDeployment: mockPatchDeployment,
            };
          }
          if (name === 'BatchV1Api') {
            return { createNamespacedJob: mockCreateNamespacedJob };
          }
          return {};
        }
      },
      CoreV1Api: { name: 'CoreV1Api' },
      AppsV1Api: { name: 'AppsV1Api' },
      BatchV1Api: { name: 'BatchV1Api' },
    }));
  });

  it('backfills mail_primary_node from live Stalwart pod nodeName when DB is NULL', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'worker' },
        status: { phase: 'Running' },
      }],
    });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: null,
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: null,
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeDefined();
    expect(primaryWrite!.patch.mailPrimaryNode).toBe('worker');
  });

  it('backfills mail_primary_node from mail_active_node when live pod query fails', async () => {
    mockListNamespacedPod.mockRejectedValue(new Error('k8s unreachable'));
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: null,
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: 'staging2',
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeDefined();
    expect(primaryWrite!.patch.mailPrimaryNode).toBe('staging2');
  });

  it('does NOT overwrite primary when already set (idempotent on every boot)', async () => {
    mockListNamespacedPod.mockResolvedValue({
      items: [{
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging3' }, // different from primary
        status: { phase: 'Running' },
      }],
    });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: 'staging1', // already set, do NOT clobber
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: 'staging3',
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeUndefined();
  });

  it('leaves primary NULL when no Stalwart pod AND no active node (fresh cluster pre-migration)', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: null,
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: null,
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeUndefined();
  });

  // First/sole cluster server self-assigns primary (2026-05-31).
  // On a fresh single-server bootstrap there is no Stalwart pod and no
  // mail_active_node yet — but the FIRST server must still become the
  // mail primary automatically. When EXACTLY ONE Ready server-role node
  // exists, elect it. >1 servers → ambiguous, leave NULL.
  it('elects the sole Ready server-role node as primary when no pod + no active node', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    // Single Ready server-role node — sole-server primary election.
    mockSelfHealListNode.mockResolvedValue({
      items: [{
        metadata: { name: 'server-1', labels: { 'insula.host/node-role': 'server' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      }],
    });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: null,
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: null,
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeDefined();
    expect(primaryWrite!.patch.mailPrimaryNode).toBe('server-1');
  });

  it('does NOT elect a primary when more than one Ready server exists (ambiguous)', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    // Two Ready server-role nodes — ambiguous, no election.
    mockSelfHealListNode.mockResolvedValue({
      items: [
        {
          metadata: { name: 'server-1', labels: { 'insula.host/node-role': 'server' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: { name: 'server-2', labels: { 'insula.host/node-role': 'server' } },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: null,
      mailSecondaryNode: null,
      mailTertiaryNode: null,
      mailActiveNode: null,
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const primaryWrite = writes.find((w) => 'mailPrimaryNode' in w.patch);
    expect(primaryWrite).toBeUndefined();
  });
});

// ─── updateMailPlacement node-count gate (2026-05-31) ────────────────
//
// Secondary placement requires >=2 Ready candidate nodes ("2 active
// nodes required"); tertiary requires >=3 ("3 active nodes required").
// "Ready candidate node" = a Ready node with role in {server, worker}.
// Setting primary alone on a single node is always allowed.

describe('mail-admin/placement.updateMailPlacement node-count gate', () => {
  const mockReadNode = vi.fn(async () => ({}));
  const mockListNodeGate = vi.fn(async () => ({ items: [] as unknown[] }));

  function buildGateDb() {
    const setWhere = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn(() => ({ set: vi.fn(() => ({ where: setWhere })) }));
    return {
      db: {
        update,
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{}]) })),
        })),
      } as unknown as import('../../db/index.js').Database,
      update,
    };
  }

  function readyCandidates(n: number) {
    // n Ready server-role candidate nodes.
    return Array.from({ length: n }, (_, i) => ({
      metadata: { name: `node-${i}`, labels: { 'insula.host/node-role': 'server' } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('@kubernetes/client-node', () => ({
      KubeConfig: class {
        loadFromCluster() {}
        loadFromFile() {}
        makeApiClient(api: unknown) {
          const name = (api as { name?: string })?.name ?? '';
          if (name === 'CoreV1Api') {
            return { readNode: mockReadNode, listNode: mockListNodeGate };
          }
          return {};
        }
      },
      CoreV1Api: { name: 'CoreV1Api' },
    }));
  });

  it('rejects setting secondary on a single-node cluster with "2 active nodes required"', async () => {
    mockListNodeGate.mockResolvedValue({ items: readyCandidates(1) });
    const { db, update } = buildGateDb();
    const { updateMailPlacement } = await import('./placement.js');
    await expect(
      updateMailPlacement(
        { primaryNode: 'node-0', secondaryNode: 'node-x' },
        db,
        { kubeconfigPath: undefined },
      ),
    ).rejects.toMatchObject({ message: '2 active nodes required' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects setting tertiary on a 2-node cluster with "3 active nodes required"', async () => {
    mockListNodeGate.mockResolvedValue({ items: readyCandidates(2) });
    const { db, update } = buildGateDb();
    const { updateMailPlacement } = await import('./placement.js');
    await expect(
      updateMailPlacement(
        { primaryNode: 'node-0', secondaryNode: 'node-1', tertiaryNode: 'node-x' },
        db,
        { kubeconfigPath: undefined },
      ),
    ).rejects.toMatchObject({ message: '3 active nodes required' });
    expect(update).not.toHaveBeenCalled();
  });

  it('allows setting primary-only on a single-node cluster', async () => {
    mockListNodeGate.mockResolvedValue({ items: readyCandidates(1) });
    const { db, update } = buildGateDb();
    const { updateMailPlacement } = await import('./placement.js');
    await updateMailPlacement(
      { primaryNode: 'node-0' },
      db,
      { kubeconfigPath: undefined },
    );
    expect(update).toHaveBeenCalled();
  });

  it('allows setting secondary when >=2 Ready candidate nodes exist', async () => {
    mockListNodeGate.mockResolvedValue({ items: readyCandidates(2) });
    const { db, update } = buildGateDb();
    const { updateMailPlacement } = await import('./placement.js');
    await updateMailPlacement(
      { primaryNode: 'node-0', secondaryNode: 'node-1' },
      db,
      { kubeconfigPath: undefined },
    );
    expect(update).toHaveBeenCalled();
  });

  it('allows clearing secondary/tertiary (null) regardless of node count', async () => {
    mockListNodeGate.mockResolvedValue({ items: readyCandidates(1) });
    const { db, update } = buildGateDb();
    const { updateMailPlacement } = await import('./placement.js');
    await updateMailPlacement(
      { primaryNode: 'node-0', secondaryNode: null, tertiaryNode: null },
      db,
      { kubeconfigPath: undefined },
    );
    expect(update).toHaveBeenCalled();
  });
});
