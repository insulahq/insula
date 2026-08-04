import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock DB ──────────────────────────────────────────────────────────────────

const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) });
// Claimed rows the mocked `DELETE … RETURNING` hands back; each test sets this.
let claimedRows: Record<string, unknown>[] = [];
const mockReturning = vi.fn(async () => claimedRows);
const mockDelete = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: mockReturning }) });
const mockDb = {
  insert: mockInsert,
  delete: mockDelete,
} as unknown as import('../../db/index.js').Database;

// ── Mock storage/service internals ───────────────────────────────────────────

const mockGetInUseImages = vi.fn<[], Promise<Set<string>>>();
const mockRunPurgeOnNode = vi.fn();

vi.mock('./service.js', async () => {
  // Use the REAL canonicalImageRef from the shared utility so this mock
  // stays in lockstep with production behaviour automatically (no copy-
  // paste sync discipline needed).
  const { canonicalImageRef } = await import('./image-ref-utils.js');
  return {
    getInUseImages: mockGetInUseImages,
    runPurgeOnNode: mockRunPurgeOnNode,
    isAnyNameInUse: (names: readonly string[], set: ReadonlySet<string>): boolean => {
      const canonSet = new Set<string>();
      for (const u of set) canonSet.add(canonicalImageRef(u));
      for (const n of names) {
        if (canonSet.has(canonicalImageRef(n))) return true;
      }
      return false;
    },
  };
});

vi.mock('../../db/schema.js', () => ({
  imageReapLog: {},
  pendingImageReaps: {},
}));

