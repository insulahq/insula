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
  const up = (kubeletVersion: string) => ({ name: 'sv1', ready: true, kubeletVersion });
  it('ready once its kubelet is at the target and it is Ready', () => {
    expect(assessKubernetesNode(up(T), undefined, T, []).state).toBe('ready');
  });
  it('a node restarting k3s mid-job is updating, not waiting or failed', () => {
    const n = assessKubernetesNode({ name: 'sv1', ready: false, kubeletVersion: 'v1.36.2+k3s1' }, { active: 1, failed: 0, succeeded: 0 }, T, []);
    expect(n.state).toBe('updating');
    expect(n.detail).toMatch(/Restarting k3s/);
  });
  it('fails after repeated job failures; queued before its turn; excluded stays out', () => {
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), { active: 0, failed: 3, succeeded: 0 }, T, []).state).toBe('failed');
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), undefined, T, []).state).toBe('queued');
    expect(assessKubernetesNode(up('v1.36.2+k3s1'), undefined, T, ['sv1']).state).toBe('excluded');
  });
});
