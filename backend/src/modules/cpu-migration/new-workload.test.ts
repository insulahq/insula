/**
 * The tier model leaks on the next deploy unless a NEW workload asks for a
 * share too.
 *
 * A migration re-tiers everything a tenant has; without this the next
 * application arrives at the catalog's quarter-core recommendation, the
 * reserved figure climbs back one deployment at a time, and the namespace
 * quota — sized from what the tenant held at migration — refuses the deploy
 * long before the node is near full.
 */
import { describe, it, expect } from 'vitest';
import { newWorkloadCpuRequest, newWorkloadCpuFor } from './new-workload.js';

describe('newWorkloadCpuRequest', () => {
  it('is the catalog value, unchanged, for a legacy tenant', () => {
    // Their whole namespace is still sized in reservations; changing this
    // would make one workload inconsistent with its siblings and its quota.
    expect(newWorkloadCpuRequest({
      catalogCpu: '0.25', mode: 'legacy', tenantTier: null,
    })).toBe('0.25');
  });

  it('is the TENANT tier for a tiered tenant, whatever the manifest says', () => {
    // The manifest is describing a reservation the platform no longer
    // makes. What CPU a tenant gets is what they are sold.
    expect(newWorkloadCpuRequest({
      catalogCpu: '0.25', mode: 'tiered', tenantTier: 'highest',
    })).toBe('100m');
    expect(newWorkloadCpuRequest({
      catalogCpu: '2', mode: 'tiered', tenantTier: 'normal',
    })).toBe('5m');
  });

  it('gives a custom container the same tenant tier', () => {
    // Nothing a tenant deploys outranks anything else they deploy; they
    // compete through the burst ceiling and the kernel, not the manifest.
    expect(newWorkloadCpuRequest({
      catalogCpu: null, mode: 'tiered', tenantTier: 'normal',
    })).toBe('5m');
  });

  it('ignores the manifest entirely, including one it cannot parse', () => {
    expect(newWorkloadCpuRequest({
      catalogCpu: 'lots', mode: 'tiered', tenantTier: 'high',
    })).toBe('30m');
  });

  it('falls back to high when the tenant tier cannot be resolved', () => {
    expect(newWorkloadCpuRequest({
      catalogCpu: '0.25', mode: 'tiered', tenantTier: null,
    })).toBe('30m');
  });
});

describe('newWorkloadCpuFor — from the raw rows', () => {
  const plan = { cpuLimit: '0.25', cpuTier: 'normal' as const, cpuBurstCores: null };

  it('resolves the tenant tier through the same resolver the runner uses', () => {
    expect(newWorkloadCpuFor(plan, {
      cpuSchedulingMode: 'tiered', cpuLimitOverride: null,
      cpuTierOverride: null, cpuBurstCoresOverride: null,
    }, '2')).toBe('5m'); // the plan's `normal`, not the manifest's 2 cores
  });

  it('lets a tenant override raise the cap', () => {
    expect(newWorkloadCpuFor(plan, {
      cpuSchedulingMode: 'tiered', cpuLimitOverride: null,
      cpuTierOverride: 'highest', cpuBurstCoresOverride: null,
    }, '2')).toBe('100m');
  });

  it('leaves a legacy tenant on the catalog value', () => {
    expect(newWorkloadCpuFor(plan, {
      cpuSchedulingMode: 'legacy', cpuLimitOverride: null,
      cpuTierOverride: null, cpuBurstCoresOverride: null,
    }, '0.25')).toBe('0.25');
  });
});

/**
 * ★ The trap that made an omitted field useless.
 *
 * `createDeploymentSchema` declares `cpu_request` with `.default('0.25')`.
 * The tenant panel stopped sending it for a tiered tenant, expecting the
 * server's `input.cpu_request ?? tierValue` to fall through — but Zod
 * fills the default in during parse, so the key is never absent by the
 * time that line runs, and every new deployment reserved 250m while the
 * panel showed a 5m share. The fix was to normalise the FINAL value; this
 * pins the schema fact that makes a fallback the wrong shape.
 */
describe('createDeploymentSchema.cpu_request', () => {
  it('is FILLED IN by Zod when omitted — so a `??` fallback never fires', async () => {
    const { createDeploymentSchema } = await import('@insula/api-contracts');
    const parsed = createDeploymentSchema.parse({
      catalog_entry_id: '00000000-0000-4000-8000-000000000000',
      name: 'app',
    });
    expect(parsed.cpu_request).toBe('0.25');
  });

  it('and the tier resolver ignores whatever it is handed, which is the fix', () => {
    expect(newWorkloadCpuRequest({
      catalogCpu: '0.25', mode: 'tiered', tenantTier: 'normal',
    })).toBe('5m');
  });
});
