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

function fakeK8s(opts: { source?: string | null; ref?: unknown; suspend?: { ks?: boolean; repo?: boolean } } = {}): { k8s: K8sClients; patches: unknown[] } {
  const patches: unknown[] = [];
  const k8s = {
    custom: {
      getNamespacedCustomObject: vi.fn(async (a: { plural: string }) => {
        if (a.plural === 'kustomizations') {
          if (opts.source === null) return { spec: {} };
          return { spec: { suspend: opts.suspend?.ks, sourceRef: { kind: 'GitRepository', name: opts.source ?? 'hosting-platform-production' } } };
        }
        return { spec: { suspend: opts.suspend?.repo, ref: opts.ref ?? { branch: 'stable' } } }; // gitrepositories
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

  // The upgrade IS the re-pin, so a suspended Kustomization or source turns it
  // into a silent no-op ("Flux is reconciling" — and nothing ever rolls). Refused
  // here, in runUpgrade, so the API, the host CLI (`platform-ops upgrade --apply`)
  // and the auto-update scheduler all get it — not only the UI's pre-flight.
  it.each([
    ['the platform Kustomization', { ks: true }, 'Kustomization/platform'],
    ['its GitRepository', { repo: true }, 'GitRepository/hosting-platform-production'],
  ])('apply refuses to re-pin while %s is suspended — no rescue capture, no patch', async (_l, suspend, named) => {
    const { io, store } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ suspend });
    const capture = vi.fn(async () => ({ ok: true }));
    const r = await runUpgrade(io, k8s, { mode: 'manual', apply: true, rollback: { capture } });
    expect(r.applied).toBe(false);
    expect(r.summary).toContain('suspended');
    expect(r.summary).toContain(named);
    expect(patches).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
    expect(store.pending_update_version).toBeUndefined();
  });

  it('a dry-run still previews while suspended (the pre-flight names the problem)', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s } = fakeK8s({ suspend: { ks: true } });
    expect((await runUpgrade(io, k8s, { mode: 'auto', apply: false })).summary).toMatch(/^DRY-RUN/);
  });

  it('dry-run (apply=false) resolves + previews but patches nothing', async () => {
    const { io } = fakeSettings(seedReady);
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: false });
    expect(r.applied).toBe(false);
    expect(r.summary).toMatch(/DRY-RUN.*hosting-platform-production.*v2026\.7\.0/);
    expect(patches).toHaveLength(0);
  });

  // ── Mode B: prerelease (-rc.N) auto-pin, gated by auto_update_include_prereleases ──
  const seedRc = { installed_platform_version: '2026.6.2', available_version: '2026.7.0-rc.1', auto_update: 'true' };

  it('Mode B: pins an -rc.N tag when auto_update_include_prereleases is on (staging)', async () => {
    const { io } = fakeSettings({ ...seedRc, auto_update_include_prereleases: 'true' });
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-staging', ref: { branch: 'development' } });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.applied).toBe(true);
    expect(r.repin?.tag).toBe('v2026.7.0-rc.1');
    // the re-pin switches the staging source from branch → rc tag
    expect((patches[0] as { body: { spec: { ref: unknown } } }).body.spec.ref).toEqual({ tag: 'v2026.7.0-rc.1', branch: null, commit: null });
  });

  it('refuses to pin an -rc.N tag when the prerelease flag is OFF (production safety)', async () => {
    const { io } = fakeSettings(seedRc); // no auto_update_include_prereleases
    const { k8s, patches } = fakeK8s({ source: 'hosting-platform-production' });
    const r = await runUpgrade(io, k8s, { mode: 'auto', apply: true });
    expect(r.applied).toBe(false);
    expect(r.summary).toMatch(/no clean release tag/);
    expect(patches).toHaveLength(0);
  });

  it('Mode B: a manual --version <rc> is also refused unless the prerelease flag is on', async () => {
    const off = fakeSettings({ installed_platform_version: '2026.6.2', auto_update: 'false' });
    const k1 = fakeK8s({ source: 'hosting-platform-production' });
    const r1 = await runUpgrade(off.io, k1.k8s, { mode: 'manual', requestedVersion: '2026.7.0-rc.1', apply: true });
    expect(r1.applied).toBe(false);
    expect(k1.patches).toHaveLength(0);

    const on = fakeSettings({ installed_platform_version: '2026.6.2', auto_update: 'false', auto_update_include_prereleases: 'true' });
    const k2 = fakeK8s({ source: 'hosting-platform-staging', ref: { branch: 'development' } });
    const r2 = await runUpgrade(on.io, k2.k8s, { mode: 'manual', requestedVersion: '2026.7.0-rc.1', apply: true });
    expect(r2.applied).toBe(true);
    expect(r2.repin?.tag).toBe('v2026.7.0-rc.1');
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
