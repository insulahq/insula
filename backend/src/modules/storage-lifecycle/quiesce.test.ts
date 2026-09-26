import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// Deployment scaling now delegates to scaleDeploymentReplicas (raw SSA body)
// because the typed SDK patch drops replicas:0. Mock it and record the calls.
const { scaleReplicaCalls } = vi.hoisted(() => ({
  scaleReplicaCalls: [] as Array<{ namespace: string; name: string; replicas: number }>,
}));
vi.mock('../../shared/scale-deployment.js', () => ({
  STORAGE_QUIESCED_ANNOTATION: 'insula.host/storage-quiesced',
  STORAGE_PREQUIESCE_REPLICAS_ANNOTATION: 'insula.host/pre-quiesce-replicas',
  scaleDeploymentReplicas: vi.fn(async (namespace: string, name: string, replicas: number) => {
    scaleReplicaCalls.push({ namespace, name, replicas });
  }),
}));
beforeEach(() => { scaleReplicaCalls.length = 0; });

import { quiesce, unquiesce, waitForQuiesced, clearQuiesceHold } from './quiesce.js';
import { scaleDeploymentReplicas } from '../../shared/scale-deployment.js';

function mockK8s(opts: {
  deployments?: Array<{ name: string; replicas: number }>;
  cronJobs?: Array<{ name: string; suspend?: boolean }>;
  // mountsPvc defaults true (these pods hold the tenant PVC lock); set false
  // to model a pod that doesn't mount it (e.g. a cert-manager solver pod).
  pods?: Array<{ name: string; mountsPvc?: boolean }>;
  podsAfterDrainCalls?: number;
  /**
   * Deployments that are scaled up but NEVER become available — the shape a
   * quota-rejected or unmountable restore actually has. `unquiesce` now reads
   * Deployment STATUS rather than trusting that the scale PATCH returning 2xx
   * means a pod runs, so the mock has to model status at all.
   */
  neverAvailable?: readonly string[];
  /** Deployments whose ReplicaSet refuses to create pods (reason → message). */
  replicaFailure?: Record<string, string>;
  /** Deployments that 404 on read (deleted by the op itself). */
  missing?: readonly string[];
  /**
   * Deployments that are STILL HELD at 0 with a recorded pre-quiesce count —
   * the shape a stale snapshot must not silently release. name -> count.
   */
  heldWithCount?: Record<string, number>;
} = {}) {
  const scaleCalls: Array<{ name: string; replicas: number }> = [];
  const cronPatchCalls: Array<{ name: string; suspend: boolean }> = [];
  const holdCalls: Array<{ name: string; held: boolean }> = [];
  // The pre-quiesce replica count rides in the SAME annotation patch as the hold,
  // so the mock records both to prove they cannot drift apart.
  const replicaAnnotationCalls: Array<{ name: string; value: string | null }> = [];
  let podsRemaining = opts.pods ?? [];
  let listPodsCallCount = 0;
  const deploymentMap = new Map((opts.deployments ?? []).map((d) => [d.name, d]));
  const cronJobMap = new Map((opts.cronJobs ?? []).map((c) => [c.name, c]));
  return {
    scaleCalls,
    cronPatchCalls,
    holdCalls,
    replicaAnnotationCalls,
    tenant: {
      core: {
        listNamespacedPod: vi.fn().mockImplementation(async () => {
          listPodsCallCount += 1;
          if (opts.podsAfterDrainCalls !== undefined && listPodsCallCount >= opts.podsAfterDrainCalls) {
            podsRemaining = [];
          }
          return { items: podsRemaining.map((p) => ({
            metadata: { name: p.name },
            spec: { volumes: (p.mountsPvc ?? true) ? [{ persistentVolumeClaim: { claimName: 'ns-storage' } }] : [] },
          })) };
        }),
        // Force-delete removes the pod from the remaining set (models kubelet
        // dropping a stuck-Terminating pod once gracePeriodSeconds=0).
        deleteNamespacedPod: vi.fn().mockImplementation(async (args: { name: string }) => {
          podsRemaining = podsRemaining.filter((p) => p.name !== args.name);
        }),
      },
      apps: {
        // Status reader used by unquiesce's "did it actually come back up?"
        // check. Default: whatever replicas were last requested are available,
        // i.e. the happy path. `neverAvailable` / `replicaFailure` model the
        // failures that used to be reported as success.
        readNamespacedDeployment: vi.fn().mockImplementation(async (args: { name: string }) => {
          if ((opts.missing ?? []).includes(args.name)) {
            throw new Error(`HTTP 404: deployments.apps "${args.name}" not found`);
          }
          const lastScale = [...scaleReplicaCalls].reverse().find((c) => c.name === args.name);
          // A test that stubs scaleDeploymentReplicas with mockImplementationOnce
          // bypasses our recorder, so there is no desired count to read back.
          // Those are ordering / failure-visibility tests that assume a healthy
          // restore, so report the workload as satisfied rather than polling
          // until the test times out. Availability failures are modelled
          // explicitly via `neverAvailable` / `replicaFailure`.
          const recorded = lastScale?.replicas ?? deploymentMap.get(args.name)?.replicas;
          const rf = opts.replicaFailure?.[args.name];
          const unavailable = (opts.neverAvailable ?? []).includes(args.name) || Boolean(rf);
          const desired = recorded ?? Number.MAX_SAFE_INTEGER;
          const available = unavailable ? 0 : desired;
          return {
            metadata: {
              annotations: {
                ...((opts.heldWithCount ?? {})[args.name] !== undefined
                  ? {
                    'insula.host/storage-quiesced': 'true',
                    'insula.host/pre-quiesce-replicas': String((opts.heldWithCount ?? {})[args.name]),
                  }
                  : {}),
              },
            },
            spec: { replicas: (opts.heldWithCount ?? {})[args.name] !== undefined ? 0 : desired },
            status: {
              availableReplicas: available,
              conditions: rf
                ? [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: rf }]
                : [],
            },
          };
        }),
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: (opts.deployments ?? []).map((d) => ({
            metadata: { name: d.name },
            spec: { replicas: d.replicas },
          })),
        }),
        // scale via strategic-merge PATCH on the Deployment (read-modify-
        // replace on /scale silently no-ops under client-node v1.x).
        // Scaling now goes through scaleDeploymentReplicas (mocked). This is
        // only hit for the quiesce-hold annotation patch (and tolerates a
        // legacy spec.replicas body just in case).
        patchNamespacedDeployment: vi.fn().mockImplementation(async (args: {
          name: string; body: { metadata?: { annotations?: Record<string, string | null> }; spec?: { replicas?: number } };
        }, _opts: unknown) => {
          const ann = args.body?.metadata?.annotations;
          if (ann && 'insula.host/storage-quiesced' in ann) {
            holdCalls.push({ name: args.name, held: ann['insula.host/storage-quiesced'] === 'true' });
          }
          if (ann && 'insula.host/pre-quiesce-replicas' in ann) {
            replicaAnnotationCalls.push({
              name: args.name,
              value: (ann['insula.host/pre-quiesce-replicas'] ?? null) as string | null,
            });
          }
          if (args.body?.spec?.replicas !== undefined) scaleCalls.push({ name: args.name, replicas: args.body.spec.replicas });
        }),
      },
      batch: {
        listNamespacedCronJob: vi.fn().mockResolvedValue({
          items: (opts.cronJobs ?? []).map((cj) => ({
            metadata: { name: cj.name },
            spec: { suspend: cj.suspend ?? false },
          })),
        }),
        patchNamespacedCronJob: vi.fn().mockImplementation(async (args: {
          name: string; body: { spec: { suspend: boolean } };
        }, _opts: unknown) => {
          cronPatchCalls.push({ name: args.name, suspend: args.body.spec.suspend });
        }),
        listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
        deleteNamespacedJob: vi.fn().mockResolvedValue({}),
      },
    } as unknown as K8sClients,
  };
}