const { reapImageNow, scheduleReap, runDueReaps } = await import('./image-reaper.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeK8s(nodes: { name: string; images: { names: string[]; sizeBytes: number }[] }[]) {
  return {
    core: {
      listNode: vi.fn().mockResolvedValue({
        items: nodes.map(n => ({
          metadata: { name: n.name },
          status: { images: n.images.map(img => ({ names: img.names, sizeBytes: img.sizeBytes })) },
        })),
      }),
    },
  } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('image-reaper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset insert mock chain
    const valuesMock = vi.fn().mockResolvedValue([]);
    mockInsert.mockReturnValue({ values: valuesMock });
  });

  describe('reapImageNow', () => {
    it('skips and logs when image is still in use', async () => {
      mockGetInUseImages.mockResolvedValue(new Set(['ghcr.io/foo/bar:v1.0']));
      const k8s = makeK8s([]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('in_use');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
      expect(mockInsert).toHaveBeenCalledOnce();
    });

    it('returns not_present when image is absent from all nodes', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([{ name: 'node-1', images: [{ names: ['other:latest'], sizeBytes: 0 }] }]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('not_present');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
    });

    it('calls runPurgeOnNode for each node that has the image', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([
        { name: 'node-1', images: [{ names: ['ghcr.io/foo/bar:v1.0'], sizeBytes: 100_000_000 }] },
        { name: 'node-2', images: [{ names: ['ghcr.io/foo/bar:v1.0'], sizeBytes: 100_000_000 }] },
      ]);
      mockRunPurgeOnNode.mockResolvedValue({
        node: 'node-1',
        removedDisplayNames: ['ghcr.io/foo/bar:v1.0'],
        failedDisplayNames: [],
        freedBytes: 100_000_000,
      });

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1.0',
        triggeredBy: 'deployment_delete',
        triggerRef: 'deploy-abc',
      });

      expect(mockRunPurgeOnNode).toHaveBeenCalledTimes(2);
      expect(result.skipped).toBe(false);
      // Both nodes returned success in mock
      expect(result.nodes).toHaveLength(2);
      expect(result.reclaimedBytes).toBe(200_000_000);
    });

    it('logs success row into image_reap_log', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = makeK8s([
        { name: 'node-1', images: [{ names: ['myapp:v2.0'], sizeBytes: 50_000_000 }] },
      ]);
      mockRunPurgeOnNode.mockResolvedValue({
        node: 'node-1',
        removedDisplayNames: ['myapp:v2.0'],
        failedDisplayNames: [],
        freedBytes: 50_000_000,
      });

      await reapImageNow(mockDb, k8s, {
        image: 'myapp:v2.0',
        triggeredBy: 'deployment_delete',
        triggerRef: 'deploy-xyz',
      });

      expect(mockInsert).toHaveBeenCalledOnce();
      const valuesArg = mockInsert.mock.results[0].value.values.mock.calls[0][0];
      expect(valuesArg.imageName).toBe('myapp:v2.0');
      expect(valuesArg.triggeredBy).toBe('deployment_delete');
      expect(valuesArg.triggerRef).toBe('deploy-xyz');
      expect(valuesArg.succeeded).toBe(true);
      expect(valuesArg.bytesReclaimed).toBe(50_000_000);
    });

    it('handles k8s listNode failure gracefully', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      const k8s = {
        core: { listNode: vi.fn().mockRejectedValue(new Error('k8s down')) },
      } as unknown as import('../k8s-provisioner/k8s-client.js').K8sClients;

      const result = await reapImageNow(mockDb, k8s, {
        image: 'myapp:v2.0',
        triggeredBy: 'manual_purge',
      });

      expect(result.skipped).toBe(false);
      expect(result.reason).toBe('k8s_error');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
    });
  });

  describe('scheduleReap', () => {
    it('schedules reap with timeout and does not throw', () => {
      vi.useFakeTimers();
      mockGetInUseImages.mockResolvedValue(new Set(['myapp:v1.0']));
      const k8s = makeK8s([]);

      // Should not throw
      expect(() => {
        scheduleReap(mockDb, k8s, {
          image: 'myapp:v1.0',
          triggeredBy: 'deployment_delete',
          graceMs: 1000,
        });
      }).not.toThrow();

      vi.useRealTimers();
    });
  });

  describe('canonicalImageRef equivalence (2026-05-17 reaper regression)', () => {
    // The reaper used to compare the catalog's image ref directly against
    // node.status.images[].names — a string equality check that missed
    // `serversideup/php:tag` vs `docker.io/serversideup/php:tag`. The
    // canonicalImageRef helper normalises both sides to the long Docker
    // form. These tests pin the matching behaviour for every shape we
    // expect to see in production.
    it('matches a Docker Hub user/image catalog ref against the canonical docker.io/user/image node ref', async () => {
      mockGetInUseImages.mockResolvedValue(new Set()); // not in use
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: ['serversideup/php:tag'], failedDisplayNames: [], freedBytes: 100_000 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['docker.io/serversideup/php:tag'], sizeBytes: 100_000 }] },
      ]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'serversideup/php:tag',
        triggeredBy: 'deployment_delete',
      });

      // Old code: skipped=true reason=not_present (catalog ref didn't
      // match docker.io/-prefixed node ref). New code: a node is found,
      // runPurgeOnNode is invoked, the reap is recorded.
      expect(result.skipped).toBe(false);
      expect(result.nodes).toEqual(['n1']);
      expect(mockRunPurgeOnNode).toHaveBeenCalledOnce();
    });

    it('matches the bare-name (no /) catalog ref against docker.io/library/<name>', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: ['nginx:latest'], failedDisplayNames: [], freedBytes: 50_000 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['docker.io/library/nginx:latest'], sizeBytes: 50_000 }] },
      ]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'nginx:latest',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(false);
      expect(result.nodes).toEqual(['n1']);
    });

    it('does NOT normalise refs that already specify a non-Docker-Hub registry', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: [], failedDisplayNames: [], freedBytes: 0 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['ghcr.io/foo/bar:v1'], sizeBytes: 0 }] },
      ]);

      // Catalog ref is `ghcr.io/foo/bar:v2` — different tag, MUST NOT match
      // the v1 on the node.
      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v2',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('not_present');
    });

    it('matches identical fully-qualified refs without alteration', async () => {
      mockGetInUseImages.mockResolvedValue(new Set());
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: ['ghcr.io/foo/bar:v1'], failedDisplayNames: [], freedBytes: 10_000 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['ghcr.io/foo/bar:v1'], sizeBytes: 10_000 }] },
      ]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'ghcr.io/foo/bar:v1',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(false);
      expect(result.nodes).toEqual(['n1']);
    });

    it('in-use guard catches the canonical form when the pod spec uses the short ref', async () => {
      // Pod spec shows `serversideup/php:tag` (short); node reports
      // `docker.io/serversideup/php:tag` (canonical). The in-use guard
      // must recognise these as the same image and SKIP the reap.
      mockGetInUseImages.mockResolvedValue(new Set(['serversideup/php:tag']));
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['docker.io/serversideup/php:tag'], sizeBytes: 1000 }] },
      ]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'docker.io/serversideup/php:tag', // caller uses the canonical form
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('in_use');
      expect(mockRunPurgeOnNode).not.toHaveBeenCalled();
    });

    it('passes the canonical (FQDN) ref to crictl, even when the catalog ref is short', async () => {
      // cri-o requires the FQDN form to remove an image. The reaper used
      // to pass the short catalog ref directly to crictl, which only
      // worked on containerd. Pin the canonical-form contract.
      mockGetInUseImages.mockResolvedValue(new Set());
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: ['serversideup/php:tag'], failedDisplayNames: [], freedBytes: 100_000 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['docker.io/serversideup/php:tag'], sizeBytes: 100_000 }] },
      ]);

      await reapImageNow(mockDb, k8s, {
        image: 'serversideup/php:tag',
        triggeredBy: 'deployment_delete',
      });

      expect(mockRunPurgeOnNode).toHaveBeenCalledOnce();
      const [, , imgs] = mockRunPurgeOnNode.mock.calls[0];
      const img = imgs[0] as { crictlName: string; displayName: string };
      expect(img.crictlName).toBe('docker.io/serversideup/php:tag'); // canonical
      expect(img.displayName).toBe('serversideup/php:tag'); // operator-facing
    });

    it('leaves bare digest refs (sha256:abc...) unchanged in canonical form', async () => {
      // Pure digest refs like `sha256:abc...` are reported by kubelet as-
      // is on node.status.images[].names. Expanding to
      // `docker.io/library/sha256:abc...` would silently miss the match
      // and the reaper would log a false no-op success. Regression
      // guard against re-introducing the expansion.
      mockGetInUseImages.mockResolvedValue(new Set());
      mockRunPurgeOnNode.mockResolvedValue({ removedDisplayNames: ['sha256:abc'], failedDisplayNames: [], freedBytes: 1 });
      const k8s = makeK8s([
        { name: 'n1', images: [{ names: ['sha256:abc'], sizeBytes: 1 }] },
      ]);

      const result = await reapImageNow(mockDb, k8s, {
        image: 'sha256:abc',
        triggeredBy: 'deployment_delete',
      });

      expect(result.skipped).toBe(false);
      expect(result.nodes).toEqual(['n1']);
      // crictlName MUST be the bare digest — no docker.io/library/ prefix
      const [, , imgs] = mockRunPurgeOnNode.mock.calls[0];
      const img = imgs[0] as { crictlName: string };
      expect(img.crictlName).toBe('sha256:abc');
    });
  });
});

