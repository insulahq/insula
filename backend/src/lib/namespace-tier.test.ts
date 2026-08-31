import { describe, it, expect } from 'vitest';
import { isTenantNamespace, isSystemNamespace, TENANT_NAMESPACE_PREFIX } from './namespace-tier.js';

describe('namespace-tier', () => {
  it('classifies every platform namespace on production as SYSTEM', () => {
    // The real list from the production cluster, 2026-08-31. The alerting
    // path's old allowlist named only the first nine, so every namespace
    // after them was reported to admins as a *tenant* — which is how an
    // operator was paged that tenant "traefik" was over its memory limit.
    const platform = [
      'platform', 'platform-system', 'platform-tenant-ops', 'mail', 'kube-system',
      'flux-system', 'longhorn-system', 'cert-manager', 'cnpg-system',
      'traefik', 'monitoring', 'crowdsec', 'calico-system', 'tigera-operator',
      'redis-system', 'system-upgrade', 'hosting', 'plesk-migration',
      'kube-public', 'kube-node-lease', 'default',
    ];
    for (const ns of platform) {
      expect(isSystemNamespace(ns), `${ns} must be SYSTEM`).toBe(true);
      expect(isTenantNamespace(ns), `${ns} must not be a tenant`).toBe(false);
    }
  });

  it('classifies real tenant namespaces as tenants', () => {
    // Shapes minted by tenants/service.ts:generateNamespace() and the fixed
    // SYSTEM-tenant namespace from system-tenant/slug.ts.
    for (const ns of ['tenant-acme-1234abcd', 'tenant-system', 'tenant-h-roland-physiotherapy-eac6852d']) {
      expect(isTenantNamespace(ns), `${ns} must be a tenant`).toBe(true);
      expect(isSystemNamespace(ns), `${ns} must not be SYSTEM`).toBe(false);
    }
  });

  it('does not mistake a namespace that merely CONTAINS the prefix', () => {
    // `platform-tenant-ops` contains "tenant-" but is platform-owned. A
    // substring match here would hand platform pods to the tenant tier.
    expect(isTenantNamespace('platform-tenant-ops')).toBe(false);
    expect(isSystemNamespace('platform-tenant-ops')).toBe(true);
  });

  it('treats an absent namespace as platform, never as a tenant', () => {
    // Node-scoped events (SystemOOM) carry no namespace. Defaulting those to
    // "tenant" would attribute a node-level incident to a customer.
    for (const v of [null, undefined, '']) {
      expect(isTenantNamespace(v)).toBe(false);
      expect(isSystemNamespace(v)).toBe(true);
    }
  });

  it('fails CLOSED for an unknown namespace', () => {
    // The whole point of the inversion: something nobody classified raises a
    // platform alert (visible) instead of a tenant alert naming a tenant that
    // does not exist (silent).
    expect(isSystemNamespace('some-future-operator')).toBe(true);
  });

  it('exposes the prefix it classifies on', () => {
    expect(TENANT_NAMESPACE_PREFIX).toBe('tenant-');
  });
});
