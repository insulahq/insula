import { describe, it, expect } from 'vitest';
import type { HostMigrationNodeStatus } from '@insula/api-contracts';
import type { PlatformUpgradeRunRow } from '../../../db/schema.js';
import { advanceRun, PREPARE_TIMEOUT_MS, FINISH_TIMEOUT_MS, type RunMachineDeps } from './machine.js';
import type { NodeFacts, NodeJobFacts } from './node-state.js';
import type { RunPatch } from './store.js';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const TARGET = '2026.10.7-rc.4';

const run = (over: Partial<PlatformUpgradeRunRow> = {}): PlatformUpgradeRunRow => ({
  id: '0b6f7c1e-1234-4abc-9def-001122334455', fromVersion: '2026.10.7-rc.3', toVersion: TARGET,
  mode: 'manual', status: 'running', step: 'prepare-nodes', excludedNodes: [], nodes: [], message: null,
  initiatedBy: null, startedAt: new Date(T0), stepStartedAt: new Date(T0), finishedAt: null,
  ...over,
} as PlatformUpgradeRunRow);

const st = (node: string, cliVersion: string | null, items: HostMigrationNodeStatus['items'] = []): HostMigrationNodeStatus => ({
  node, collectedAt: '2026-10-09T10:00:00Z', mode: 'enforce', source: 'configmap', ok: true,
  appliedCount: 0, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0, invalidCount: 0,
  items, cliVersion,
} as HostMigrationNodeStatus);

interface World {
  now: number;
  nodes: NodeFacts[];
  statuses: HostMigrationNodeStatus[];
  jobs: Record<string, NodeJobFacts>;
  pending: string | null;
  installed: string | null;
  servicesApplied: boolean;
  applyOk: boolean;
  /** The run's step as the database holds it (a Cancel ends it). */
  dbStatus: string;
  dbStep: string;
  k8sApplyOk: boolean;
  k8sJobs: Record<string, NodeJobFacts>;
  k8sPlansExist: boolean;
}

function harness(w: Partial<World> = {}) {
  const world: World = {
    now: T0 + 60_000,
    nodes: [{ name: 'sv1', ready: true }, { name: 'sv2', ready: true }],
    statuses: [st('sv1', '2026.10.7-rc.3'), st('sv2', '2026.10.7-rc.3')],
    jobs: {}, pending: null, installed: '2026.10.7-rc.3', servicesApplied: true, applyOk: true,
    dbStatus: 'running', dbStep: 'prepare-nodes', k8sApplyOk: true, k8sJobs: {}, k8sPlansExist: true, ...w,
  };
  const calls = { patches: [] as RunPatch[], applied: [] as string[], deleted: [] as string[], services: 0, finalized: [] as Array<[string, string | null]>, progress: [] as Array<[number, string]>, k8sApplied: 0, k8sDeleted: 0 };
  const deps: RunMachineDeps = {
    now: () => world.now,
    nodes: async () => world.nodes,
    nodeStatuses: async () => new Map(world.statuses.map((s) => [s.node, s])),
    jobs: async () => new Map(Object.entries(world.jobs)),
    applyPlan: async (kind) => { calls.applied.push(kind); return world.applyOk ? { ok: true } : { ok: false, reason: 'admission denied' }; },
    deletePlan: async (kind) => { calls.deleted.push(kind); },
    startServices: async () => {
      calls.services += 1;
      if (world.servicesApplied) world.pending = TARGET;
      return { applied: world.servicesApplied, summary: world.servicesApplied ? 're-pinned' : 'refused — Flux is suspended' };
    },
    servicesState: async () => ({ pending: world.pending, installed: world.installed }),
    update: async (p) => { calls.patches.push(p); },
    transition: async (fromStep, p) => {
      if (world.dbStatus !== 'running' || (fromStep !== null && world.dbStep !== fromStep)) return false;
      calls.patches.push(p);
      if (p.step) world.dbStep = p.step;
      if (p.status) world.dbStatus = p.status;
      return true;
    },
    finalize: async (s, m) => { calls.finalized.push([s, m]); },
    progress: async (pct, text) => { calls.progress.push([pct, text]); },
    applyKubernetesPlans: async () => { calls.k8sApplied += 1; return world.k8sApplyOk ? { ok: true } : { ok: false, reason: 'refusing skip-a-minor' }; },
    deleteKubernetesPlans: async () => { calls.k8sDeleted += 1; },
    kubernetesJobs: async () => new Map(Object.entries(world.k8sJobs)),
    kubernetesPlansExist: async () => world.k8sPlansExist,
  };
  return { world, calls, deps };
}

