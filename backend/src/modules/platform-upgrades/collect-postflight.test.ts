import { describe, it, expect } from 'vitest';
import { runPostflight } from './collect-postflight.js';
import type { SettingsIO } from './orchestrate.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function fakeSettings(initial: Record<string, string> = {}): { io: SettingsIO; store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  const io: SettingsIO = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); },
  };
  return { io, store };
}

/** Minimal k8s fake: CNPG CR ready, N deployments available, M crashloops. */
function fakeK8s(opts: { cnpgReady?: number; cnpgTotal?: number; deployTotal?: number; deployAvail?: number; crashloops?: number } = {}): K8sClients {
  const { cnpgReady = 1, cnpgTotal = 1, deployTotal = 3, deployAvail = 3, crashloops = 0 } = opts;
  return {
    custom: {
      getNamespacedCustomObject: async () => ({ status: { readyInstances: cnpgReady, instances: cnpgTotal, phase: 'Cluster in healthy state' } }),
    },
    apps: {
      listNamespacedDeployment: async () => ({
        items: Array.from({ length: deployTotal }, (_, i) => ({ spec: { replicas: 1 }, status: { availableReplicas: i < deployAvail ? 1 : 0 } })),
      }),
    },
    core: {
      listNamespacedPod: async () => ({
        items: Array.from({ length: crashloops }, () => ({ status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] } })),
      }),
    },
  } as unknown as K8sClients;
}

describe('runPostflight (observer)', () => {
  it('no upgrade in flight → idle, streak 0, state persisted', async () => {
    const { io, store } = fakeSettings({});
    const s = await runPostflight(io, fakeK8s(), 1_000);
    expect(s.phase).toBe('idle');
    expect(s.verdict).toBe('idle');
    expect(s.consecutiveFailures).toBe(0);
    expect(store.get('postflight_state')).toBeTruthy();
    expect(s.lastCheckedAt).toBe(new Date(1_000).toISOString());
  });

  it('pending set + still on old version → reconciling, streak increments + persists', async () => {
    // running version is "unknown" in tests (no PLATFORM_VERSION); pending differs → not converged.
    const { io, store } = fakeSettings({ pending_update_version: '2026.6.9', postflight_consecutive_failures: '0' });
    const s = await runPostflight(io, fakeK8s(), 2_000);
    expect(s.phase).toBe('reconciling');
    expect(s.verdict).toBe('reconciling');
    expect(s.consecutiveFailures).toBe(1);
    expect(store.get('postflight_consecutive_failures')).toBe('1');
    // pending is NOT cleared while still reconciling
    expect(store.get('pending_update_version')).toBe('2026.6.9');
  });

  it('three consecutive reconciling observations → abort-recommended', async () => {
    const { io, store } = fakeSettings({ pending_update_version: '2026.6.9', postflight_consecutive_failures: '2' });
    const s = await runPostflight(io, fakeK8s(), 3_000);
    expect(s.consecutiveFailures).toBe(3);
    expect(s.verdict).toBe('abort-recommended');
    expect(store.get('postflight_consecutive_failures')).toBe('3');
  });

  it('CNPG down while pending → fail gate, reconciling, streak advances', async () => {
    const { io } = fakeSettings({ pending_update_version: '2026.6.9' });
    const s = await runPostflight(io, fakeK8s({ cnpgReady: 0, cnpgTotal: 1 }), 4_000);
    expect(s.ok).toBe(false);
    expect(s.gates.find((g) => g.id === 'cnpg-healthy')!.status).toBe('fail');
    expect(s.verdict).toBe('reconciling');
  });

  it('converged + healthy → verdict healthy, streak reset, pending cleared', async () => {
    // Force convergence by pinning pending to the running version the module reports.
    const running = (process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown').trim();
    const { io, store } = fakeSettings({ pending_update_version: running, postflight_consecutive_failures: '2' });
    const s = await runPostflight(io, fakeK8s({ deployTotal: 4, deployAvail: 4, crashloops: 0 }), 5_000);
    expect(s.phase).toBe('healthy');
    expect(s.verdict).toBe('healthy');
    expect(s.consecutiveFailures).toBe(0);
    expect(store.get('pending_update_version')).toBe(''); // cleared
    expect(store.get('postflight_consecutive_failures')).toBe('0');
  });

  it('after a healthy clear, the NEXT run reads idle — never re-accrues a streak (regression)', async () => {
    const running = (process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown').trim();
    const { io, store } = fakeSettings({ pending_update_version: running });
    await runPostflight(io, fakeK8s({ deployTotal: 2, deployAvail: 2 }), 6_000); // → healthy, sets pending=''
    expect(store.get('pending_update_version')).toBe('');
    // second observation: '' must normalise to null → idle, NOT a reconciling streak
    const s2 = await runPostflight(io, fakeK8s({ deployTotal: 2, deployAvail: 2 }), 7_000);
    expect(s2.phase).toBe('idle');
    expect(s2.verdict).toBe('idle');
    expect(s2.consecutiveFailures).toBe(0);
  });

  it('deployments unreadable (k8s list throws) → reconciling, ok=false', async () => {
    const k8s = {
      custom: { getNamespacedCustomObject: async () => ({ status: { readyInstances: 1, instances: 1 } }) },
      apps: { listNamespacedDeployment: async () => { throw new Error('api down'); } },
      core: { listNamespacedPod: async () => ({ items: [] }) },
    } as unknown as K8sClients;
    const { io } = fakeSettings({ pending_update_version: '2026.6.9' });
    const s = await runPostflight(io, k8s, 8_000);
    expect(s.ok).toBe(false);
    expect(s.gates.find((g) => g.id === 'deployments-available')!.detail).toMatch(/unreadable/);
  });
});
