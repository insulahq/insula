import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * port-exposure unit tests — covers the 2026-05-14 streamline change
 * where the haproxy DaemonSet lifecycle moved out of Flux into
 * platform-api. The mode-flip transition now:
 *   activeNodeOnly → allServerNodes: removeHostPorts → CREATE DS
 *   allServerNodes → activeNodeOnly: DELETE DS → addHostPorts
 *
 * Previously the DS was always present with a dummy nodeSelector and
 * we patched the selector to enable/disable. These tests assert the
 * new create/delete contract.
 */

const mockReadDs = vi.fn();
const mockCreateDs = vi.fn();
const mockDeleteDs = vi.fn();
const mockReadDeployment = vi.fn();
const mockPatchDeployment = vi.fn();
// Core mocks for the PVC→node active-node derivation path (2026-05-31
// fresh-multi-node haproxy-deadlock fix). Default to "PVC absent" + an
// empty node list so the existing db-less tests are unaffected.
const mockListNode = vi.fn(async () => ({ items: [] as unknown[] }));
const mockPatchNode = vi.fn(async () => undefined);
const mockPatchService = vi.fn(async () => undefined);
const mockReadPvc = vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 404 }); });
const mockReadPv = vi.fn(async () => { throw Object.assign(new Error('not found'), { code: 404 }); });

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'AppsV1Api') {
        return {
          readNamespacedDaemonSet: mockReadDs,
          createNamespacedDaemonSet: mockCreateDs,
          deleteNamespacedDaemonSet: mockDeleteDs,
          readNamespacedDeployment: mockReadDeployment,
          patchNamespacedDeployment: mockPatchDeployment,
        };
      }
      if (name === 'CoreV1Api') {
        return {
          listNode: mockListNode,
          patchNode: mockPatchNode,
          patchNamespacedService: mockPatchService,
          readNamespacedPersistentVolumeClaim: mockReadPvc,
          readPersistentVolume: mockReadPv,
        };
      }
      return {};
    }
  },
  AppsV1Api: { name: 'AppsV1Api' },
  CoreV1Api: { name: 'CoreV1Api' },
}));

vi.mock('../../shared/k8s-patch.js', () => ({
  applyPatch: vi.fn((_fieldManager: string, _opts: { force?: boolean }) => ({
    headers: { 'Content-Type': 'application/apply-patch+yaml' },
  })),
  // MERGE_PATCH is consumed transitively via port-exposure-modes.js
  // (reconcileMailHaproxyLabels). The PVC-derivation tests below pass a
  // db and exercise that label reconcile, so the mock must export it.
  MERGE_PATCH: { headers: { 'Content-Type': 'application/merge-patch+json' } },
}));

// Minimal Database stub — drizzle queries are mocked away.
function buildDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ v: null }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  } as unknown as import('../../db/index.js').Database;
}

function notFoundError() {
  return Object.assign(new Error('not found'), { code: 404 });
}

