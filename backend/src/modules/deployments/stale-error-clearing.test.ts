import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A failure must not outlive the attempt that produced it.
 *
 * Reported by an operator: changing an application's resources or env vars
 * brought back an error message from an earlier attempt. Two mechanisms, both
 * real:
 *
 *  1. `redeployWithCurrentConfig` never cleared `lastError`. Only two callers
 *     cleared it, and they did so as part of a status transition — so an env-var
 *     edit, a mount edit, a credential rotation and the DR reconcile all left
 *     the previous failure on the row while replacing the workload underneath
 *     it.
 *
 *  2. The status reconciler's "clear errors when status recovers" branch sat
 *     behind a guard that only fires on a transition. A row that was ALREADY
 *     `running` when something wrote an error to it never transitions again,
 *     so nothing would ever clear it.
 *
 * Reported again afterwards, and correctly: clearing the MESSAGE left the
 * VERDICT. The row stayed on `failed`, so the panel stopped saying why it had
 * failed and carried on showing a red FAILED chip over an application that was
 * being restarted as it was read. The reconciler corrects it, but only on its
 * next pass — up to 15 seconds later.
 */

const dispatchCustomRedeploy = vi.fn().mockResolvedValue(undefined);

vi.mock('./custom-dispatch.js', () => ({
  // Forces the early return, which is the point: the clear must happen BEFORE
  // any branch can leave the function.
  isCustomDeployment: () => true,
  dispatchCustomRedeploy,
  dispatchCustomStop: vi.fn(),
  dispatchCustomStart: vi.fn(),
  dispatchCustomResources: vi.fn(),
  dispatchCustomScale: vi.fn(),
}));
vi.mock('./k8s-deployer.js', () => ({
  deployCatalogEntry: vi.fn(),
  restartDeployment: vi.fn(),
  deleteDeployment: vi.fn(),
  scaleDeployment: vi.fn(),
  k8sResourceName: (a: string) => a,
}));

const { redeployWithCurrentConfig, clearDeploymentError } = await import('./service.js');
const { needsStatusWrite } = await import('./status-reconciler.js');

/** Records every `update().set()` so the write itself can be asserted. */
function recordingDb() {
  const sets: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  return { db: db as never, sets };
}

const DEPLOYMENT = {
  id: 'd1', tenantId: 't1', name: 'blog', source: 'custom',
  catalogEntryId: null, status: 'running',
  lastError: 'Quota exceeded — memory limit: requesting 512Mi',
  statusMessage: null,
} as never;

beforeEach(() => vi.clearAllMocks());

describe('clearDeploymentError', () => {
  it('clears the transitional message as well as the error', async () => {
    const { db, sets } = recordingDb();
    await clearDeploymentError(db, 'd1');
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ lastError: null, statusMessage: null });
  });

  // The guard that keeps this to `failed` rows is a SQL CASE, executed by
  // Postgres — asserting its text here would test the string, not the
  // behaviour. It is verified against a real database instead; see the PR.
  it('drops the FAILED verdict, not just the message', async () => {
    // The whole point of the follow-up. A cleared error on a row still marked
    // `failed` reads as "it failed and we cannot tell you why", which is worse
    // than the stale message it replaced.
    const { db, sets } = recordingDb();
    await clearDeploymentError(db, 'd1');
    expect(sets[0]).toHaveProperty('status');
  });

});

describe('redeployWithCurrentConfig', () => {
  it('forgets the previous failure before replacing the workload', async () => {
    const { db, sets } = recordingDb();
    await redeployWithCurrentConfig(db, DEPLOYMENT, {} as never);
    expect(sets.some((v) => v.lastError === null && v.statusMessage === null)).toBe(true);
  });

  // The clear sits above every branch on purpose. A custom deployment returns
  // early, and that path is exactly the one a mount edit or credential
  // rotation takes.
  it('clears even on the path that returns early', async () => {
    const { db, sets } = recordingDb();
    await redeployWithCurrentConfig(db, DEPLOYMENT, {} as never);
    expect(dispatchCustomRedeploy).toHaveBeenCalledOnce();
    expect(sets[0]).toMatchObject({ lastError: null, statusMessage: null });
  });
});

describe('needsStatusWrite', () => {
  const healthy = { status: 'running', statusMessage: null, lastError: null, currentNodeName: 'node-1' };
  const observed = { status: 'running', statusMessage: null, nodeName: 'node-1' };

  it('writes nothing when nothing moved', () => {
    expect(needsStatusWrite(healthy, observed)).toBe(false);
  });

  it('writes on a status change', () => {
    expect(needsStatusWrite({ ...healthy, status: 'pending' }, observed)).toBe(true);
  });

  it('writes on a transitional-message change', () => {
    expect(needsStatusWrite(healthy, { ...observed, statusMessage: 'Pulling image' })).toBe(true);
  });

  it('writes when the pod moved node', () => {
    expect(needsStatusWrite(healthy, { ...observed, nodeName: 'node-2' })).toBe(true);
  });

  // ★ The hole: already running, so no transition will ever come, and the
  // clear branch behind the old guard was unreachable.
  it('writes when a running deployment is still carrying an old error', () => {
    expect(needsStatusWrite({ ...healthy, lastError: 'Quota exceeded' }, observed)).toBe(true);
  });

  it('writes when a running deployment is still carrying an old status message', () => {
    expect(needsStatusWrite({ ...healthy, statusMessage: 'Pulling image' }, observed)).toBe(true);
  });

  // A genuinely failed deployment keeps its error: the clear belongs to
  // recovery, not to every tick.
  it('does not churn a failed deployment that is still failed', () => {
    expect(needsStatusWrite(
      { status: 'failed', statusMessage: null, lastError: 'Quota exceeded', currentNodeName: null },
      { status: 'failed', statusMessage: null, nodeName: null },
    )).toBe(false);
  });
});