describe('advanceRun — prepare-nodes', () => {
  it('waits while nodes are still on the old CLI; services untouched', async () => {
    const { calls, deps } = harness();
    expect(await advanceRun(run(), deps)).toBe('prepare-nodes');
    expect(calls.services).toBe(0);
    expect(calls.progress.at(-1)).toEqual([0, 'Preparing nodes 0/2']);
    // The node view is recorded for the UI.
    expect(calls.patches[0]?.nodes).toHaveLength(2);
  });

  it('every node ready → deletes the update plan, rolls the services, moves on', async () => {
    const { calls, deps } = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)] });
    expect(await advanceRun(run(), deps)).toBe('update-services');
    expect(calls.deleted).toEqual(['update']);
    expect(calls.services).toBe(1);
    expect(calls.patches.at(-1)).toMatchObject({ step: 'update-services' });
    expect(calls.progress.at(-1)?.[0]).toBe(33);
  });

  it('services already on the target (a release channel, or a break-glass re-pin) → no second re-pin', async () => {
    for (const w of [{ installed: TARGET, pending: null }, { installed: '2026.10.7-rc.3', pending: TARGET }]) {
      const { calls, deps } = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], ...w });
      expect(await advanceRun(run(), deps)).toBe('update-services');
      expect(calls.services).toBe(0);
    }
  });

  it('a Cancel that won the race: nodes ready, but the services are NOT re-pinned', async () => {
    const { calls, deps } = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], dbStatus: 'failed' });
    expect(await advanceRun(run(), deps)).toBe('prepare-nodes');
    expect(calls.services).toBe(0);
    expect(calls.finalized).toEqual([]);
  });

  it('an excluded node is not waited for', async () => {
    const { calls, deps } = harness({ nodes: [{ name: 'sv1', ready: true }, { name: 'sv2', ready: false }], statuses: [st('sv1', TARGET), st('sv2', '2026.10.6')] });
    expect(await advanceRun(run({ excludedNodes: ['sv2'] }), deps)).toBe('update-services');
    expect(calls.services).toBe(1);
  });

  it('a failed node stops the run BEFORE the services change', async () => {
    const { calls, deps } = harness({ jobs: { sv2: { active: 0, failed: 3, succeeded: 0 } } });
    await advanceRun(run(), deps);
    expect(calls.services).toBe(0);
    expect(calls.deleted).toEqual(['update']);
    expect(calls.patches.at(-1)).toMatchObject({ status: 'failed' });
    expect(calls.finalized[0]?.[0]).toBe('failed');
    expect(calls.finalized[0]?.[1]).toMatch(/Stopped before the services changed: sv2.*still run the previous release/);
  });

  it('services refused after the nodes were ready → failed, saying the nodes are fine', async () => {
    const { calls, deps } = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], servicesApplied: false });
    await advanceRun(run(), deps);
    expect(calls.finalized[0]?.[1]).toMatch(/nodes are ready, but the services were not changed: refused — Flux is suspended/);
  });

  it('times out naming the late nodes; services untouched', async () => {
    const { calls, deps } = harness({ now: T0 + PREPARE_TIMEOUT_MS + 1, statuses: [st('sv1', TARGET), st('sv2', '2026.10.7-rc.3')] });
    await advanceRun(run(), deps);
    expect(calls.services).toBe(0);
    expect(calls.finalized[0]?.[1]).toMatch(/did not finish preparing within 25 minutes: sv2/);
  });

  it('a waiting (Not Ready) node holds the run, and is reported as waiting', async () => {
    const { calls, deps } = harness({ nodes: [{ name: 'sv1', ready: true }, { name: 'sv2', ready: false }], statuses: [st('sv1', TARGET), st('sv2', '2026.10.6')] });
    expect(await advanceRun(run(), deps)).toBe('prepare-nodes');
    const nodes = calls.patches[0]?.nodes as Array<{ node: string; state: string }>;
    expect(nodes.find((n) => n.node === 'sv2')?.state).toBe('waiting');
  });

  it('an unchanged node view is not re-written every tick', async () => {
    const { calls, deps } = harness();
    const first = harness();
    await advanceRun(run(), first.deps);
    const recorded = first.calls.patches[0]?.nodes ?? [];
    await advanceRun(run({ nodes: recorded }), deps);
    expect(calls.patches).toHaveLength(0);
  });
});