describe('quiesce', () => {
  it('scales every running deployment to 0 and remembers prior replicas', async () => {
    const m = mockK8s({
      deployments: [
        { name: 'wordpress', replicas: 1 },
        { name: 'mariadb', replicas: 1 },
        { name: 'redis', replicas: 0 }, // already-zero deployment must still be recorded
      ],
    });
    const snap = await quiesce(m.tenant, 'ns');
    expect(snap.deployments).toEqual([
      { name: 'wordpress', replicas: 1 },
      { name: 'mariadb', replicas: 1 },
      { name: 'redis', replicas: 0 },
    ]);
    // But only the running ones get scaled-to-0 calls
    expect(scaleReplicaCalls.map((c) => ({ name: c.name, replicas: c.replicas }))).toEqual([
      { name: 'wordpress', replicas: 0 },
      { name: 'mariadb', replicas: 0 },
    ]);
  });

  it('suspends CronJobs that are currently active and remembers prior suspend state', async () => {
    const m = mockK8s({
      cronJobs: [
        { name: 'wp-cron', suspend: false },
        { name: 'backup', suspend: true }, // already suspended
      ],
    });
    const snap = await quiesce(m.tenant, 'ns');
    expect(snap.cronJobs).toEqual([
      { name: 'wp-cron', wasSuspended: false },
      { name: 'backup', wasSuspended: true },
    ]);
    expect(m.cronPatchCalls).toEqual([{ name: 'wp-cron', suspend: true }]);
  });

  it('idempotent: re-quiescing emits zero new patch calls', async () => {
    const m = mockK8s({
      deployments: [{ name: 'x', replicas: 0 }],
      cronJobs: [{ name: 'c', suspend: true }],
    });
    await quiesce(m.tenant, 'ns');
    expect(scaleReplicaCalls).toEqual([]);
    expect(m.cronPatchCalls).toEqual([]);
  });

  it('sets the storage-quiesced hold on each scaled deployment (so ensureFileManagerRunning will not fight quiesce)', async () => {
    const m = mockK8s({ deployments: [{ name: 'file-manager', replicas: 1 }] });
    await quiesce(m.tenant, 'ns');
    expect(m.holdCalls).toContainEqual({ name: 'file-manager', held: true });
  });

  it('persists the snapshot BEFORE scaling anything down (force-cancel safety)', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }, { name: 'mdb', replicas: 2 }] });
    let scaledWhenPersisted = -1;
    const snap = await quiesce(m.tenant, 'ns', async (s) => {
      // The full pre-quiesce state must be captured, and NOTHING scaled yet.
      expect(s.deployments).toEqual([{ name: 'wp', replicas: 1 }, { name: 'mdb', replicas: 2 }]);
      scaledWhenPersisted = scaleReplicaCalls.length;
    });
    expect(scaledWhenPersisted).toBe(0);          // persist ran before any scale-to-0
    expect(scaleReplicaCalls).toHaveLength(2);     // and scaling still happened afterwards
    expect(snap.deployments).toHaveLength(2);
  });
});

