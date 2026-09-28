/**
 * A bring-your-own container gets its tenant's share too (ADR-062 R3).
 *
 * ★ The custom path had no normalisation at all.
 *
 * The catalog path routes every new workload through the tier resolver and
 * the resize endpoint overrides whatever it is sent — but a custom
 * container stored `resources.cpuRequest` verbatim. The simple wizard's
 * default is `100m`, which happens to equal the `highest` tier, so a
 * Normal tenant's container asked for twenty times the share of everything
 * else that tenant runs, while the panel had stopped offering the field
 * and was telling them their plan set it.
 */
import { describe, it, expect } from 'vitest';
import { withTenantCpuTier } from './service.js';
import type { CustomDeploymentSpec } from '@insula/api-contracts';

const spec = (services: Record<string, { cpuRequest: string; memoryRequest: string }>) => ({
  specVersion: 1,
  sourceMode: 'simple',
  services: Object.fromEntries(
    Object.entries(services).map(([n, r]) => [n, { image: 'nginx', resources: r }]),
  ),
  volumes: {},
} as unknown as CustomDeploymentSpec);

describe('withTenantCpuTier', () => {
  it('replaces the wizard default with the tenant tier', () => {
    const out = withTenantCpuTier(spec({ web: { cpuRequest: '100m', memoryRequest: '128Mi' } }), '5m');
    expect(out.services.web.resources.cpuRequest).toBe('5m');
  });

  it('leaves memory exactly as declared', () => {
    // Memory is incompressible and a real allowance; ADR-062 changes
    // nothing about it, and a container that asked for 512Mi needs 512Mi.
    const out = withTenantCpuTier(spec({ web: { cpuRequest: '2', memoryRequest: '512Mi' } }), '30m');
    expect(out.services.web.resources.memoryRequest).toBe('512Mi');
  });

  it('covers every service, not just the first', () => {
    const out = withTenantCpuTier(spec({
      web: { cpuRequest: '100m', memoryRequest: '128Mi' },
      worker: { cpuRequest: '500m', memoryRequest: '256Mi' },
    }), '30m');
    expect(Object.values(out.services).map((s) => s.resources.cpuRequest)).toEqual(['30m', '30m']);
  });

  it('does not mutate the spec it was given', () => {
    const original = spec({ web: { cpuRequest: '100m', memoryRequest: '128Mi' } });
    withTenantCpuTier(original, '5m');
    expect(original.services.web.resources.cpuRequest).toBe('100m');
  });
});
