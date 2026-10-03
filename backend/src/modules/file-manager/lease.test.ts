import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFileManagerLease, type LeaseDeps } from './lease.js';
import { FM_LEASE_PREFIX, LAST_ACCESS_ANNOTATION, hasLiveLease } from './lease-annotations.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';

const NS = 'tenant-a';

/** A file-manager Deployment the fake apiserver serves and patches in place. */
function fakeCluster(initial: { replicas: number; annotations?: Record<string, string> } | null) {
  let deploy = initial
    ? { metadata: { annotations: { ...(initial.annotations ?? {}) } }, spec: { replicas: initial.replicas } }
    : null;
  const patches: Array<Record<string, string | null>> = [];
  const notFound = Object.assign(new Error('not found'), { code: 404 });
  const k8s = {
    apps: {
      readNamespacedDeployment: vi.fn(async () => {
        if (!deploy) throw notFound;
        return structuredClone(deploy);
      }),
      patchNamespacedDeployment: vi.fn(async (req: { body: { metadata: { annotations: Record<string, string | null> } } }) => {
        if (!deploy) throw notFound;
        const a = req.body.metadata.annotations;
        patches.push(a);
        for (const [k, v] of Object.entries(a)) {
          if (v === null) delete deploy.metadata.annotations[k];
          else deploy.metadata.annotations[k] = v;
        }
        return {};
      }),
    },
  };
  return {
    k8s: k8s as never,
    patches,
    get deploy() { return deploy; },
    create(replicas: number) { deploy = { metadata: { annotations: {} }, spec: { replicas } }; },
    setReplicas(n: number) { deploy!.spec.replicas = n; },
    annotate(k: string, v: string) { deploy!.metadata.annotations[k] = v; },
  };
}

function deps(cluster: ReturnType<typeof fakeCluster>, over: Partial<LeaseDeps> = {}): LeaseDeps & {
  scaleToZero: ReturnType<typeof vi.fn>;
} {
  let t = 1_000_000;
  return {
    startPod: vi.fn(async () => {
      if (!cluster.deploy) cluster.create(1);
      else cluster.setReplicas(1);
      return 'file-manager-abc';
    }),
    scaleToZero: vi.fn(async () => { cluster.setReplicas(0); }),
    now: () => (t += 1000),
    renewEveryMs: 60_000,
    ...over,
  } as never;
}

const holds = (a: Record<string, string> | undefined) =>
  Object.keys(a ?? {}).filter((k) => k.startsWith(FM_LEASE_PREFIX));

describe('hasLiveLease', () => {
  it('counts only unexpired lease annotations', () => {
    expect(hasLiveLease({ [`${FM_LEASE_PREFIX}bundle-1`]: '2000' }, 1000)).toBe(true);
    expect(hasLiveLease({ [`${FM_LEASE_PREFIX}bundle-1`]: '500' }, 1000)).toBe(false);
    expect(hasLiveLease({ [LAST_ACCESS_ANNOTATION]: '9999999' }, 1000)).toBe(false);
    expect(hasLiveLease(undefined, 1000)).toBe(false);
  });
});

