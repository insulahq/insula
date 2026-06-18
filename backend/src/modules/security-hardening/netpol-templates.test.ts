import { describe, it, expect } from 'vitest';
import type { SecurityHardeningClients } from './k8s-client.js';
import {
  listTemplates,
  buildPolicyBody,
  getNetworkPolicyHardeningState,
  applyNetworkPolicyTemplate,
  removeNetworkPolicyHardening,
} from './netpol-templates.js';

function mockClients(opts: {
  namespaces?: Array<{ name: string; optedOut?: boolean }>;
  netpols?: Array<{ namespace: string; managed?: boolean; templateId?: string; egress?: boolean }>;
} = {}) {
  const created: Array<{ namespace: string; body: { metadata?: { annotations?: Record<string, string> } } }> = [];
  const deleted: Array<{ name: string; namespace: string }> = [];
  const clients = {
    core: {
      listNamespace: async () => ({
        items: (opts.namespaces ?? []).map((n) => ({
          metadata: {
            name: n.name,
            labels: { tenant: 'tid', ...(n.optedOut ? { 'insula.host/netpol-hardening': 'optout' } : {}) },
          },
        })),
      }),
    },
    networking: {
      listNetworkPolicyForAllNamespaces: async () => ({
        items: (opts.netpols ?? []).map((p) => ({
          metadata: {
            namespace: p.namespace,
            labels: p.managed ? { 'insula.host/managed-by': 'netpol-hardening' } : {},
            annotations: p.templateId ? { 'insula.host/netpol-template': p.templateId } : {},
          },
          spec: { policyTypes: p.egress ? ['Egress'] : ['Ingress'] },
        })),
      }),
      createNamespacedNetworkPolicy: async (a: { namespace: string; body: unknown }) => { created.push(a as never); },
      deleteNamespacedNetworkPolicy: async (a: { name: string; namespace: string }) => { deleted.push(a); },
    },
  } as unknown as SecurityHardeningClients;
  return { clients, created, deleted };
}

describe('netpol templates', () => {
  it('lists three templates each with a manifest preview', () => {
    const t = listTemplates();
    expect(t.map((x) => x.id).sort()).toEqual(['allow-dns-only', 'deny-all-egress', 'isolate-tenant']);
    for (const x of t) expect(x.manifestPreview).toContain('kind: NetworkPolicy');
  });

  it('builds Egress-only policies — deny-all has no egress rules, dns-only allows :53', () => {
    const deny = buildPolicyBody('deny-all-egress', 'ns') as { spec: { policyTypes: string[]; egress: unknown[] } };
    expect(deny.spec.policyTypes).toEqual(['Egress']);
    expect(deny.spec.egress).toEqual([]);
    const dns = buildPolicyBody('allow-dns-only', 'ns') as { spec: { egress: Array<{ ports?: Array<{ port: number }> }> } };
    expect(dns.spec.egress[0].ports?.map((p) => p.port)).toEqual([53, 53]);
    const iso = buildPolicyBody('isolate-tenant', 'ns') as { spec: { egress: unknown[] } };
    expect(iso.spec.egress).toHaveLength(2); // same-ns + dns
  });
});

describe('getNetworkPolicyHardeningState', () => {
  it('reports tenant count, coverage (managed only), and opted-out namespaces', async () => {
    const { clients } = mockClients({
      namespaces: [{ name: 'tenant-a' }, { name: 'tenant-b', optedOut: true }, { name: 'tenant-c' }],
      netpols: [
        { namespace: 'tenant-a', managed: true, templateId: 'isolate-tenant', egress: true },
        { namespace: 'tenant-c', egress: true }, // custom (non-managed) egress — not coverage
      ],
    });
    const state = await getNetworkPolicyHardeningState(clients);
    expect(state.tenantNamespaceCount).toBe(3);
    expect(state.coverage).toEqual([{ namespace: 'tenant-a', templateId: 'isolate-tenant' }]);
    expect(state.optedOut).toEqual(['tenant-b']);
    expect(state.data).toHaveLength(3);
  });
});

