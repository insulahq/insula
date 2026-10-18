import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ensureHostnameSpread, hasHardHostnameSpread, hostnameSpreadFor, spreadPatchFor } from './hostname-spread.js';

const sel = { 'app.kubernetes.io/name': 'cert-manager', 'app.kubernetes.io/component': 'controller' };
const dep = (o: { flux?: boolean; constraints?: unknown[]; selector?: Record<string, string> } = {}) => ({
  metadata: { labels: o.flux ? { 'kustomize.toolkit.fluxcd.io/name': 'platform' } : { 'app.kubernetes.io/managed-by': 'Helm' } },
  spec: {
    selector: { matchLabels: o.selector ?? sel },
    template: { spec: { topologySpreadConstraints: o.constraints } },
  },
});

describe('one replica per server for the HA operators (production: both cert-manager replicas on one server)', () => {
  it('the rule is hard, per node, and counted per rollout revision', () => {
    expect(hostnameSpreadFor(sel)).toEqual({
      maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'DoNotSchedule',
      labelSelector: { matchLabels: sel }, matchLabelKeys: ['pod-template-hash'],
    });
  });

  it('adds it to a bootstrap-installed Deployment that has none, keeping its other constraints', () => {
    const zone = { maxSkew: 1, topologyKey: 'topology.kubernetes.io/zone', whenUnsatisfiable: 'ScheduleAnyway' };
    expect(spreadPatchFor(dep({ constraints: [zone] }))).toEqual([zone, hostnameSpreadFor(sel)]);
  });

  it('replaces a soft per-node rule (ScheduleAnyway lets both land on one server)', () => {
    const soft = { maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway' };
    expect(hasHardHostnameSpread([soft])).toBe(false);
    expect(spreadPatchFor(dep({ constraints: [soft] }))).toEqual([hostnameSpreadFor(sel)]);
  });

  it('leaves alone: already spread, Flux-owned, no selector', () => {
    expect(spreadPatchFor(dep({ constraints: [hostnameSpreadFor(sel)] }))).toBeNull();
    expect(spreadPatchFor(dep({ flux: true }))).toBeNull();
    expect(spreadPatchFor(dep({ selector: {} }))).toBeNull();
  });

  it('ensureHostnameSpread patches the template once, and a missing Deployment is not an error', async () => {
    const patch = vi.fn().mockResolvedValue({});
    let live: unknown = dep();
    const k8s = {
      apps: { readNamespacedDeployment: vi.fn(async () => live), patchNamespacedDeployment: patch },
    } as unknown as K8sClients;
    expect(await ensureHostnameSpread(k8s, 'cert-manager', 'cert-manager')).toBe(true);
    expect(patch.mock.calls[0][0]).toEqual({
      namespace: 'cert-manager', name: 'cert-manager',
      body: { spec: { template: { spec: { topologySpreadConstraints: [hostnameSpreadFor(sel)] } } } },
    });
    live = dep({ constraints: [hostnameSpreadFor(sel)] });
    expect(await ensureHostnameSpread(k8s, 'cert-manager', 'cert-manager')).toBe(false);
    const gone = { apps: { readNamespacedDeployment: vi.fn(async () => { throw Object.assign(new Error('nf'), { code: 404 }); }) } } as unknown as K8sClients;
    expect(await ensureHostnameSpread(gone, 'x', 'y')).toBe(false);
  });
});
