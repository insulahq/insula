import { describe, it, expect, vi, beforeEach } from 'vitest';

// mailMigrationInFlight reads mail_migration_runs; these DB fakes have no
// execute(). Default: nothing in flight (tests that need one override it).
const migrationInFlight = vi.fn(async (): Promise<string | null> => null);
vi.mock('./active-node.js', async (orig) => ({
  ...(await orig<typeof import('./active-node.js')>()),
  mailMigrationInFlight: () => migrationInFlight(),
}));


/**
 * placement.ts unit tests — covers the streamline self-heal:
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

// ─── primaryNode startup self-heal ─────────────────────
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
  // The mail volume's node (resolveActiveMailNode). Default: no PVC (404).
  const mockSelfHealReadPvc = vi.fn(async (): Promise<unknown> => { throw Object.assign(new Error('nf'), { code: 404 }); });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSelfHealListNode.mockResolvedValue({ items: [] });
    mockSelfHealReadPvc.mockImplementation(async () => { throw Object.assign(new Error('nf'), { code: 404 }); });
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
              readNamespacedPersistentVolumeClaim: mockSelfHealReadPvc,
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

  // DR failover abandoned mid-run (state machine killed): mail_active_node
  // still names the dead source, the volume (and data) is on the standby, no
  // Stalwart pod is Running. The startup reconcile pinned Stalwart back to the
  // source — Pending forever ("didn't match PersistentVolume's node affinity").
  // Between the migration creating the target PVC and scaling up there is no
  // pod; re-applying affinity (allowRestore=false) would strip the restore
  // stamp the migration just set and make the new pod fresh-start.
  it('leaves the stack alone while a mail migration is in flight', async () => {
    migrationInFlight.mockResolvedValueOnce('run-7');
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockSelfHealReadPvc.mockResolvedValue({ metadata: { annotations: { 'volume.kubernetes.io/selected-node': 'target' } }, spec: {} });
    const { db } = buildDbWithRow({ mailPrimaryNode: 'source', mailSecondaryNode: 'target', mailTertiaryNode: null, mailActiveNode: 'source' });
    const warn = vi.fn();
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined, logger: { warn } });
    expect(mockPatchDeployment).not.toHaveBeenCalled();
    expect(mockPatchNode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-7'));
  });

  it('pins to the node the mail volume is bound to, not a stale stored active node', async () => {
    mockListNamespacedPod.mockResolvedValue({ items: [] });
    mockSelfHealReadPvc.mockResolvedValue({ metadata: { annotations: { 'volume.kubernetes.io/selected-node': 'standby' } }, spec: {} });
    const { db, writes } = buildDbWithRow({
      mailPrimaryNode: 'source', mailSecondaryNode: 'standby', mailTertiaryNode: null, mailActiveNode: 'source',
    });
    const { ensureMailStackPlacementApplied } = await import('./placement.js');
    await ensureMailStackPlacementApplied(db, { kubeconfigPath: undefined });
    const pinned = JSON.stringify(mockPatchDeployment.mock.calls);
    expect(pinned).toContain('"standby"');
    expect(pinned).not.toContain('"source"');
    // A PVC-derived answer is a guess about the future, not a settled fact: not recorded.
    expect(writes.find((w) => 'mailActiveNode' in w.patch)).toBeUndefined();
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

  // First/sole cluster server self-assigns primary.
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

// ─── updateMailPlacement node-count gate ────────────────
//
// Secondary placement requires >=2 Ready candidate nodes ("2 active
// nodes required"); tertiary requires >=3 ("3 active nodes required").
// "Ready candidate node" = a Ready node with role in {server, worker}.
// Setting primary alone on a single node is always allowed.

describe('mail-admin/placement.updateMailPlacement node-count gate', () => {
  const noopApply = vi.fn(async () => undefined);
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
      { apply: noopApply, migrationInFlight: async () => null },
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
      { apply: noopApply, migrationInFlight: async () => null },
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
      { apply: noopApply, migrationInFlight: async () => null },
    );
    expect(update).toHaveBeenCalled();
  });
});

// The standby label (insula.host/mail-standby=true) is what makes the
// mail-stack-standby-replicate DaemonSet stage a warm copy on the secondary.
// Saving placement only wrote the DB; the label was applied by platform-api
// STARTUP alone — so a standby chosen in the UI stayed unlabelled until the
// next deploy, and a DR failover in that window took the restic path (mail
// since the last backup lost). Seen on a 3-server VM cluster: placement saved,
// replicate DaemonSet at 0 desired until a platform-api pod was recreated.
describe('mail-admin/placement.updateMailPlacement applies what it saved', () => {
  const idle = async (): Promise<string | null> => null;
  const mockReadNode = vi.fn(async () => ({}));
  const mockListNodeGate = vi.fn(async () => ({ items: [] as unknown[] }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('@kubernetes/client-node', () => ({
      KubeConfig: class {
        loadFromCluster() {}
        loadFromFile() {}
        makeApiClient() { return { readNode: mockReadNode, listNode: mockListNodeGate }; }
      },
      CoreV1Api: { name: 'CoreV1Api' },
    }));
    mockListNodeGate.mockResolvedValue({ items: [0, 1].map((i) => ({
      metadata: { name: `node-${i}`, labels: { 'insula.host/node-role': 'server' } },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })) });
  });

  function db() {
    const order: string[] = [];
    const setWhere = vi.fn(async () => { order.push('saved'); });
    return {
      order,
      db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: setWhere })) })) } as unknown as import('../../db/index.js').Database,
    };
  }

  it('reconciles the cluster (standby label, affinity) right after saving — not at the next restart', async () => {
    const { db: d, order } = db();
    const apply = vi.fn(async () => { order.push('applied'); });
    const { updateMailPlacement } = await import('./placement.js');
    const opts = { kubeconfigPath: undefined };
    await updateMailPlacement({ primaryNode: 'node-0', secondaryNode: 'node-1', autoFailoverEnabled: true }, d, opts, { apply, migrationInFlight: idle });
    expect(apply).toHaveBeenCalledWith(d, opts);
    expect(order).toEqual(['saved', 'applied']);
  });

  it('a failed apply is reported (placement saved) instead of passing silently', async () => {
    const { db: d, order } = db();
    const apply = vi.fn(async () => { throw new Error('nodes is forbidden'); });
    const { updateMailPlacement } = await import('./placement.js');
    await expect(updateMailPlacement({ primaryNode: 'node-0', secondaryNode: 'node-1' }, d, { kubeconfigPath: undefined }, { apply, migrationInFlight: idle }))
      .rejects.toMatchObject({ code: 'MAIL_PLACEMENT_APPLY_FAILED', message: expect.stringContaining('nodes is forbidden') });
    expect(order).toEqual(['saved']);
  });

  // Applying re-pins the stack to the ACTIVE node; mid-migration that would pull
  // it back to the source while the run moves it to the target.
  it('refuses while a mail migration / DR failover is in flight — nothing saved, nothing applied', async () => {
    const { db: d, order } = db();
    const apply = vi.fn(async () => undefined);
    const { updateMailPlacement } = await import('./placement.js');
    await expect(updateMailPlacement({ primaryNode: 'node-0', secondaryNode: 'node-1' }, d, { kubeconfigPath: undefined },
      { apply, migrationInFlight: async () => 'run-7' }))
      .rejects.toMatchObject({ code: 'MAIL_MIGRATION_ALREADY_RUNNING', status: 409 });
    expect(order).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a refused update applies nothing', async () => {
    mockListNodeGate.mockResolvedValue({ items: [] });
    const { db: d } = db();
    const apply = vi.fn(async () => undefined);
    const { updateMailPlacement } = await import('./placement.js');
    await expect(updateMailPlacement({ primaryNode: 'node-0', secondaryNode: 'node-1' }, d, { kubeconfigPath: undefined }, { apply }))
      .rejects.toMatchObject({ message: '2 active nodes required' });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('mail-admin/placement.applyMailStandbyLabels', () => {
  const STANDBY = 'insula.host/mail-standby';
  const nodes = (labelled: readonly string[]) => ({
    items: ['s1', 's2', 's3'].map((name) => ({
      metadata: { name, labels: labelled.includes(name) ? { [STANDBY]: 'true' } : {} },
    })),
  });

  // After a failback the label stayed on the node that had just become ACTIVE
  // (a replicator copying from its own pod) while the secondary got nothing —
  // the startup reconcile skips during a migration, so only the migration
  // itself can move the label with the stack.
  it('moves the label off the node that just became active, onto the other candidates', async () => {
    const patchNode = vi.fn(async (_req: { name: string; body: Array<{ op: string }> }) => undefined);
    const createNamespacedJob = vi.fn(async () => undefined);
    const core = { listNode: vi.fn(async () => nodes(['s1'])), patchNode };
    const { applyMailStandbyLabels } = await import('./placement.js');
    const standby = await applyMailStandbyLabels(
      core as never, { createNamespacedJob } as never,
      { primary: 's1', secondary: 's2', tertiary: null }, 's1',
    );
    expect(standby).toEqual(['s2']);
    expect(patchNode.mock.calls.map(([req]) => [req.name, req.body[0].op])).toEqual([['s1', 'remove'], ['s2', 'add']]);
    // The de-elected node's copy is parked for the janitor, not left to rot.
    expect(createNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it('after a failover labels the primary (the failback target) and leaves a correct set alone', async () => {
    const patchNode = vi.fn(async (_req: { name: string; body: Array<{ op: string }> }) => undefined);
    const createNamespacedJob = vi.fn(async () => undefined);
    const core = { listNode: vi.fn(async () => nodes(['s2'])), patchNode };
    const { applyMailStandbyLabels } = await import('./placement.js');
    const standby = await applyMailStandbyLabels(
      core as never, { createNamespacedJob } as never,
      { primary: 's1', secondary: 's2', tertiary: 's3' }, 's2',
    );
    expect(standby).toEqual(['s1', 's3']);
    expect(patchNode.mock.calls.map(([req]) => [req.name, req.body[0].op])).toEqual([['s1', 'add'], ['s2', 'remove'], ['s3', 'add']]);

    patchNode.mockClear();
    core.listNode.mockResolvedValueOnce(nodes(['s1', 's3']));
    await applyMailStandbyLabels(core as never, { createNamespacedJob } as never, { primary: 's1', secondary: 's2', tertiary: 's3' }, 's2');
    expect(patchNode).not.toHaveBeenCalled();
  });
});