describe('SYSTEM tenant exclusion', () => {
  it('never enumerates / hardens the platform SYSTEM tenant namespace (tenant-system)', async () => {
    const { clients, created } = mockClients({ namespaces: [{ name: 'tenant-system' }, { name: 'tenant-a' }] });
    const state = await getNetworkPolicyHardeningState(clients);
    expect(state.tenantNamespaceCount).toBe(1); // tenant-system excluded
    const dry = await applyNetworkPolicyTemplate(clients, { templateId: 'isolate-tenant', apply: true, excludeNamespaces: [] });
    expect(dry.affectedNamespaces).toEqual(['tenant-a']);
    expect(dry.skipped).not.toContain('tenant-system');
    expect(created.map((c) => c.namespace)).toEqual(['tenant-a']); // never wrote to tenant-system
  });
});

describe('applyNetworkPolicyTemplate', () => {
  it('dry-run lists affected + skipped and writes nothing', async () => {
    const { clients, created, deleted } = mockClients({
      namespaces: [{ name: 'tenant-a' }, { name: 'tenant-b', optedOut: true }],
    });
    const res = await applyNetworkPolicyTemplate(clients, { templateId: 'isolate-tenant', apply: false, excludeNamespaces: [] });
    expect(res.dryRun).toBe(true);
    expect(res.affectedNamespaces).toEqual(['tenant-a']);
    expect(res.skipped).toEqual(['tenant-b']);
    expect(created).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it('apply skips opted-out, excluded, and custom-egress namespaces; writes the rest (delete-then-create)', async () => {
    const { clients, created, deleted } = mockClients({
      namespaces: [
        { name: 'tenant-a' },
        { name: 'tenant-b', optedOut: true },
        { name: 'tenant-c' }, // excluded by request
        { name: 'tenant-d' }, // has custom egress
      ],
      netpols: [{ namespace: 'tenant-d', egress: true }],
    });
    const res = await applyNetworkPolicyTemplate(clients, { templateId: 'deny-all-egress', apply: true, excludeNamespaces: ['tenant-c'] });
    expect(res.dryRun).toBe(false);
    expect(res.affectedNamespaces).toEqual(['tenant-a']);
    expect(res.skipped.sort()).toEqual(['tenant-b', 'tenant-c', 'tenant-d']);
    expect(created.map((c) => c.namespace)).toEqual(['tenant-a']);
    expect(created[0].body.metadata?.annotations?.['insula.host/netpol-template']).toBe('deny-all-egress');
    expect(deleted.map((d) => d.namespace)).toEqual(['tenant-a']); // delete-then-create
  });
});

describe('removeNetworkPolicyHardening', () => {
  it('dry-run lists only namespaces that currently have a managed policy', async () => {
    const { clients, deleted } = mockClients({
      netpols: [
        { namespace: 'tenant-a', managed: true, templateId: 'isolate-tenant', egress: true },
        { namespace: 'tenant-x', egress: true }, // custom — never removed
      ],
    });
    const res = await removeNetworkPolicyHardening(clients, { apply: false, excludeNamespaces: [] });
    expect(res.dryRun).toBe(true);
    expect(res.affectedNamespaces).toEqual(['tenant-a']);
    expect(deleted).toHaveLength(0);
  });

  it('apply deletes the managed policy from covered namespaces only', async () => {
    const { clients, deleted } = mockClients({
      netpols: [
        { namespace: 'tenant-a', managed: true, templateId: 'isolate-tenant', egress: true },
        { namespace: 'tenant-b', managed: true, templateId: 'allow-dns-only', egress: true },
      ],
    });
    const res = await removeNetworkPolicyHardening(clients, { apply: true, excludeNamespaces: ['tenant-b'] });
    expect(res.affectedNamespaces).toEqual(['tenant-a']);
    expect(res.skipped).toEqual(['tenant-b']);
    expect(deleted).toEqual([{ name: 'insula-hardening-egress', namespace: 'tenant-a' }]);
  });
});