describe('waitForQuiesced', () => {
  it('returns 0 immediately when no pods match the selector', async () => {
    const m = mockK8s({ pods: [] });
    await expect(waitForQuiesced(m.tenant, 'ns', 5000)).resolves.toBe(0);
  });

  it('polls until pods drain, then returns 0', async () => {
    const m = mockK8s({ pods: [{ name: 'p1' }], podsAfterDrainCalls: 2 });
    const result = await waitForQuiesced(m.tenant, 'ns', 5000);
    expect(result).toBe(0);
  });

  it('throws when timeout exceeded', async () => {
    const m = mockK8s({ pods: [{ name: 'stuck' }] });
    await expect(waitForQuiesced(m.tenant, 'ns', 50)).rejects.toThrow(/1 pod.* still running/);
  });

  it('ignores pods that do NOT mount the tenant PVC (e.g. a cert-manager solver pod)', async () => {
    // A cm-acme-http-solver pod that can never pass HTTP-01 lingers forever but
    // holds no PVC lock — quiesce must not wait on it.
    const m = mockK8s({ pods: [{ name: 'cm-acme-http-solver-x', mountsPvc: false }] });
    await expect(waitForQuiesced(m.tenant, 'ns', 50)).resolves.toBe(0);
  });

  it('force-deletes a PVC-mounting pod that overstays the grace window, then returns 0', async () => {
    // A stuck-Terminating file-manager pod (slow Longhorn unmount on single-node)
    // would otherwise hang quiesce until timeout. Force-delete releases the PVC.
    const m = mockK8s({ pods: [{ name: 'file-manager-stuck', mountsPvc: true }] });
    // timeout 5s, force-delete after 10ms → escalates almost immediately.
    const res = await waitForQuiesced(m.tenant, 'ns', 5000, 10);
    expect(res).toBe(0);
    const delSpy = (m.tenant.core as unknown as { deleteNamespacedPod: ReturnType<typeof vi.fn> }).deleteNamespacedPod;
    expect(delSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'file-manager-stuck', namespace: 'ns', gracePeriodSeconds: 0 }));
  });

  it('does NOT force-delete when forceDeleteAfterMs=0 (escalation disabled) — times out instead', async () => {
    const m = mockK8s({ pods: [{ name: 'file-manager-stuck', mountsPvc: true }] });
    await expect(waitForQuiesced(m.tenant, 'ns', 50, 0)).rejects.toThrow(/still running/);
    const delSpy = (m.tenant.core as unknown as { deleteNamespacedPod: ReturnType<typeof vi.fn> }).deleteNamespacedPod;
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('still waits on a PVC-mounting pod even alongside a non-mounting one', async () => {
    const m = mockK8s({ pods: [
      { name: 'cm-acme-http-solver-x', mountsPvc: false },
      { name: 'file-manager', mountsPvc: true },
    ] });
    await expect(waitForQuiesced(m.tenant, 'ns', 50)).rejects.toThrow(/1 pod.* still running.*file-manager/);
  });
});