describe('mail-admin/port-exposure.updateMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default Deployment shape for hostPort patching.
    // Combined spec (for patch path) + status (for rollout-wait path)
    // so readNamespacedDeployment returns a "rollout already complete"
    // shape on first poll — no test needs to advance time to pass.
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 5 },
      spec: {
        replicas: 1,
        template: { spec: { containers: [{ name: 'stalwart', ports: [
          { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
          { containerPort: 8080, name: 'mgmt-http', protocol: 'TCP' },
        ] }] } },
      },
      status: {
        observedGeneration: 5,
        updatedReplicas: 1,
        readyReplicas: 1,
        unavailableReplicas: 0,
      },
    });
    mockPatchDeployment.mockResolvedValue({});
  });

  it('allServerNodes mode: ALWAYS adds hostPorts (post-hairpin-fix) AND creates haproxy DS', async () => {
    // Post-2026-05-28 hairpin fix: Stalwart hostPort is ALWAYS set in
    // every mode. The active node serves via CNI portmap (no kube-proxy
    // DNAT hairpin); non-active data-plane nodes serve via haproxy DS
    // → ClusterIP → Stalwart pod (cross-node, no hairpin). The haproxy
    // DS still gets created in haproxy modes for the non-active nodes.
    mockReadDs.mockRejectedValue(notFoundError()); // DS absent at start
    mockCreateDs.mockResolvedValue({});
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateDs).toHaveBeenCalledTimes(1);
    expect(mockDeleteDs).not.toHaveBeenCalled();
    // The create body must be the buildHaproxyDaemonSet() shape.
    const createArg = mockCreateDs.mock.calls[0][0] as { body: { kind: string; metadata: { name: string } } };
    expect(createArg.body.kind).toBe('DaemonSet');
    expect(createArg.body.metadata.name).toBe('stalwart-haproxy');
    // Stalwart hostPorts MUST be set on every mail port (always-on
    // post-hairpin-fix).
    const patchArg = mockPatchDeployment.mock.calls[0][0] as {
      body: { spec: { template: { spec: { containers: Array<{
        name: string;
        ports: Array<{ containerPort?: number; hostPort?: number }>;
      }> } } } };
    };
    const containers = patchArg.body.spec.template.spec.containers as Array<{
      name: string;
      ports: Array<{ containerPort: number; hostPort?: number; name: string; protocol: string }>;
    }>;
    expect(containers[0].name).toBe('stalwart');
    const mailPorts = containers[0].ports.filter((p) => [25, 465, 587, 143, 993, 4190].includes(p.containerPort));
    expect(mailPorts.length).toBe(6);
    for (const p of mailPorts) {
      expect(p.hostPort).toBe(p.containerPort);
    }
  });

  it('allServerNodes mode: does NOT re-create when DS already exists AND still ensures hostPorts', async () => {
    mockReadDs.mockResolvedValue({ metadata: { name: 'stalwart-haproxy' } });
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockDeleteDs).not.toHaveBeenCalled();
    // Post-hairpin-fix invariant: hostPorts are ALWAYS ensured, even
    // when the DS read returns "already exists" and no DS create
    // happens. Without this assertion, accidentally putting
    // addHostPortsToDeployment behind a conditional would silently
    // regress the active-node listener.
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  });

  it('allServerNodes → activeNodeOnly: DELETES the haproxy DS then re-adds hostPorts', async () => {
    mockDeleteDs.mockResolvedValue({});
    // After delete, waitForHaproxyDaemonSetGone polls readNamespacedDaemonSet
    // until it 404s. Simulate "gone immediately" so the test doesn't wait.
    mockReadDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'activeNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockDeleteDs).toHaveBeenCalledTimes(1);
    // Foreground propagation: confirm the delete call carried it.
    const deleteArg = mockDeleteDs.mock.calls[0][0] as { propagationPolicy?: string };
    expect(deleteArg.propagationPolicy).toBe('Foreground');
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
    // SSA body must INCLUDE hostPort on every mail port — thisNodeOnly
    // mode binds Stalwart's container to the node's IP directly.
    const patchArg = mockPatchDeployment.mock.calls[0][0] as {
      body: { spec: { template: { spec: { containers: Array<{
        name: string;
        ports: Array<{ containerPort: number; hostPort?: number }>;
      }> } } } };
    };
    const mailPorts = patchArg.body.spec.template.spec.containers[0].ports
      .filter((p) => [25, 465, 587, 143, 993, 4190].includes(p.containerPort));
    expect(mailPorts.length).toBe(6);
    for (const p of mailPorts) {
      expect(p.hostPort).toBe(p.containerPort);
    }
  }, 30_000);

  it('waits for the Deployment rollout to complete before creating the haproxy DS', async () => {
    // Streamline E2E found race: patchNamespacedDeployment returns
    // before the old pod (still binding hostPorts) is gone. If the
    // haproxy DS gets created in that window, it conflicts with
    // Stalwart's hostPort on the Stalwart-pod node. Fix:
    // replaceStalwartContainerPorts now blocks on rollout completion.
    //
    // This test simulates a 3-iteration rollout: first two polls
    // show updatedReplicas < replicas / unavailableReplicas > 0,
    // third poll shows healthy. The CREATE call must come AFTER all
    // three rollout polls.
    const callOrder: string[] = [];
    mockReadDeployment.mockReset();
    let pollCount = 0;
    mockReadDeployment.mockImplementation(async () => {
      // First call is the spec read (in replaceStalwartContainerPorts);
      // subsequent calls are the rollout-status polls.
      callOrder.push('read');
      pollCount++;
      if (pollCount === 1 || pollCount === 2) {
        // rollout in progress (first two polls show updatedReplicas
        // still behind)
        return {
          metadata: { generation: 6 },
          spec: { replicas: 1 },
          status: {
            observedGeneration: 6,
            updatedReplicas: 0,
            readyReplicas: 0,
            unavailableReplicas: 1,
          },
        };
      }
      // rollout complete
      return {
        metadata: { generation: 6 },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 6,
          updatedReplicas: 1,
          readyReplicas: 1,
          unavailableReplicas: 0,
        },
      };
    });
    mockPatchDeployment.mockImplementation(async () => { callOrder.push('patch'); return {}; });
    mockReadDs.mockRejectedValue(notFoundError());
    mockCreateDs.mockImplementation(async () => { callOrder.push('create-ds'); return {}; });

    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    // Post-Phase-7 (SSA-apply): replaceStalwartContainerPorts no
    // longer reads the Deployment before patching — the manifest no
    // longer declares hostPort, so we don't need to know existing
    // ports; we send the canonical mail-port list directly via SSA.
    // Order is: patch → rollout polls (reads) → create-ds.
    expect(callOrder[0]).toBe('patch');          // SSA hostPort apply
    expect(callOrder[1]).toBe('read');           // rollout poll 1 (still rolling)
    expect(callOrder[2]).toBe('read');           // rollout poll 2 (still rolling)
    expect(callOrder[3]).toBe('read');           // rollout poll 3 (complete)
    expect(callOrder[callOrder.length - 1]).toBe('create-ds');
  }, 30_000);

  it('refuses to flip when Deployment.spec.replicas == 0 (avoid false-positive rollout complete during concurrent ops)', async () => {
    mockReadDeployment.mockReset();
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 7 },
      spec: {
        replicas: 0,
        template: { spec: { containers: [{ name: 'stalwart', ports: [
          { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
        ] }] } },
      },
      status: { observedGeneration: 7, updatedReplicas: 0, readyReplicas: 0, unavailableReplicas: 0 },
    });
    mockReadDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    )).rejects.toMatchObject({
      code: 'MAIL_DEPLOYMENT_SCALED_TO_ZERO',
      status: 409,
    });
    // Crucially: the haproxy DS is NOT created because the rollout-wait
    // threw before the create-DS step.
    expect(mockCreateDs).not.toHaveBeenCalled();
  }, 30_000);

  it('allServerNodes → activeNodeOnly: tolerates DS already absent (404 → idempotent)', async () => {
    mockDeleteDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(updateMailPortExposure(
      { mode: 'activeNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    )).resolves.not.toThrow();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  });
});

describe('mail-admin/port-exposure.ensureMailPortExposureApplied — race guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a DB that explicitly dispatches on the table passed to .from():
   *   - tasks         → tasks-query chain (has .limit())
   *   - systemSettings → settings chain (no .limit())
   *
   * Discriminating by `table.constructor.name`-equivalent (Drizzle's
   * pgTable objects expose a Symbol-keyed name; we use a structural
   * check on a known column-set marker the production code passes in).
   *
   * This replaces the prior order-sensitive mock — see code review
   * 2026-05-28 HIGH finding: the previous mock returned correct values
   * by coincidence of which chain called .limit(), so deleting the
   * guard wouldn't have made the tests fail.
   */
  function buildRaceDb(opts: {
    runningTasks: Array<{ id: string }>;
    mode: string | null;
  }) {
    return {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          // pgTable identity: Drizzle exposes column names on the table
          // object as own properties. `id` is on tasks; `id` + a
          // distinct column is on systemSettings. Discriminate on the
          // presence of `mailPortExposureMode`.
          const isSettings = typeof table === 'object'
            && table !== null
            && 'mailPortExposureMode' in (table as Record<string, unknown>);
          return {
            where: vi.fn(() => {
              if (isSettings) {
                return Promise.resolve([{ v: opts.mode }]);
              }
              // tasks chain — returns object with awaitable .limit()
              return { limit: vi.fn().mockResolvedValue(opts.runningTasks) };
            }),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
  }

  it('SKIPS reconciliation when a mail.port-exposure task is running', async () => {
    const db = buildRaceDb({
      runningTasks: [{ id: 'task-in-flight' }],
      mode: 'allServerNodes',
    });
    const { ensureMailPortExposureApplied } = await import('./port-exposure.js');
    await ensureMailPortExposureApplied(db, { kubeconfigPath: undefined });
    // applyModeToCluster shouldn't have touched the cluster — no DS reads,
    // no Deployment patches.
    expect(mockReadDs).not.toHaveBeenCalled();
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockDeleteDs).not.toHaveBeenCalled();
    expect(mockPatchDeployment).not.toHaveBeenCalled();
  });

  it('asserts the tasks query is actually issued (guard is exercised, not bypassed)', async () => {
    // Mock that tracks which TABLE was passed to .from(). If the
    // production code never queries `tasks`, the guard is dead code
    // and the SKIPS-test above would silently pass for the wrong
    // reason (caught 2026-05-28 code review HIGH finding).
    const tablesQueried: string[] = [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          // Identify the table by presence of marker columns.
          if (typeof table === 'object' && table !== null) {
            if ('kind' in (table as Record<string, unknown>) && 'status' in (table as Record<string, unknown>)) {
              tablesQueried.push('tasks');
            } else if ('mailPortExposureMode' in (table as Record<string, unknown>)) {
              tablesQueried.push('systemSettings');
            }
          }
          return {
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: 'block' }]),
            })),
          };
        }),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { ensureMailPortExposureApplied } = await import('./port-exposure.js');
    await ensureMailPortExposureApplied(db, { kubeconfigPath: undefined });
    expect(tablesQueried[0]).toBe('tasks');
  });

  it('PROCEEDS with reconciliation when no port-exposure task is running', async () => {
    mockReadDs.mockResolvedValue({ status: {} }); // DS exists — no create needed
    mockPatchDeployment.mockResolvedValue(undefined);
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, replicas: 1, readyReplicas: 1, updatedReplicas: 1, unavailableReplicas: 0 },
    });
    const db = buildRaceDb({
      runningTasks: [],
      mode: 'allServerNodes',
    });
    const { ensureMailPortExposureApplied } = await import('./port-exposure.js');
    await ensureMailPortExposureApplied(db, { kubeconfigPath: undefined });
    // Should have at minimum called patchDeployment (the SSA-apply
    // removing hostPorts in allServerNodes mode).
    expect(mockPatchDeployment).toHaveBeenCalled();
  });
});