// ── Durability: the reap must survive a platform-api restart ─────────────────
//
// The grace period used to be an in-process setTimeout ONLY. A restart inside
// the window dropped the reap silently — no image_reap_log row, no retry, no
// trace. Reproduced on the DEV cluster 2026-08-04: a deployment deleted at
// 13:43:44 armed a timer for 13:48:44, Flux rolled platform-api (new pod up
// 13:49:28), and the image stayed on the node with NOTHING recorded anywhere.
describe('image-reaper durability', () => {
  // Fresh values() spy per test — mockInsert returns ONE object, so a stale spy
  // would accumulate calls across tests and `calls[0]` would be another test's.
  let valuesSpy: ReturnType<typeof vi.fn>;
  const insertedRows = (): Record<string, unknown>[] => valuesSpy.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    vi.clearAllMocks();
    claimedRows = [];
    valuesSpy = vi.fn().mockResolvedValue([]);
    mockInsert.mockReturnValue({ values: valuesSpy });
    mockDelete.mockReturnValue({ where: vi.fn().mockReturnValue({ returning: mockReturning }) });
    mockGetInUseImages.mockResolvedValue(new Set<string>());
    mockRunPurgeOnNode.mockResolvedValue({
      removedDisplayNames: ['ghcr.io/x/y:1'], failedDisplayNames: [], freedBytes: 100, podError: undefined,
    });
  });

  it('persists the pending reap BEFORE the timer — the row is the source of truth', () => {
    vi.useFakeTimers();
    scheduleReap(mockDb, makeK8s([]), {
      image: 'ghcr.io/x/y:1', triggeredBy: 'deployment_delete', triggerRef: 'depl-1', graceMs: 1000,
    });
    // Enqueued synchronously, without waiting for the grace period: a crash one
    // millisecond later must still leave the work recorded.
    expect(mockInsert).toHaveBeenCalled();
    const row = insertedRows()[0] as Record<string, unknown> & { dueAt: Date };
    expect(row.imageName).toBe('ghcr.io/x/y:1');
    expect(row.triggerRef).toBe('depl-1');
    expect(row.dueAt).toBeInstanceOf(Date);
    vi.useRealTimers();
  });

  it('a restart loses the timer but NOT the reap — the sweeper picks it up', async () => {
    // Simulate the post-restart process: no timer was ever armed here; the only
    // evidence the work exists is the persisted row.
    claimedRows = [{ imageName: 'ghcr.io/x/y:1', triggeredBy: 'deployment_delete', triggerRef: 'depl-1', attempts: 0 }];
    const executed = await runDueReaps(mockDb, makeK8s([
      { name: 'node-a', images: [{ names: ['ghcr.io/x/y:1'], sizeBytes: 100 }] },
    ]));
    expect(executed).toBe(1);
    expect(mockRunPurgeOnNode).toHaveBeenCalled();
  });

  it('claims with DELETE … RETURNING so two replicas cannot both reap a row', async () => {
    claimedRows = [{ imageName: 'ghcr.io/x/y:1', triggeredBy: 'deployment_delete', triggerRef: null, attempts: 0 }];
    await runDueReaps(mockDb, makeK8s([]));
    // The claim is a DELETE (atomic hand-off), never a SELECT-then-update:
    // with a read-first claim both replicas would see the same row.
    expect(mockDelete).toHaveBeenCalled();
  });

  it('re-enqueues with backoff when a reap throws, instead of losing it', async () => {
    claimedRows = [{ imageName: 'ghcr.io/x/y:1', triggeredBy: 'deployment_delete', triggerRef: 'd1', attempts: 1 }];
    mockGetInUseImages.mockRejectedValueOnce(new Error('kube-apiserver unreachable'));
    await runDueReaps(mockDb, makeK8s([]));
    const reinsert = insertedRows().at(-1) as Record<string, unknown> & { dueAt: Date };
    expect(reinsert.attempts).toBe(2);
    expect(reinsert.lastError).toContain('kube-apiserver unreachable');
    // Scheduled into the future, not retried in a tight loop.
    expect(reinsert.dueAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after the attempt cap and records WHY, rather than retrying forever', async () => {
    claimedRows = [{ imageName: 'ghcr.io/x/y:1', triggeredBy: 'deployment_delete', triggerRef: 'd1', attempts: 4 }];
    mockGetInUseImages.mockRejectedValueOnce(new Error('permanent failure'));
    await runDueReaps(mockDb, makeK8s([]));
    const logged = insertedRows().at(-1) as Record<string, unknown>;
    expect(logged.succeeded).toBe(false);
    expect(logged.error).toContain('gave up after 5 attempts');
    expect(logged.error).toContain('permanent failure');
  });
});