describe('unquiesce', () => {
  it('scales deployments back to their pre-quiesce replica counts', async () => {
    const m = mockK8s();
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }, { name: 'mdb', replicas: 1 }, { name: 'redis', replicas: 0 }],
      cronJobs: [],
    });
    // redis was at 0 before quiesce — leave it at 0
    expect(scaleReplicaCalls.map((c) => ({ name: c.name, replicas: c.replicas }))).toEqual([
      { name: 'wp', replicas: 1 },
      { name: 'mdb', replicas: 1 },
    ]);
  });

  it('clears the storage-quiesced hold on each deployment so the file-manager can auto-start again', async () => {
    const m = mockK8s();
    await unquiesce(m.tenant, 'ns', { deployments: [{ name: 'file-manager', replicas: 1 }], cronJobs: [] });
    expect(m.holdCalls).toContainEqual({ name: 'file-manager', held: false });
  });

  it('only unsuspends CronJobs that were previously active', async () => {
    const m = mockK8s();
    await unquiesce(m.tenant, 'ns', {
      deployments: [],
      cronJobs: [{ name: 'wp-cron', wasSuspended: false }, { name: 'backup', wasSuspended: true }],
    });
    expect(m.cronPatchCalls).toEqual([{ name: 'wp-cron', suspend: false }]);
  });

  it('best-effort: a hold-clear that 404s during restore does not block the rest', async () => {
    const m = mockK8s();
    (m.tenant.apps as unknown as { patchNamespacedDeployment: ReturnType<typeof vi.fn> })
      .patchNamespacedDeployment
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('404'), { statusCode: 404 })))
      .mockResolvedValueOnce({});
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'gone', replicas: 1 }, { name: 'alive', replicas: 2 }],
      cronJobs: [],
    })).resolves.not.toThrow();
  });

  // ── restore-ordering + failure-visibility regression suite ──────────
  // The bug: unquiesce cleared the quiesce-hold annotation BEFORE scaling
  // back up, and swallowed scale-up failures. A failed scale-up therefore
  // left the tenant at 0 replicas with the watchdog's only marker already
  // erased and the op reported as successful — a silent tenant outage.

  it('scales UP before clearing the hold (the hold is the watchdog handle)', async () => {
    const m = mockK8s();
    const order: string[] = [];
    vi.mocked(scaleDeploymentReplicas).mockImplementationOnce(async () => { order.push('scale'); });
    (m.tenant.apps as unknown as { patchNamespacedDeployment: ReturnType<typeof vi.fn> })
      .patchNamespacedDeployment.mockImplementationOnce(async () => { order.push('clear-hold'); });

    await unquiesce(m.tenant, 'ns', { deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [] });

    expect(order).toEqual(['scale', 'clear-hold']);
  });

  it('a failed scale-up KEEPS the hold so the watchdog can still find the tenant', async () => {
    const m = mockK8s();
    vi.mocked(scaleDeploymentReplicas).mockRejectedValueOnce(
      new Error('scaleDeploymentReplicas: ns/wp scale->1 HTTP 403: exceeded quota'),
    );
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    })).rejects.toThrow(/could not be restored/);

    // The hold must NOT have been cleared for the workload that stayed down.
    expect(m.holdCalls).not.toContainEqual({ name: 'wp', held: false });
  });

  it('throws so the caller marks the op FAILED instead of reporting success over a down tenant', async () => {
    const m = mockK8s();
    vi.mocked(scaleDeploymentReplicas).mockRejectedValueOnce(new Error('HTTP 500: boom'));
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    })).rejects.toThrow(/still scaled down/);
  });

  it('a genuine 404 on scale-up is NOT a failure — the op removed the Deployment', async () => {
    const m = mockK8s();
    vi.mocked(scaleDeploymentReplicas).mockRejectedValueOnce(
      new Error('scaleDeploymentReplicas: ns/gone scale->1 HTTP 404: not found'),
    );
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'gone', replicas: 1 }], cronJobs: [],
    })).resolves.not.toThrow();
    // ...and its now-moot hold is still cleaned up.
    expect(m.holdCalls).toContainEqual({ name: 'gone', held: false });
  });

  it('one unrestorable workload does not stop the rest of the namespace coming back', async () => {
    const m = mockK8s();
    vi.mocked(scaleDeploymentReplicas).mockRejectedValueOnce(new Error('HTTP 403: exceeded quota'));
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'broken', replicas: 1 }, { name: 'fine', replicas: 2 }],
      cronJobs: [{ name: 'wp-cron', wasSuspended: false }],
    })).rejects.toThrow(/1 workload/);

    // The healthy one still came back, and CronJobs were still unsuspended.
    expect(scaleReplicaCalls).toContainEqual({ namespace: 'ns', name: 'fine', replicas: 2 });
    expect(m.cronPatchCalls).toEqual([{ name: 'wp-cron', suspend: false }]);
  });
});

