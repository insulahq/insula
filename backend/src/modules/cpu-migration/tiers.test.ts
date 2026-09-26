import { describe, it, expect } from 'vitest';
import { CPU_TIER_MILLICORES, CPU_TIER_WEIGHT } from '@insula/api-contracts';
import {
  deriveTier, tierMillis, ceilingCores, blockerFor, tenantUsageBlocker, reclaimFor,
  type DeploymentFacts,
} from './tiers.js';

const facts = (o: Partial<DeploymentFacts> = {}): DeploymentFacts => ({
  source: 'catalog',
  thirdPartyCatalog: false,
  declaresOwnResources: false,
  ...o,
});

describe('tier ladder', () => {
  // The ladder is chosen in cpu.weight space. Measured on a live node,
  // everything at or below ~25m collapses to weight 1 — a ladder of "very
  // small numbers" would be indistinguishable to the kernel, so the tiers
  // would be theatre. These three must land on distinct weights.
  it('maps to distinct kernel weights, which is the entire point', () => {
    expect(CPU_TIER_WEIGHT.normal).toBe(1);
    expect(CPU_TIER_WEIGHT.high).toBe(2);
    expect(CPU_TIER_WEIGHT.highest).toBe(4);
    expect(new Set(Object.values(CPU_TIER_WEIGHT)).size).toBe(3);
  });

  it('keeps the bottom tier inside the weight-1 band and the others above it', () => {
    // <=25m is weight 1; 30m is the first value that reaches weight 2.
    expect(CPU_TIER_MILLICORES.normal).toBeLessThanOrEqual(25);
    expect(CPU_TIER_MILLICORES.high).toBeGreaterThanOrEqual(30);
    expect(CPU_TIER_MILLICORES.highest).toBeGreaterThan(CPU_TIER_MILLICORES.high);
  });
});

describe('deriveTier', () => {
  it.each([
    [0.10, 'normal'],   // static-nginx, redis
    [0.05, 'normal'],
    [0.25, 'high'],     // apache-php, mariadb, nodejs
    [0.50, 'high'],     // apache-php-office
    [0.75, 'highest'],  // wordpress
    [2.00, 'highest'],  // nextcloud, jitsi
  ])('recommended %s cores -> %s', (rec, want) => {
    expect(deriveTier(rec as number)).toBe(want);
  });

  // A manifest with no recommendation must not silently land on the cheapest
  // tier — that would quietly starve an app nobody sized.
  it('defaults to high when the manifest says nothing', () => {
    expect(deriveTier(null)).toBe('high');
    expect(deriveTier(Number.NaN)).toBe('high');
  });
});

describe('ceilingCores', () => {
  // Generous on purpose: today there is NO CPU limit, so a tenant can burst
  // to the whole node. Reinterpreting cpu_limit one-for-one would convert
  // "reserve 1 core, burst freely" into "burst to 1 core" — a silent
  // downgrade delivered to clusters nobody can inspect.
  it.each([
    [0.10, 1],   // starter: the floor, 10x its old reservation
    [1.00, 2],   // premium
    [2.00, 4],   // ultimate
  ])('plan %s cores -> %s core ceiling', (limit, want) => {
    expect(ceilingCores(limit as number)).toBe(want);
  });

  it('never grants less than a whole core', () => {
    expect(ceilingCores(0)).toBe(1);
    expect(ceilingCores(null)).toBe(1);
  });
});

describe('blockerFor', () => {
  it('passes an ordinary catalog deployment', () => {
    expect(blockerFor(facts())).toBeNull();
  });

  it('refuses a custom container that pins its own resources', () => {
    expect(blockerFor(facts({ source: 'custom', declaresOwnResources: true })))
      .toBe('custom_resources');
  });

  it('refuses a manifest from a catalog we did not write', () => {
    expect(blockerFor(facts({ thirdPartyCatalog: true }))).toBe('third_party_catalog');
  });

  // A custom deployment that did NOT pin resources is ordinary work.
  it('allows a custom container that left sizing to the platform', () => {
    expect(blockerFor(facts({ source: 'custom', declaresOwnResources: false }))).toBeNull();
  });

  it('reports the most specific cause when several apply', () => {
    expect(blockerFor(facts({
      source: 'custom', declaresOwnResources: true, thirdPartyCatalog: true,
    }))).toBe('custom_resources');
  });
});

describe('tenantUsageBlocker', () => {
  // ★ This check is TENANT-wide on purpose. An earlier draft asked it per
  // deployment — and usage_metrics.deployment_id is NULL on every one of the
  // 10,582 CPU rows on production, so it would have answered "no usage data"
  // for every tenant on the platform. The ceiling is tenant-wide too, so this
  // is also the only granularity at which the question means anything.
  it('passes a tenant comfortably inside its ceiling', () => {
    // Real production shape: the busiest tenant's p95 is 65m against 2 cores.
    expect(tenantUsageBlocker(65, 2)).toBeNull();
  });

  it('refuses when p95 already exceeds the ceiling', () => {
    expect(tenantUsageBlocker(2500, 2)).toBe('usage_exceeds_ceiling');
  });

  it('accepts p95 exactly at the ceiling', () => {
    expect(tenantUsageBlocker(2000, 2)).toBeNull();
  });

  // Unsampled is not "fits" — that would migrate precisely the tenant nobody
  // has evidence about.
  it('refuses when there is no usage data rather than assuming it fits', () => {
    expect(tenantUsageBlocker(null, 2)).toBe('no_usage_data');
  });

  // p95 near zero is a MEASUREMENT, not a missing one.
  it('treats a measured zero as a pass, not as missing data', () => {
    expect(tenantUsageBlocker(0, 1)).toBeNull();
  });
});

describe('reclaimFor', () => {
  it('is what the re-tier hands back', () => {
    expect(reclaimFor(250, tierMillis('high'))).toBe(220);
  });

  // An under-sized app must not erase the savings of the over-sized ones.
  it('floors at zero when the tier is larger than the current request', () => {
    expect(reclaimFor(5, tierMillis('highest'))).toBe(0);
  });
});
