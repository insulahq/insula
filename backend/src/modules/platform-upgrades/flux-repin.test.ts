import { describe, it, expect, vi } from 'vitest';
import { gitTagForVersion, repinGitRepositoryTag, repinGitRepositoryRef } from './flux-repin.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

describe('gitTagForVersion', () => {
  it('maps a clean CalVer (with or without v) to vX.Y.Z', () => {
    expect(gitTagForVersion('2026.6.2')).toBe('v2026.6.2');
    expect(gitTagForVersion('v2026.11.0')).toBe('v2026.11.0');
  });
  it('refuses a dev pin (-<sha>), a prerelease, and garbage', () => {
    expect(gitTagForVersion('2026.6.2-9d96573')).toBeNull();
    expect(gitTagForVersion('2026.7.0-rc.1')).toBeNull();
    expect(gitTagForVersion('latest')).toBeNull();
    expect(gitTagForVersion('')).toBeNull();
  });
});

function fakeK8s(opts: { ref?: unknown; missing?: boolean } = {}): { k8s: K8sClients; patches: unknown[] } {
  const patches: unknown[] = [];
  const k8s = {
    custom: {
      getNamespacedCustomObject: vi.fn(async () => {
        if (opts.missing) { const e = new Error('nf') as Error & { statusCode: number }; e.statusCode = 404; throw e; }
        return { spec: { ref: opts.ref ?? { branch: 'staging' } } };
      }),
      patchNamespacedCustomObject: vi.fn(async (a: unknown) => { patches.push(a); }),
    },
  } as unknown as K8sClients;
  return { k8s, patches };
}

describe('repinGitRepositoryTag', () => {
  it('reads the previous ref and merge-patches spec.ref to the tag (clearing branch)', async () => {
    const { k8s, patches } = fakeK8s({ ref: { branch: 'staging' } });
    const r = await repinGitRepositoryTag(k8s, 'hosting-platform-production', 'v2026.7.0');
    expect(r.ok).toBe(true);
    expect(r.previousRef).toEqual({ branch: 'staging' });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { body: { spec: { ref: unknown } } }).body.spec.ref).toEqual({ tag: 'v2026.7.0', branch: null, commit: null });
  });
  it('refuses a malformed tag without touching the cluster', async () => {
    const { k8s, patches } = fakeK8s();
    const r = await repinGitRepositoryTag(k8s, 'x', 'not-a-tag');
    expect(r.ok).toBe(false);
    expect(patches).toHaveLength(0);
  });
  it('returns ok:false when the GitRepository is absent (never throws)', async () => {
    const { k8s, patches } = fakeK8s({ missing: true });
    const r = await repinGitRepositoryTag(k8s, 'nope', 'v2026.7.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/);
    expect(patches).toHaveLength(0);
  });
});

describe('repinGitRepositoryRef (rollback — restore any tag/branch/commit)', () => {
  it('restores a branch, clearing tag + commit', async () => {
    const { k8s, patches } = fakeK8s({ ref: { tag: 'v2026.7.0' } });
    const r = await repinGitRepositoryRef(k8s, 'hosting-platform-production', { branch: 'staging' });
    expect(r.ok).toBe(true);
    expect((patches[0] as { body: { spec: { ref: unknown } } }).body.spec.ref).toEqual({ tag: null, branch: 'staging', commit: null });
  });
  it('restores a tag', async () => {
    const { k8s, patches } = fakeK8s({ ref: { branch: 'staging' } });
    const r = await repinGitRepositoryRef(k8s, 'x', { tag: 'v2026.6.2' });
    expect(r.ok).toBe(true);
    expect((patches[0] as { body: { spec: { ref: { tag: string } } } }).body.spec.ref.tag).toBe('v2026.6.2');
  });
  it('refuses an ambiguous (>1 component) or empty ref — no patch', async () => {
    const { k8s, patches } = fakeK8s();
    expect((await repinGitRepositoryRef(k8s, 'x', { tag: 'v1.0.0', branch: 'main' })).ok).toBe(false);
    expect((await repinGitRepositoryRef(k8s, 'x', {})).ok).toBe(false);
    expect(patches).toHaveLength(0);
  });
  it('refuses a malformed ref value / GitRepository name — no patch', async () => {
    const { k8s, patches } = fakeK8s();
    expect((await repinGitRepositoryRef(k8s, 'x', { branch: 'evil ; rm -rf' })).ok).toBe(false);
    expect((await repinGitRepositoryRef(k8s, 'Bad_Name!', { branch: 'staging' })).ok).toBe(false);
    expect(patches).toHaveLength(0);
  });
  it('returns ok:false when the GitRepository is absent (never throws)', async () => {
    const { k8s, patches } = fakeK8s({ missing: true });
    const r = await repinGitRepositoryRef(k8s, 'nope', { branch: 'staging' });
    expect(r.ok).toBe(false);
    expect(patches).toHaveLength(0);
  });
});