describe('clearQuiesceHold', () => {
  it('sweeps EVERY held Deployment, not just file-manager', async () => {
    const m = mockK8s();
    (m.tenant.apps as unknown as { listNamespacedDeployment: ReturnType<typeof vi.fn> })
      .listNamespacedDeployment.mockResolvedValue({
        items: [
          { metadata: { name: 'file-manager', annotations: { 'insula.host/storage-quiesced': 'true' } } },
          { metadata: { name: 'website', annotations: { 'insula.host/storage-quiesced': 'true' } } },
          { metadata: { name: 'untouched', annotations: {} } },
        ],
      });

    await clearQuiesceHold(m.tenant, 'ns');

    expect(m.holdCalls).toContainEqual({ name: 'file-manager', held: false });
    expect(m.holdCalls).toContainEqual({ name: 'website', held: false });
    expect(m.holdCalls.map((h) => h.name)).not.toContain('untouched');
  });

  it('falls back to file-manager when the Deployment list fails', async () => {
    const m = mockK8s();
    (m.tenant.apps as unknown as { listNamespacedDeployment: ReturnType<typeof vi.fn> })
      .listNamespacedDeployment.mockRejectedValue(new Error('API down'));

    await clearQuiesceHold(m.tenant, 'ns');

    expect(m.holdCalls).toEqual([{ name: 'file-manager', held: false }]);
  });

  it('targets a single Deployment when a name is given', async () => {
    const m = mockK8s();
    await clearQuiesceHold(m.tenant, 'ns', 'website');
    expect(m.holdCalls).toEqual([{ name: 'website', held: false }]);
  });
});

