import { describe, it, expect } from 'vitest';
import { buildTenantNetworkPolicies } from './tenant-network-policies.js';

describe('buildTenantNetworkPolicies', () => {
  const ns = 'tenant-acme-1234';
  const policies = buildTenantNetworkPolicies(ns, { podV4: '10.42.0.0/16', svcV4: '10.43.0.0/16' });
  const byName = Object.fromEntries(policies.map((p) => [p.name, p.body]));

  const specOf = (name: string) =>
    (byName[name] as { spec: Record<string, unknown> }).spec;

  it('emits exactly the five expected policies', () => {
    expect(policies.map((p) => p.name).sort()).toEqual([
      'allow-backup-jobs-egress',
      'allow-intra-namespace',
      'allow-platform-api',
      'default-deny-ingress',
      'tenant-egress',
    ]);
  });

  it('allow-backup-jobs-egress lets ONLY backup/restore Jobs reach platform-api:3000 AND the rclone-shim:9000', () => {
    const spec = specOf('allow-backup-jobs-egress');
    expect(spec.policyTypes).toEqual(['Egress']);
    // scoped to the backup/restore component label, not all pods
    expect(spec.podSelector).toEqual({
      matchExpressions: [
        { key: 'platform.io/component', operator: 'In', values: ['backup-files', 'restore-files'] },
      ],
    });
    const egress = spec.egress as Array<{ to: Array<Record<string, unknown>>; ports: Array<{ port: number }> }>;
    // platform-api:3000 (orchestration/metadata)
    const api = egress.find((r) => r.ports[0].port === 3000)!;
    expect(api.to[0]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
      podSelector: { matchLabels: { app: 'platform-api' } },
    });
    // backup-rclone-shim:9000 (the restic S3 data path — the fix for the
    // backup/restore i/o-timeout regression)
    const shim = egress.find((r) => r.ports[0].port === 9000)!;
    expect(shim).toBeDefined();
    expect(shim.to[0]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
      podSelector: { matchLabels: { app: 'backup-rclone-shim' } },
    });
  });

  it('default-deny-ingress allows ONLY the traefik namespace — NO pod-CIDR ipBlock', () => {
    const spec = specOf('default-deny-ingress');
    expect(spec.policyTypes).toEqual(['Ingress']);
    const from = (spec.ingress as Array<{ _from: unknown[] }>)[0]._from;
    // Exactly one peer: the traefik namespaceSelector.
    expect(from).toHaveLength(1);
    expect(from[0]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'traefik' } },
    });
    // Regression guard: the cross-tenant pod-CIDR ipBlock must never come back.
    expect(JSON.stringify(spec)).not.toContain('10.42.0.0/16');
    expect(JSON.stringify(spec)).not.toContain('ipBlock');
  });

  it('allow-platform-api scopes :8111 to the platform-api pod only — NO pod-CIDR ipBlock', () => {
    const spec = specOf('allow-platform-api');
    const rule = (spec.ingress as Array<{ _from: unknown[]; ports: unknown[] }>)[0];
    expect(rule._from).toHaveLength(1);
    expect(rule._from[0]).toEqual({
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
      podSelector: { matchLabels: { app: 'platform-api' } },
    });
    expect(rule.ports).toEqual([{ protocol: 'TCP', port: 8111 }]);
    expect(JSON.stringify(spec)).not.toContain('ipBlock');
  });

  it('tenant-egress is default-deny egress with DNS + intra-ns + internet-minus-internal', () => {
    const spec = specOf('tenant-egress');
    expect(spec.policyTypes).toEqual(['Egress']);
    const egress = spec.egress as Array<Record<string, unknown>>;

    // DNS rule → kube-system :53 udp+tcp
    const dns = egress.find((r) =>
      JSON.stringify(r).includes('kube-system'),
    ) as { ports: Array<{ protocol: string; port: number }> };
    expect(dns).toBeDefined();
    expect(dns.ports).toEqual([
      { protocol: 'UDP', port: 53 },
      { protocol: 'TCP', port: 53 },
    ]);

    // intra-namespace rule
    expect(egress).toContainEqual({ to: [{ podSelector: {} }] });

    // internet rule excepts pod + svc CIDRs + metadata, allows everything else
    const internet = egress.find((r) => {
      const to = (r as { to?: Array<{ ipBlock?: { cidr?: string } }> }).to;
      return to?.[0]?.ipBlock?.cidr === '0.0.0.0/0';
    }) as { to: Array<{ ipBlock: { cidr: string; except: string[] } }> };
    expect(internet).toBeDefined();
    expect(internet.to[0].ipBlock.except).toEqual([
      '10.42.0.0/16',
      '10.43.0.0/16',
      '169.254.169.254/32',
    ]);
  });

  it('honours custom pod/svc CIDRs in the egress except list', () => {
    const custom = buildTenantNetworkPolicies(ns, { podV4: '172.20.0.0/14', svcV4: '172.24.0.0/16' });
    const egress = (custom.find((p) => p.name === 'tenant-egress')!.body as {
      spec: { egress: Array<Record<string, unknown>> };
    }).spec.egress;
    const internet = egress.find((r) => {
      const to = (r as { to?: Array<{ ipBlock?: { cidr?: string } }> }).to;
      return to?.[0]?.ipBlock?.cidr === '0.0.0.0/0';
    }) as { to: Array<{ ipBlock: { except: string[] } }> };
    expect(internet.to[0].ipBlock.except).toContain('172.20.0.0/14');
    expect(internet.to[0].ipBlock.except).toContain('172.24.0.0/16');
  });

  it('emits an IPv6 egress rule only on dual-stack clusters', () => {
    const v4only = buildTenantNetworkPolicies(ns, { podV4: '10.42.0.0/16', svcV4: '10.43.0.0/16' });
    const v4egress = (v4only.find((p) => p.name === 'tenant-egress')!.body as {
      spec: { egress: Array<Record<string, unknown>> };
    }).spec.egress;
    expect(JSON.stringify(v4egress)).not.toContain('::/0');

    const dual = buildTenantNetworkPolicies(ns, {
      podV4: '10.42.0.0/16',
      svcV4: '10.43.0.0/16',
      podV6: 'fd00:42::/56',
      svcV6: 'fd00:43::/112',
    });
    const dualEgress = (dual.find((p) => p.name === 'tenant-egress')!.body as {
      spec: { egress: Array<Record<string, unknown>> };
    }).spec.egress;
    const v6 = dualEgress.find((r) => {
      const to = (r as { to?: Array<{ ipBlock?: { cidr?: string } }> }).to;
      return to?.[0]?.ipBlock?.cidr === '::/0';
    }) as { to: Array<{ ipBlock: { except: string[] } }> };
    expect(v6).toBeDefined();
    expect(v6.to[0].ipBlock.except).toEqual(['fd00:42::/56', 'fd00:43::/112']);
  });
});
