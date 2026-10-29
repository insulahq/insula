/**
 * A multi-service stack's status is read from every service's Deployment.
 * Reconcile read only the Deployment named after the stack — which only a
 * single-service stack has — so a running multi-service stack sat at
 * `deploying` and was failed at 60 minutes as "not created" (seen on DEV),
 * which the failure notifications would now announce to tenant and operator.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./image-audit.js', () => ({ recordImageAudit: vi.fn(async () => 0) }));

const { reconcileCustomRow, stackWorkloadNames, mergePodObservations } = await import('./reconcile.js');

const spec = (...services: string[]) => ({ services: Object.fromEntries(services.map((s) => [s, {}])) });
const row = (customSpec: unknown, status = 'deploying') =>
  ({ id: 'd1', name: 'cd-two', status, statusMessage: null, customSpec, updatedAt: new Date() }) as never;

type Dep = { ready: number; desired: number } | null;
function fakeK8s(deps: Record<string, Dep>, pods: Record<string, unknown[]> = {}) {
  return {
    apps: {
      readNamespacedDeployment: vi.fn(async ({ name }: { name: string }) => {
        const d = deps[name];
        if (!d) throw Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
        return { spec: { replicas: d.desired }, status: { readyReplicas: d.ready }, metadata: {} };
      }),
      listNamespacedReplicaSet: vi.fn(async () => ({ items: [] })),
    },
    core: {
      listNamespacedPod: vi.fn(async ({ labelSelector }: { labelSelector: string }) => ({ items: pods[labelSelector.replace('app=', '')] ?? [] })),
      listNamespacedEvent: vi.fn(async () => ({ items: [] })),
    },
  } as never;
}

describe('stackWorkloadNames', () => {
  it('is the stack name for one service, <stack>-<service> for several', () => {
    expect(stackWorkloadNames({ name: 'cd-two', customSpec: spec('web') })).toEqual(['cd-two']);
    expect(stackWorkloadNames({ name: 'cd-two', customSpec: spec('web', 'side') })).toEqual(['cd-two-web', 'cd-two-side']);
    expect(stackWorkloadNames({ name: 'cd-two', customSpec: null })).toEqual(['cd-two']);
  });
});

describe('reconcileCustomRow — multi-service stacks', () => {
  it('★ every service ready → running (it used to stay deploying)', async () => {
    const k8s = fakeK8s({ 'cd-two-web': { ready: 1, desired: 1 }, 'cd-two-side': { ready: 1, desired: 1 } });
    expect((await reconcileCustomRow({} as never, k8s, row(spec('web', 'side')), 'ns')).status).toBe('running');
  });

  it('one service not ready yet → pending, not running', async () => {
    const k8s = fakeK8s({ 'cd-two-web': { ready: 1, desired: 1 }, 'cd-two-side': { ready: 0, desired: 1 } });
    expect((await reconcileCustomRow({} as never, k8s, row(spec('web', 'side')), 'ns')).status).toBe('pending');
  });

  it('a crash in any service → failed, naming it', async () => {
    const crash = [{ status: { containerStatuses: [{ name: 'side', ready: false, restartCount: 6, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } } }] } }];
    const k8s = fakeK8s({ 'cd-two-web': { ready: 1, desired: 1 }, 'cd-two-side': { ready: 0, desired: 1 } }, { 'cd-two-side': crash });
    const out = await reconcileCustomRow({} as never, k8s, row(spec('web', 'side')), 'ns');
    expect(out.status).toBe('failed');
    expect(out.statusMessage).toMatch(/^side: CrashLoopBackOff/);
  });

  it('every service scaled to 0 → stopped', async () => {
    const k8s = fakeK8s({ 'cd-two-web': { ready: 0, desired: 0 }, 'cd-two-side': { ready: 0, desired: 0 } });
    expect((await reconcileCustomRow({} as never, k8s, row(spec('web', 'side'), 'stopped'), 'ns')).status).toBe('stopped');
  });

  it('a service Deployment not there yet → keeps deploying', async () => {
    const k8s = fakeK8s({ 'cd-two-web': { ready: 1, desired: 1 }, 'cd-two-side': null });
    expect((await reconcileCustomRow({} as never, k8s, row(spec('web', 'side')), 'ns')).status).toBe('deploying');
  });

  it('a single-service stack reads as before', async () => {
    const k8s = fakeK8s({ 'cd-two': { ready: 1, desired: 1 } });
    expect((await reconcileCustomRow({} as never, k8s, row(spec('web')), 'ns')).status).toBe('running');
  });
});

describe('mergePodObservations', () => {
  it('first failure, oldest pod; unknown anywhere is unknown', () => {
    const a = { node: 'n1', failureReason: null, pendingReason: null, oldestCreatedAtMs: 200 };
    const b = { node: null, failureReason: 'side: OOMKilled', pendingReason: null, oldestCreatedAtMs: 100 };
    expect(mergePodObservations([a, b])).toEqual({ node: 'n1', failureReason: 'side: OOMKilled', pendingReason: null, oldestCreatedAtMs: 100 });
    expect(mergePodObservations([a, { ...b, oldestCreatedAtMs: null }]).oldestCreatedAtMs).toBeNull();
  });
});
