import { describe, it, expect } from 'vitest';
import { parseK3sVersion, buildK3sUpgradePlans } from './k3s-plan.js';

describe('parseK3sVersion', () => {
  it('parses vX.Y.Z+k3sN (leading v optional)', () => {
    expect(parseK3sVersion('v1.31.5+k3s1')).toEqual({ major: 1, minor: 31, patch: 5, k3s: 1, raw: 'v1.31.5+k3s1' });
    expect(parseK3sVersion('1.30.10+k3s2')).toMatchObject({ minor: 30, patch: 10, k3s: 2 });
  });
  it('rejects non-k3s / malformed versions', () => {
    for (const v of ['v1.31.5', '1.31', 'latest', 'v1.31.5+rke2r1', '']) {
      expect(parseK3sVersion(v)).toBeNull();
    }
  });
});

describe('buildK3sUpgradePlans — safety gates', () => {
  it('REFUSES skip-a-minor (decision #8)', () => {
    const r = buildK3sUpgradePlans('v1.33.0+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/skip-a-minor/);
  });
  it('REFUSES downgrade', () => {
    const r = buildK3sUpgradePlans('v1.30.9+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/downgrade/);
  });
  it('REFUSES no-op (same version)', () => {
    const r = buildK3sUpgradePlans('v1.31.5+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/downgrade \/ no-op/);
  });
  it('REFUSES cross-major', () => {
    const r = buildK3sUpgradePlans('v2.0.0+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cross-major/);
  });
  it('REFUSES a bad target/current string', () => {
    expect(buildK3sUpgradePlans('garbage', 'v1.31.5+k3s1').ok).toBe(false);
    expect(buildK3sUpgradePlans('v1.32.0+k3s1', 'garbage').ok).toBe(false);
  });
});

describe('buildK3sUpgradePlans — accepted transitions', () => {
  it('allows a single-minor step', () => {
    const r = buildK3sUpgradePlans('v1.32.1+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe('v1.32.1+k3s1');
  });
  it('compares patch numerically, not lexicographically (3 → 10 allowed)', () => {
    expect(buildK3sUpgradePlans('v1.31.10+k3s1', 'v1.31.3+k3s1').ok).toBe(true);
  });
  it('refuses a numeric patch downgrade (10 → 3)', () => {
    expect(buildK3sUpgradePlans('v1.31.3+k3s1', 'v1.31.10+k3s1').ok).toBe(false);
  });
  it('REFUSES a --upgrade-image with shell metacharacters / garbage', () => {
    for (const img of ['evil;rm -rf /', 'a b', '$(x)', 'foo|bar', 'UPPER/Case']) {
      const r = buildK3sUpgradePlans('v1.32.0+k3s1', 'v1.31.5+k3s1', { upgradeImage: img });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/--upgrade-image/);
    }
  });
  it('accepts a well-formed --upgrade-image (registry/repo:tag@digest)', () => {
    const ok = `mirror.local/k3s-upgrade:v1.32.0-k3s1@sha256:${'a'.repeat(64)}`;
    expect(buildK3sUpgradePlans('v1.32.0+k3s1', 'v1.31.5+k3s1', { upgradeImage: ok }).ok).toBe(true);
  });
  it('allows a patch bump within the same minor', () => {
    const r = buildK3sUpgradePlans('v1.31.7+k3s1', 'v1.31.5+k3s1');
    expect(r.ok).toBe(true);
  });
  it('allows a +k3sN suffix bump (same X.Y.Z)', () => {
    const r = buildK3sUpgradePlans('v1.31.5+k3s2', 'v1.31.5+k3s1');
    expect(r.ok).toBe(true);
  });
});

describe('buildK3sUpgradePlans — Plan shape', () => {
  const r = buildK3sUpgradePlans('v1.32.0+k3s1', 'v1.31.5+k3s1');
  const plans = r.ok ? r.plans : [];
  const server = plans[0] as any;
  const agent = plans[1] as any;

  it('emits exactly a server + agent Plan in the system-upgrade namespace', () => {
    expect(plans).toHaveLength(2);
    expect(server.metadata.name).toBe('k3s-server-upgrade');
    expect(agent.metadata.name).toBe('k3s-agent-upgrade');
    for (const p of [server, agent]) {
      expect(p.apiVersion).toBe('upgrade.cattle.io/v1');
      expect(p.kind).toBe('Plan');
      expect(p.metadata.namespace).toBe('system-upgrade');
      expect(p.spec.serviceAccountName).toBe('system-upgrade');
      expect(p.spec.concurrency).toBe(1);
      expect(p.spec.version).toBe('v1.32.0+k3s1');
      expect(p.spec.upgrade.image).toBe('rancher/k3s-upgrade');
    }
  });
  it('server targets control-plane and does NOT drain; agent drains + waits for the server', () => {
    expect(server.spec.nodeSelector.matchExpressions[0]).toMatchObject({ key: 'node-role.kubernetes.io/control-plane', operator: 'In' });
    expect(server.spec.drain).toBeUndefined();
    expect(agent.spec.nodeSelector.matchExpressions[0].operator).toBe('DoesNotExist');
    expect(agent.spec.drain.force).toBe(true);
    expect(agent.spec.prepare).toEqual({ image: 'rancher/k3s-upgrade', args: ['prepare', 'k3s-server-upgrade'] });
  });
  it('honours an upgradeImage override', () => {
    const o = buildK3sUpgradePlans('v1.32.0+k3s1', 'v1.31.5+k3s1', { upgradeImage: 'mirror.local/k3s-upgrade:pinned' });
    const s = o.ok ? (o.plans[0] as any) : null;
    expect(s.spec.upgrade.image).toBe('mirror.local/k3s-upgrade:pinned');
  });
});
