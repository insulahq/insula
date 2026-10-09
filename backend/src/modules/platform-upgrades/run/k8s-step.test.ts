import { describe, it, expect } from 'vitest';
import { assessKubernetesNode, buildRunK3sPlans, kubernetesOffer, lowestKubelet } from './k8s-step.js';

const T = 'v1.36.5+k3s1';
type P = { metadata: { name: string; labels: Record<string, string> }; spec: { nodeSelector: { matchExpressions: Array<Record<string, unknown>> }; drain?: unknown; prepare?: unknown; version: string } };

describe('lowestKubelet', () => {
  it('the lowest parseable version — what a hop starts from', () => {
    expect(lowestKubelet([
      { name: 'a', ready: true, kubeletVersion: 'v1.36.5+k3s1' },
      { name: 'b', ready: true, kubeletVersion: 'v1.36.2+k3s1' },
      { name: 'c', ready: true, kubeletVersion: null },
    ])).toBe('v1.36.2+k3s1');
    expect(lowestKubelet([])).toBeNull();
  });
});

describe('kubernetesOffer', () => {
  it('offers a newer patch or the next minor', () => {
    expect(kubernetesOffer('v1.36.2+k3s1', T)).toEqual({ offer: true, reason: null });
    expect(kubernetesOffer('v1.35.9+k3s1', 'v1.36.5+k3s1')).toEqual({ offer: true, reason: null });
  });
  it('not when already there; refuses a skipped minor, saying what to use', () => {
    expect(kubernetesOffer(T, T)).toEqual({ offer: false, reason: null });
    expect(kubernetesOffer('v1.37.1+k3s1', T)).toEqual({ offer: false, reason: null });
    const skip = kubernetesOffer('v1.34.1+k3s1', T);
    expect(skip.offer).toBe(false);
    expect(skip.reason).toMatch(/skips a minor.*insula cluster upgrade/);
  });
  it('a major-version jump says so (not "skips a minor")', () => {
    expect(kubernetesOffer('v1.36.2+k3s1', 'v2.0.1+k3s1').reason).toMatch(/changes the major version/);
  });

  it('no target (an older release) → nothing to say; unreadable cluster → says so', () => {
    expect(kubernetesOffer('v1.36.2+k3s1', null)).toEqual({ offer: false, reason: null });
    expect(kubernetesOffer(null, T).reason).toMatch(/could not be read/);
  });
});

describe('buildRunK3sPlans', () => {
  it('the CLI builder\'s server + agent Plans, labelled platform-api, leaving excluded nodes out', () => {
    const r = buildRunK3sPlans(T, 'v1.36.2+k3s1', ['w1']);
    if (!r.ok) throw new Error(r.reason);
    const [server, agent] = r.plans as unknown as P[];
    expect(server?.metadata.name).toBe('k3s-server-upgrade');
    expect(agent?.metadata.name).toBe('k3s-agent-upgrade');
    expect(server?.metadata.labels['insula.host/managed-by']).toBe('platform-api');
    expect(server?.spec.version).toBe(T);
    expect(server?.spec.drain).toBeUndefined();
    expect(agent?.spec.drain).toBeDefined();
    expect(agent?.spec.prepare).toEqual({ image: 'rancher/k3s-upgrade', args: ['prepare', 'k3s-server-upgrade'] });
    for (const p of [server, agent]) {
      expect(p?.spec.nodeSelector.matchExpressions).toContainEqual({ key: 'kubernetes.io/hostname', operator: 'NotIn', values: ['w1'] });
    }
  });
  it('refuses what the CLI refuses (skip-a-minor, downgrade) and a bad node name', () => {
    expect(buildRunK3sPlans(T, 'v1.34.1+k3s1', []).ok).toBe(false);
    expect(buildRunK3sPlans('v1.36.2+k3s1', T, []).ok).toBe(false);
    expect(buildRunK3sPlans(T, 'v1.36.2+k3s1', ['Bad Name']).ok).toBe(false);
  });
});

describe('assessKubernetesNode', () => {
  const HASH = new Map([['k3s-server-upgrade', 'h-server'], ['k3s-agent-upgrade', 'h-agent']]);
  const up = (kubeletVersion: string, planHashes: Record<string, string> = {}) => ({ name: 'sv1', ready: true, kubeletVersion, planHashes });
  const finished = { 'k3s-server-upgrade': 'h-server' };

  it('ready once its kubelet is at the target, it is Ready, and the controller recorded its Plan\'s current hash on it', () => {
    expect(assessKubernetesNode(up(T, finished), undefined, T, [], HASH).state).toBe('ready');
    expect(assessKubernetesNode({ ...up(T), planHashes: { 'k3s-agent-upgrade': 'h-agent' } }, undefined, T, [], HASH).state).toBe('ready');
  });

  it('the kubelet at the target is NOT done while the controller has not finished — it uncordons in that same update', () => {
    const running = assessKubernetesNode({ ...up(T), unschedulable: true }, { active: 0, failed: 0, succeeded: 1 }, T, [], HASH);
    expect(running.state).toBe('updating');
    expect(running.detail).toMatch(/waiting for the upgrade controller to finish/);
    // A record from an earlier spec of the Plan (another hash) is not this run's.
    expect(assessKubernetesNode(up(T, { 'k3s-server-upgrade': 'old' }), undefined, T, [], HASH).state).toBe('queued');
    // Plans not yet synced by the controller: nothing to compare with.
    expect(assessKubernetesNode(up(T, finished), undefined, T, [], new Map()).state).toBe('queued');
  });

  it('a worker whose job waits for the servers (not cordoned yet) is queued, not updating; once cordoned it is updating', () => {
    const waiting = assessKubernetesNode(up('v1.36.2+k3s1'), { active: 1, failed: 0, succeeded: 0 }, T, [], HASH);
    expect(waiting.state).toBe('queued');
    expect(waiting.detail).toMatch(/waits for its turn \(servers first, then workers\)/);
    const going = assessKubernetesNode({ ...up('v1.36.2+k3s1'), unschedulable: true }, { active: 1, failed: 0, succeeded: 0 }, T, [], HASH);
    expect(going.state).toBe('updating');
    expect(going.detail).toMatch(/Upgrading Kubernetes v1\.36\.2\+k3s1 →/);
  });

  it('a node restarting k3s mid-job is updating, not waiting or failed', () => {
    const n = assessKubernetesNode({ name: 'sv1', ready: false, kubeletVersion: 'v1.36.2+k3s1' }, { active: 1, failed: 0, succeeded: 0 }, T, [], HASH);
    expect(n.state).toBe('updating');
    expect(n.detail).toMatch(/Restarting k3s/);
  });

  it('fails after repeated job failures, saying when it stays cordoned; queued before its turn; excluded stays out', () => {
    const failed = assessKubernetesNode({ ...up('v1.36.2+k3s1'), unschedulable: true }, { active: 0, failed: 3, succeeded: 0 }, T, [], HASH);
    expect(failed.state).toBe('failed');
    expect(failed.detail).toMatch(/stays cordoned until you uncordon it/);
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), { active: 0, failed: 3, succeeded: 0 }, T, [], HASH).detail).not.toMatch(/cordoned/);
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), undefined, T, [], HASH).state).toBe('queued');
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), undefined, T, ['sv1'], HASH).state).toBe('excluded');
  });
});