describe('advanceRun — update-services and finish', () => {
  it('waits for the services to converge, then starts the finish plan', async () => {
    const h = harness({ pending: TARGET, dbStep: 'update-services' });
    expect(await advanceRun(run({ step: 'update-services' }), h.deps)).toBe('update-services');
    expect(h.calls.applied).toEqual([]);
    const c = harness({ pending: null, installed: TARGET, dbStep: 'update-services' });
    expect(await advanceRun(run({ step: 'update-services' }), c.deps)).toBe('finish');
    expect(c.calls.applied).toEqual(['finish']);
  });

  it('crash recovery: step claimed but nothing re-pinned → re-pins now, once', async () => {
    const h = harness({ pending: null, installed: '2026.10.7-rc.3', dbStep: 'update-services' });
    expect(await advanceRun(run({ step: 'update-services' }), h.deps)).toBe('update-services');
    expect(h.calls.services).toBe(1);
    expect(h.calls.applied).toEqual([]);
    // Next tick: the re-pin is in flight → waits, no second re-pin.
    await advanceRun(run({ step: 'update-services' }), h.deps);
    expect(h.calls.services).toBe(1);
  });

  it('an empty marker alone is NOT convergence — the services must run the target', async () => {
    const h = harness({ pending: null, installed: '2026.10.7-rc.3', dbStep: 'update-services', servicesApplied: false });
    await advanceRun(run({ step: 'update-services' }), h.deps);
    expect(h.calls.applied).toEqual([]);
    expect(h.calls.finalized[0]?.[1]).toMatch(/services were not changed/);
  });

  it('a finish plan that cannot be created fails the run, saying the services already run the target', async () => {
    const h = harness({ pending: null, installed: TARGET, applyOk: false, dbStep: 'update-services' });
    await advanceRun(run({ step: 'update-services' }), h.deps);
    expect(h.calls.finalized[0]?.[1]).toMatch(/services run 2026\.10\.7-rc\.4.*admission denied/);
  });

  it('finish: every node applied its after-services changes → succeeded', async () => {
    const h = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], dbStep: 'finish' });
    expect(await advanceRun(run({ step: 'finish' }), h.deps)).toBe('done');
    expect(h.calls.deleted).toEqual(['finish']);
    expect(h.calls.patches.at(-1)).toMatchObject({ status: 'succeeded', step: 'done' });
    expect(h.calls.finalized).toEqual([['succeeded', null]]);
    expect(h.calls.progress.at(-1)?.[0]).toBe(100);
  });

  it('finish: a deferred script still pending holds the run', async () => {
    const h = harness({ statuses: [st('sv1', TARGET, [{ key: '2026.10.7/0002-b.sh', state: 'deferred', phase: 'after-services' }]), st('sv2', TARGET)] });
    expect(await advanceRun(run({ step: 'finish' }), h.deps)).toBe('finish');
  });

  it('finish timeout: services stay on the target; the late nodes retry hourly', async () => {
    const h = harness({
      dbStep: 'finish',
      now: T0 + FINISH_TIMEOUT_MS + 1,
      statuses: [st('sv1', TARGET, [{ key: '2026.10.7/0002-b.sh', state: 'deferred', phase: 'after-services' }]), st('sv2', TARGET)],
    });
    await advanceRun(run({ step: 'finish' }), h.deps);
    expect(h.calls.finalized[0]?.[1]).toMatch(/services run 2026\.10\.7-rc\.4.*within 20 minutes on sv1.*hourly converge/);
  });

  it('a finished run is left alone', async () => {
    const h = harness();
    expect(await advanceRun(run({ status: 'succeeded', step: 'done' }), h.deps)).toBe('done');
    expect(h.calls.patches).toHaveLength(0);
  });
});