describe('acquireFileManagerLease', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('holds an idle file manager BEFORE starting it, and hands it back at 0', async () => {
    const c = fakeCluster({ replicas: 0, annotations: { [LAST_ACCESS_ANNOTATION]: '1' } });
    const d = deps(c);
    (d.startPod as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // The idle loop would run here. It must already see the hold.
      expect(hasLiveLease(c.deploy!.metadata.annotations, 1_000_500)).toBe(true);
      c.setReplicas(1);
      return 'file-manager-abc';
    });
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    expect(lease.podName).toBe('file-manager-abc');
    await lease.release();
    expect(d.scaleToZero).toHaveBeenCalledWith(NS);
    expect(c.deploy!.spec.replicas).toBe(0);
    expect(holds(c.deploy!.metadata.annotations)).toEqual([]);
  });

  it('leaves a file manager that was already running as it found it', async () => {
    const c = fakeCluster({ replicas: 1 });
    const d = deps(c);
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    await lease.release();
    expect(d.scaleToZero).not.toHaveBeenCalled();
    expect(holds(c.deploy!.metadata.annotations)).toEqual([]);
  });

  it('does not scale down a file manager someone used while it was held', async () => {
    const c = fakeCluster({ replicas: 0 });
    const d = deps(c);
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    c.annotate(LAST_ACCESS_ANNOTATION, String(Date.now() + 10_000_000)); // a tenant opened Files
    await lease.release();
    expect(d.scaleToZero).not.toHaveBeenCalled();
  });

  it('does not scale down while another lease still holds it', async () => {
    const c = fakeCluster({ replicas: 0 });
    const d = deps(c);
    const first = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    const second = await acquireFileManagerLease(c.k8s, NS, 'db-restore', d);
    await first.release();
    expect(d.scaleToZero).not.toHaveBeenCalled();
    expect(holds(c.deploy!.metadata.annotations)).toHaveLength(1);
    await second.release();
    // The second lease found it running (the first started it), so it leaves
    // it too; with no holds left, the idle loop scales it down on its next tick.
    expect(d.scaleToZero).not.toHaveBeenCalled();
    expect(holds(c.deploy!.metadata.annotations)).toEqual([]);
  });

  it('leaves the replica count to a storage operation that holds it', async () => {
    const c = fakeCluster({ replicas: 0 });
    const d = deps(c);
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    c.annotate(STORAGE_QUIESCED_ANNOTATION, 'true');
    await lease.release();
    expect(d.scaleToZero).not.toHaveBeenCalled();
  });

  it('holds a file manager it had to create, and hands it back at 0', async () => {
    const c = fakeCluster(null);
    const d = deps(c);
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    // The hold could not be written before the Deployment existed — it is
    // written once the start created it.
    expect(holds(c.deploy!.metadata.annotations)).toHaveLength(1);
    await lease.release();
    expect(d.scaleToZero).toHaveBeenCalledWith(NS);
  });

  it('scales back down and drops the hold when the file manager never becomes ready', async () => {
    // The production failure: pinned to a node its volume could not attach
    // to, the pod sat Pending. Scaling back to 0 removes it at once instead of
    // leaving it for the idle loop.
    const c = fakeCluster({ replicas: 0 });
    const d = deps(c, {
      startPod: vi.fn(async () => {
        c.setReplicas(1);
        throw new Error('File manager not ready: Timeout waiting for file manager to start');
      }),
    });
    await expect(acquireFileManagerLease(c.k8s, NS, 'bundle', d)).rejects.toThrow(/not ready/);
    expect(d.scaleToZero).toHaveBeenCalledWith(NS);
    expect(holds(c.deploy!.metadata.annotations)).toEqual([]);
  });

  it('renews the hold while it is held, and stops once released', async () => {
    vi.useFakeTimers();
    try {
      const c = fakeCluster({ replicas: 0 });
      const d = deps(c, { renewEveryMs: 1000 });
      const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
      const writes = () => c.patches.filter((p) => Object.values(p).some((v) => v !== null)).length;
      const before = writes();
      await vi.advanceTimersByTimeAsync(3000);
      expect(writes()).toBeGreaterThanOrEqual(before + 3);
      await lease.release();
      const after = writes();
      await vi.advanceTimersByTimeAsync(3000);
      expect(writes()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds a valid annotation key from any purpose', async () => {
    // Kubernetes rejects a key name that does not start and end alphanumeric —
    // and the first hold write is not guarded, so a bad key would fail the lease.
    const c = fakeCluster({ replicas: 1 });
    for (const purpose of ['SQL Import', '-x-', '', 'é']) {
      const lease = await acquireFileManagerLease(c.k8s, NS, purpose, deps(c));
      for (const k of holds(c.deploy!.metadata.annotations)) {
        expect(k.slice(FM_LEASE_PREFIX.length)).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
        expect(k.length - FM_LEASE_PREFIX.length).toBeLessThanOrEqual(63);
      }
      await lease.release();
    }
  });

  it('release is idempotent', async () => {
    const c = fakeCluster({ replicas: 0 });
    const d = deps(c);
    const lease = await acquireFileManagerLease(c.k8s, NS, 'bundle', d);
    await lease.release();
    await lease.release();
    expect(d.scaleToZero).toHaveBeenCalledTimes(1);
  });
});

describe('every platform exec into a file manager goes through a lease', () => {
  // A caller that starts the file manager without a lease is exactly the bug
  // this module fixes: the idle loop scales it down under the caller, and
  // nothing scales it back down after.
  it('only the lease module starts a file manager pod to exec into', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
          const rel = relative(root, p).replace(/\\/g, '/');
          if (rel === 'modules/file-manager/service.ts' || rel === 'modules/file-manager/lease.ts') continue;
          if (/\bgetReadyFileManagerPod\b/.test(readFileSync(p, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
