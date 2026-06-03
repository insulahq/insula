import { describe, it, expect, vi } from 'vitest';
import { runUpgrade, type SettingsIO } from './orchestrate.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function fakeSettings(seed: Record<string, string> = {}): { io: SettingsIO; store: Record<string, string> } {
  const store = { ...seed };
  return {
    store,
    io: { get: async (k) => store[k] ?? null, set: async (k, v) => { store[k] = v; } },
  };
}

function fakeK8s(opts: { source?: string | null; ref?: unknown } = {}): { k8s: K8sClients; patches: unknown[] } {
  const patches: unknown[] = [];
  const k8s = {
    custom: {
      getNamespacedCustomObject: vi.fn(async (a: { plural: string }) => {
        if (a.plural === 'kustomizations') {
          if (opts.source === null) return { spec: {} };
          return { spec: { sourceRef: { kind: 'GitRepository', name: opts.source ?? 'hosting-platform-production' } } };
        }
        return { spec: { ref: opts.ref ?? { branch: 'stable' } } }; // gitrepositories
      }),
      patchNamespacedCustomObject: vi.fn(async (a: unknown) => { patches.push(a); }),
    },
  } as unknown as K8sClients;
  return { k8s, patches };
}

const seedReady = { installed_platform_version: '2026.6.2', available_version: '2026.7.0', auto_update: 'true' };

describe('runUpgrade', () => {
  it('auto + apply re-pins the resolved GitRepository to the available tag', async () => {
    const { io, store } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.applied).toBe(true);
    expect(r.gitRepository).toBe('hosting-platform-production');
    expect(r.repin?.tag).toBe('v2026.7.0');
    expect(patches).toHaveLength(1);
    expect(store.pending_update_version).toBe('2026.7.0'); // in-flight target recorded
  });

  it('dry-run (apply=false) resolves + previews but patches nothing', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: false });
    expect(r.applied).toBe(false);
    expect(r.summary).toMatch(/DRY-RUN.*hosting-platform-production.*v2026\.7\.0/);
    expect(patches).toHaveLength(0);
  });

  it('auto with auto_update off → no-op, no resolve, no patch', async () => {
    const { io } = fakeSettings({ ...seedReady, auto_update: 'false' });
    const { k8s, patches } = fakeK8s();
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.applied).toBe(false);
    expect(r.decision.action).toBe('blocked-auto-off');
    expect(patches).toHaveLength(0);
  });

  it('auto with a BREAKING candidate → blocked, no patch', async () => {
    const { io } = fakeSettings({ ...seedReady, available_breaking: 'true' });
    const { k8s, patches } = fakeK8s();
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.decision.action).toBe('blocked-breaking');
    expect(patches).toHaveLength(0);
  });

  it('manual --version overrides auto_update being off', async () => {
    const { io } = fakeSettings({ installed_platform_version: '2026.6.2', auto_update: 'false' });
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const r = await runUpgrade(io, k8s, { mode: 'manual', requestedVersion: '2026.8.1', apply: true });
    expect(r.applied).toBe(true);
    expect(r.repin?.tag).toBe('v2026.8.1');
    expect(patches).toHaveLength(1);
  });

  it('apply but no GitRepository resolvable → not applied, clear summary', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: null });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.applied).toBe(false);
    expect(r.summary).toMatch(/could not resolve/);
    expect(patches).toHaveLength(0);
  });

  it('apply ABORTS (no re-pin) when the rollback rescue capture fails (W16 safety net)', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const capture = vi.fn(async () => ({ ok: false, reason: 'rescue captured 0 volumes' }));
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true, rollback: { capture } });
    expect(capture).toHaveBeenCalledWith({ fromVersion: '2026.6.2', toVersion: '2026.7.0', gitRepository: 'hosting-platform-production' });
    expect(r.applied).toBe(false);
    expect(r.summary).toMatch(/aborted.*rescue/);
    expect(patches).toHaveLength(0); // never re-pinned without a safety net
  });

  it('apply PROCEEDS (re-pins) when the rescue capture succeeds', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const capture = vi.fn(async () => ({ ok: true }));
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true, rollback: { capture } });
    expect(r.applied).toBe(true);
    expect(patches).toHaveLength(1);
  });
});