// ── outcome verification ────────────────────────────────────────────────
//
// The bug these cover: unquiesce verified its WRITE, not the OUTCOME. A PATCH to
// the /scale subresource returning 200 only changes the Deployment's spec —
// whether a POD ever runs is decided afterwards by the ReplicaSet, and that is
// where a restore actually fails (ResourceQuota is enforced at pod CREATE, and a
// still-terminating pod counts against it). unquiesce then cleared the
// quiesce-hold, which is the only marker watchdog Leg B can find, so the tenant
// was left down with the op already terminal — invisible to every recovery path.
// Reported as "after fsck the previously running workloads are not started again".
describe('unquiesce — verifies the workload is RUNNING, not merely requested', () => {
  // Short waits: the production default is 5 min, which the poll loop would
  // honour and blow the test timeout.
  const fast = { availableTimeoutMs: 100 };

  it('throws when a scaled-up workload never becomes available', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }], neverAvailable: ['wp'] });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, fast)).rejects.toThrow(/could not be restored/);
  });

  it('KEEPS the hold when the workload never becomes available', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }], neverAvailable: ['wp'] });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, fast)).rejects.toThrow();
    // The scale-up itself SUCCEEDED here — this is precisely the case the old
    // code cleared the hold for.
    expect(scaleReplicaCalls).toContainEqual({ namespace: 'ns', name: 'wp', replicas: 1 });
    expect(m.holdCalls).not.toContainEqual({ name: 'wp', held: false });
  });

  it('names a ResourceQuota rejection in the error instead of a bare timeout', async () => {
    const m = mockK8s({
      deployments: [{ name: 'wp', replicas: 1 }],
      replicaFailure: { wp: 'pods "wp-abc" is forbidden: exceeded quota: tenant-quota, requested: limits.memory=512Mi, used: limits.memory=844Mi, limited: limits.memory=1Gi' },
    });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, fast)).rejects.toThrow(/exceeded quota/);
  });

  it('a ReplicaFailure fails fast rather than waiting out the deadline', async () => {
    const m = mockK8s({
      deployments: [{ name: 'wp', replicas: 1 }],
      replicaFailure: { wp: 'FailedCreate: exceeded quota' },
    });
    const started = Date.now();
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, { availableTimeoutMs: 60_000 })).rejects.toThrow(/exceeded quota/);
    // Pods are being refused outright; waiting the full 60s only delays the report.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('clears the hold once the workload IS available', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 2 }] });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 2 }], cronJobs: [],
    }, fast)).resolves.not.toThrow();
    expect(m.holdCalls).toContainEqual({ name: 'wp', held: false });
  });

  it('a Deployment that 404s on status read counts as gone, not as down', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }], missing: ['wp'] });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, fast)).resolves.not.toThrow();
    // The op removed it; the (now moot) hold is cleared rather than stranded.
    expect(m.holdCalls).toContainEqual({ name: 'wp', held: false });
  });

  it('one unavailable workload does not stop the others being confirmed', async () => {
    const m = mockK8s({
      deployments: [{ name: 'broken', replicas: 1 }, { name: 'fine', replicas: 1 }],
      neverAvailable: ['broken'],
    });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'broken', replicas: 1 }, { name: 'fine', replicas: 1 }],
      cronJobs: [{ name: 'wp-cron', wasSuspended: false }],
    }, fast)).rejects.toThrow(/broken/);
    // The healthy one is confirmed and released; CronJobs still unsuspended.
    expect(m.holdCalls).toContainEqual({ name: 'fine', held: false });
    expect(m.holdCalls).not.toContainEqual({ name: 'broken', held: false });
    expect(m.cronPatchCalls).toContainEqual({ name: 'wp-cron', suspend: false });
  });

  it('issues every scale-up before waiting, so N workloads cost the slowest not the sum', async () => {
    const m = mockK8s({
      deployments: [{ name: 'a', replicas: 1 }, { name: 'b', replicas: 1 }, { name: 'c', replicas: 1 }],
    });
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'a', replicas: 1 }, { name: 'b', replicas: 1 }, { name: 'c', replicas: 1 }],
      cronJobs: [],
    }, fast);
    // All three scale calls land before any status read resolves the wait.
    expect(scaleReplicaCalls.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});