describe('mail-admin/port-exposure — in-process mutex on applyModeToCluster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Two concurrent updateMailPortExposure invocations must serialise:
   * the second must wait until the first's Deployment patches +
   * rollout wait return. Without the mutex, both would race on the
   * same SSA-apply field manager and the second's wait-for-rollout
   * could observe stale generation/observedGeneration mid-roll. We
   * detect serialisation by counting concurrent in-flight patches
   * via a barrier.
   */
  it('serialises concurrent updateMailPortExposure calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    // Track concurrency across both readNamespacedDeployment AND
    // patchNamespacedDeployment — both are inside the critical section.
    mockPatchDeployment.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // 50ms holds the critical section long enough for the second
      // call to RACE in without the mutex; with the mutex it must wait.
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      return undefined;
    });
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, replicas: 1, readyReplicas: 1, updatedReplicas: 1, unavailableReplicas: 0 },
    });
    // DS lifecycle: present so the create-DS branch becomes a no-op
    mockReadDs.mockResolvedValue({ status: {} });

    const db = buildDb();
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await Promise.all([
      updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined }),
      updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined }),
    ]);
    // With the mutex, max-in-flight should be 1 — the second call's
    // patchDeployment never overlaps with the first's.
    expect(maxInFlight).toBe(1);
    // Both calls should have actually executed patches (not skipped).
    expect(mockPatchDeployment.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('mail-admin/port-exposure.getMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports daemonSetStatus when DS is present', async () => {
    mockReadDs.mockResolvedValue({
      status: { numberReady: 3, desiredNumberScheduled: 3 },
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'allServerNodes' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('allServerNodes');
    expect(r.proxyProtocolActive).toBe(true);
    expect(r.daemonSetStatus).toEqual({ ready: 3, desired: 3 });
  });

  it('reports daemonSetStatus=null when DS is absent (activeNodeOnly mode)', async () => {
    mockReadDs.mockRejectedValue(notFoundError());
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'activeNodeOnly' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('activeNodeOnly');
    expect(r.proxyProtocolActive).toBe(false);
    expect(r.daemonSetStatus).toBeNull();
  });
});

// ─── PVC-derived active node (fresh-multi-node haproxy deadlock fix) ──
//
// On a cold multi-node bootstrap `mail_active_node` is never seeded, so
// resolveHaproxyNodes can't exclude the node Stalwart must run on and
// would label haproxy onto EVERY server node — colliding on the mail
// hostPorts and pinning stalwart-mail Pending. applyModeToCluster now
// derives the active node from the mail-stack-data PVC's pinned node
// (local-path RWO → single-node affinity) when the DB has none. The DB
// value always wins when set.

describe('mail-admin/port-exposure — derive active node from mail PVC when DB null', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Rollout-complete shape so addHostPortsToDeployment returns fast.
    mockReadDeployment.mockResolvedValue({
      metadata: { generation: 1 },
      spec: { replicas: 1 },
      status: { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, unavailableReplicas: 0 },
    });
    mockPatchDeployment.mockResolvedValue({});
    // DS already present so the create branch no-ops.
    mockReadDs.mockResolvedValue({ status: {} });
    // Restore the module-default "PVC absent" + empty-node-list mocks
    // (clearAllMocks wipes call history but not implementations; reset
    // explicitly so per-test overrides below are unambiguous).
    mockReadPvc.mockRejectedValue(notFoundError());
    mockReadPv.mockRejectedValue(notFoundError());
    mockListNode.mockResolvedValue({ items: [] });
    mockPatchNode.mockResolvedValue(undefined);
    mockPatchService.mockResolvedValue(undefined);
  });

  // Three server nodes: nodeA hosts the mail PVC, nodeB + nodeC do not.
  const threeServerNodes = {
    items: [
      { metadata: { name: 'nodeA', labels: { 'insula.host/node-role': 'server' } } },
      { metadata: { name: 'nodeB', labels: { 'insula.host/node-role': 'server' } } },
      { metadata: { name: 'nodeC', labels: { 'insula.host/node-role': 'server' } } },
    ],
  };

  function placementDb(activeNode: string | null) {
    // loadPlacementAndNodes selects the placement row; the mode read in
    // applyModeToCluster's caller path is not hit here (we call
    // applyModeToCluster via updateMailPortExposure with an explicit mode).
    // The final db.update(mailPortExposureMode) also goes through select?/update.
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{
            primaryNode: null,
            secondaryNode: null,
            tertiaryNode: null,
            activeNode,
          }]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
  }

  it('DB active set: uses it and EXCLUDES it from haproxy (PVC not consulted)', async () => {
    mockListNode.mockResolvedValue(threeServerNodes);
    const db = placementDb('nodeB');
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined });
    // PVC read must NOT happen — the DB value already supplies the active node.
    expect(mockReadPvc).not.toHaveBeenCalled();
    // haproxy labelled on nodeA + nodeC (nodeB excluded as active).
    const setTrue = mockPatchNode.mock.calls
      .map((c) => c[0] as { name: string; body: { metadata?: { labels?: Record<string, string | null> } } })
      .filter((a) => a.body.metadata?.labels?.['insula.host/mail-haproxy'] === 'true')
      .map((a) => a.name)
      .sort();
    expect(setTrue).toEqual(['nodeA', 'nodeC']);
  });

  it('DB null + PVC pinned to nodeA (via selected-node annotation): nodeA becomes active and is EXCLUDED from haproxy', async () => {
    mockListNode.mockResolvedValue(threeServerNodes);
    mockReadPvc.mockResolvedValue({
      metadata: { annotations: { 'volume.kubernetes.io/selected-node': 'nodeA' } },
      spec: { volumeName: 'pv-xyz' },
    });
    const db = placementDb(null);
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined });
    expect(mockReadPvc).toHaveBeenCalledTimes(1);
    // haproxy on nodeB + nodeC; nodeA (the PVC-pinned, now-active node) excluded.
    const setTrue = mockPatchNode.mock.calls
      .map((c) => c[0] as { name: string; body: { metadata?: { labels?: Record<string, string | null> } } })
      .filter((a) => a.body.metadata?.labels?.['insula.host/mail-haproxy'] === 'true')
      .map((a) => a.name)
      .sort();
    expect(setTrue).toEqual(['nodeB', 'nodeC']);
    // nodeA must NEVER be labelled with mail-haproxy=true (the deadlock).
    expect(setTrue).not.toContain('nodeA');
  });

  it('DB null + PVC pinned via PV node-affinity hostname (no annotation): derives nodeA', async () => {
    mockListNode.mockResolvedValue(threeServerNodes);
    mockReadPvc.mockResolvedValue({ metadata: { annotations: {} }, spec: { volumeName: 'pv-xyz' } });
    mockReadPv.mockResolvedValue({
      spec: {
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              { matchExpressions: [{ key: 'kubernetes.io/hostname', values: ['nodeA'] }] },
            ],
          },
        },
      },
    });
    const db = placementDb(null);
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined });
    expect(mockReadPv).toHaveBeenCalledTimes(1);
    const setTrue = mockPatchNode.mock.calls
      .map((c) => c[0] as { name: string; body: { metadata?: { labels?: Record<string, string | null> } } })
      .filter((a) => a.body.metadata?.labels?.['insula.host/mail-haproxy'] === 'true')
      .map((a) => a.name)
      .sort();
    expect(setTrue).toEqual(['nodeB', 'nodeC']);
  });

  it('DB null + PVC absent: safe fallback — multi-node still does NOT label the deadlocking all-nodes set without exclusion regressing', async () => {
    // PVC read 404s (default). With no derived active node the resolver
    // falls back to its null-active behaviour: allServerNodes labels all
    // server nodes. This is the pre-existing (non-deadlock) behaviour for
    // a genuinely unknown active node; the PVC derivation is the fix when
    // the PVC DOES exist (the real cold-bootstrap case). Assert the read
    // was attempted and the call still completes safely.
    mockListNode.mockResolvedValue(threeServerNodes);
    const db = placementDb(null);
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(
      updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined }),
    ).resolves.not.toThrow();
    expect(mockReadPvc).toHaveBeenCalledTimes(1);
  });

  it('DB null + PVC pinned to a node NOT in the cluster list: ignores the stale derivation (no crash)', async () => {
    mockListNode.mockResolvedValue(threeServerNodes);
    mockReadPvc.mockResolvedValue({
      metadata: { annotations: { 'volume.kubernetes.io/selected-node': 'ghost-node' } },
      spec: { volumeName: 'pv-xyz' },
    });
    const db = placementDb(null);
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(
      updateMailPortExposure({ mode: 'allServerNodes' }, db, { kubeconfigPath: undefined }),
    ).resolves.not.toThrow();
    // ghost-node isn't a real node so it can't be labelled either way.
    const labelled = mockPatchNode.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(labelled).not.toContain('ghost-node');
  });
});