describe('advanceRun — the opt-in Kubernetes step (ADR-064 §8)', () => {
  const K = 'v1.36.5+k3s1';
  const kNodes = (v1: string, v2: string) => [{ name: 'sv1', ready: true, kubeletVersion: v1 }, { name: 'sv2', ready: true, kubeletVersion: v2 }];

  it('host changes finished + a Kubernetes target → starts the k3s Plans and enters the step (not done)', async () => {
    const h = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], dbStep: 'finish' });
    expect(await advanceRun(run({ step: 'finish', kubernetesVersion: K }), h.deps)).toBe('upgrade-kubernetes');
    expect(h.calls.k8sApplied).toBe(1);
    expect(h.calls.finalized).toEqual([]);
    // Quarters: finishing the host changes ends at 75 %.
    expect(h.calls.progress.at(-1)?.[0]).toBe(75);
  });

  it('a Kubernetes step that cannot start fails the run, saying the services and host changes are done', async () => {
    const h = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], dbStep: 'finish', k8sApplyOk: false });
    await advanceRun(run({ step: 'finish', kubernetesVersion: K }), h.deps);
    expect(h.calls.finalized[0]?.[1]).toMatch(/services and host changes run 2026\.10\.7-rc\.4.*Kubernetes step could not start: refusing skip-a-minor/);
  });

  it('every node on the target kubelet → plans deleted, succeeded', async () => {
    const h = harness({ nodes: kNodes(K, K), dbStep: 'upgrade-kubernetes' });
    expect(await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), h.deps)).toBe('done');
    expect(h.calls.k8sDeleted).toBe(1);
    expect(h.calls.finalized).toEqual([['succeeded', null]]);
  });

  it('waits while a node still runs the old kubelet; a node failing its job stops the run with plans deleted', async () => {
    const waiting = harness({ nodes: kNodes(K, 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes', k8sJobs: { sv2: { active: 1, failed: 0, succeeded: 0 } } });
    expect(await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), waiting.deps)).toBe('upgrade-kubernetes');
    expect(waiting.calls.progress.at(-1)?.[0]).toBe(88);
    const failing = harness({ nodes: kNodes(K, 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes', k8sJobs: { sv2: { active: 0, failed: 3, succeeded: 0 } } });
    await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), failing.deps);
    expect(failing.calls.k8sDeleted).toBe(1);
    expect(failing.calls.finalized[0]?.[1]).toMatch(/Kubernetes upgrade to v1\.36\.5\+k3s1 stopped on sv2/);
  });

  it('no Kubernetes target → the run ends at finish as before', async () => {
    const h = harness({ statuses: [st('sv1', TARGET), st('sv2', TARGET)], dbStep: 'finish' });
    expect(await advanceRun(run({ step: 'finish' }), h.deps)).toBe('done');
    expect(h.calls.k8sApplied).toBe(0);
  });

  it('resumable: claimed but no Plans (a crash in between) → creates them on the next tick', async () => {
    const h = harness({ nodes: kNodes('v1.36.2+k3s1', 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes', k8sPlansExist: false });
    expect(await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), h.deps)).toBe('upgrade-kubernetes');
    expect(h.calls.k8sApplied).toBe(1);
    const present = harness({ nodes: kNodes('v1.36.2+k3s1', 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes' });
    await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), present.deps);
    expect(present.calls.k8sApplied).toBe(0);
  });

  it('never times out while a node is mid-upgrade — only once nothing is in flight', async () => {
    const late = T0 + 61 * 60 * 1000;
    const busy = harness({ now: late, nodes: kNodes(K, 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes', k8sJobs: { sv2: { active: 1, failed: 0, succeeded: 0 } } });
    await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), busy.deps);
    expect(busy.calls.finalized).toEqual([]);
    expect(busy.calls.k8sDeleted).toBe(0);
    const idle = harness({ now: late, nodes: kNodes(K, 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes' });
    await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), idle.deps);
    expect(idle.calls.finalized[0]?.[1]).toMatch(/did not reach v1\.36\.5\+k3s1 within 60 minutes on sv2/);
  });

  it('a node still retrying after failures is updating, not failed — the Plans are not deleted under it', async () => {
    const h = harness({ nodes: kNodes(K, 'v1.36.2+k3s1'), dbStep: 'upgrade-kubernetes', k8sJobs: { sv2: { active: 1, failed: 4, succeeded: 0 } } });
    await advanceRun(run({ step: 'upgrade-kubernetes', kubernetesVersion: K }), h.deps);
    expect(h.calls.k8sDeleted).toBe(0);
    expect(h.calls.finalized).toEqual([]);
  });
});