// ── the pre-quiesce replica marker ──────────────────────────────────────
//
// Recovering a tenant stranded at 0 used to mean guessing which storage
// operation stranded it — "the most recent one carrying a snapshot" — which can
// predate workloads added since, list workloads since deleted, or be an
// unrelated earlier op. The count now rides on the Deployment itself, stamped by
// the same patch that sets the hold, so recovery is local and unambiguous.
describe('quiesce — records what it scaled each workload down FROM', () => {
  it('stamps the pre-quiesce replica count alongside the hold', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 3 }, { name: 'db', replicas: 1 }] });
    await quiesce(m.tenant, 'ns');
    expect(m.replicaAnnotationCalls).toEqual(
      expect.arrayContaining([{ name: 'wp', value: '3' }, { name: 'db', value: '1' }]),
    );
  });

  it('sets the count in the SAME patch as the hold, so they cannot drift', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 2 }] });
    await quiesce(m.tenant, 'ns');
    // One annotation patch carried both facts: equal counts, same order.
    expect(m.holdCalls.filter((h) => h.name === 'wp' && h.held)).toHaveLength(1);
    expect(m.replicaAnnotationCalls.filter((r) => r.name === 'wp' && r.value === '2')).toHaveLength(1);
  });

  it('does NOT stamp a workload it never scaled (already at 0)', async () => {
    const m = mockK8s({ deployments: [{ name: 'idle', replicas: 0 }] });
    await quiesce(m.tenant, 'ns');
    expect(m.replicaAnnotationCalls.some((r) => r.name === 'idle')).toBe(false);
    expect(m.holdCalls.some((h) => h.name === 'idle')).toBe(false);
  });

  it('unquiesce clears the count together with the hold', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }] });
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, { availableTimeoutMs: 100 });
    expect(m.holdCalls).toContainEqual({ name: 'wp', held: false });
    // A stale count left behind would later be read as "restore me to N".
    expect(m.replicaAnnotationCalls).toContainEqual({ name: 'wp', value: null });
  });

  it('a workload that could NOT be restored keeps both hold and count', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 1 }], neverAvailable: ['wp'] });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }], cronJobs: [],
    }, { availableTimeoutMs: 100 })).rejects.toThrow();
    expect(m.holdCalls).not.toContainEqual({ name: 'wp', held: false });
    expect(m.replicaAnnotationCalls).not.toContainEqual({ name: 'wp', value: null });
  });
});

// ── a stale snapshot must not release a live hold ────────────────────────
//
// `replicas: 0` in a snapshot was treated as "nothing to restore", and phase 3
// then cleared the hold — erasing the only marker saying the workload was scaled
// down, WITHOUT bringing it back. The tenant then looks deliberately idle to
// every recovery path. Reachable whenever the snapshot is stale for that
// workload, which is exactly what quiesce-watchdog Leg B replays when it
// restores from the tenant's most-recent operation instead of the one that
// stranded it.
describe('unquiesce — a snapshot entry of 0 is not proof there is nothing to restore', () => {
  const fast = { availableTimeoutMs: 100 };

  it('restores from the pre-quiesce annotation when the snapshot disagrees', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 0 }], heldWithCount: { wp: 3 } });
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 0 }], cronJobs: [],
    }, fast);
    // Scaled to the ANNOTATION's count, not left at the snapshot's 0.
    expect(scaleReplicaCalls).toContainEqual({ namespace: 'ns', name: 'wp', replicas: 3 });
  });

  it('clears the hold only AFTER restoring from the annotation', async () => {
    const m = mockK8s({ deployments: [{ name: 'wp', replicas: 0 }], heldWithCount: { wp: 2 } });
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 0 }], cronJobs: [],
    }, fast);
    expect(scaleReplicaCalls).toContainEqual({ namespace: 'ns', name: 'wp', replicas: 2 });
    expect(m.holdCalls).toContainEqual({ name: 'wp', held: false });
  });

  it('a genuinely idle workload (0 in snapshot, NOT held) is still left alone', async () => {
    const m = mockK8s({ deployments: [{ name: 'idle', replicas: 0 }] });
    await unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'idle', replicas: 0 }], cronJobs: [],
    }, fast);
    // No scale-up: an operator's deliberate 0 must not be overridden.
    expect(scaleReplicaCalls.some((c) => c.name === 'idle')).toBe(false);
  });

  it('keeps the hold when the annotation-driven restore itself fails', async () => {
    const m = mockK8s({
      deployments: [{ name: 'wp', replicas: 0 }],
      heldWithCount: { wp: 1 },
      neverAvailable: ['wp'],
    });
    await expect(unquiesce(m.tenant, 'ns', {
      deployments: [{ name: 'wp', replicas: 0 }], cronJobs: [],
    }, fast)).rejects.toThrow();
    expect(m.holdCalls).not.toContainEqual({ name: 'wp', held: false });
  });
});
