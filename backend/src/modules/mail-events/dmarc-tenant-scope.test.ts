/**
 * A tenant may read their OWN DMARC reports and nobody else's.
 *
 * The platform has ingested per-tenant aggregate reports for months and
 * exposed them only to the operator. Opening them to tenants adds a data
 * boundary where there was none, and `policyDomain` arrives from the query
 * string — so the obvious failure is one tenant naming another tenant's
 * domain. The scope lives in the QUERY, which is what these tests hold.
 */
import { describe, it, expect, vi } from 'vitest';
import { dmarcDomainSummaries, dmarcSourcesForDomain } from './dmarc-summary.js';

/** Captures the predicates a query was built with, without a real database. */
function capturingDb() {
  const wheres: unknown[] = [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: (w: unknown) => { wheres.push(w); return chain; },
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
  };
  return { db: { select: () => chain } as never, wheres };
}

/**
 * Does the built predicate tree carry this value anywhere?
 *
 * Walks rather than JSON.stringify-ing: a Drizzle predicate holds live column
 * objects whose `.table` points back at a table holding those same columns, so
 * stringify throws on the cycle. The WeakSet is what makes the walk terminate.
 */
function mentions(tree: unknown, needle: string): boolean {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') return v.includes(needle);
    if (typeof v !== 'object' || v === null) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    return Object.values(v as Record<string, unknown>).some(walk);
  };
  return walk(tree);
}

describe('tenant-scoped DMARC reads', () => {
  it('scopes the domain summary to the tenant that asked', async () => {
    const { db, wheres } = capturingDb();
    await dmarcDomainSummaries(db, { tenantId: 'tenant-alpha' });
    expect(wheres.length).toBeGreaterThan(0);
    expect(mentions(wheres, 'tenant-alpha')).toBe(true);
  });

  it('scopes the per-source breakdown to the tenant, not just the domain', async () => {
    // Without this, a tenant could pass ?domain=<a competitor's domain> and
    // read who sends mail as them — the whole point of the boundary.
    const { db, wheres } = capturingDb();
    await dmarcSourcesForDomain(db, 'someone-elses.test', { tenantId: 'tenant-alpha' });
    expect(mentions(wheres, 'tenant-alpha')).toBe(true);
  });

  it('still supports the UNSCOPED admin read — the positive control', async () => {
    // The operator's fleet-wide view must keep working, or "scoped" would be
    // indistinguishable from "broken for everyone".
    const { db, wheres } = capturingDb();
    await dmarcDomainSummaries(db, {});
    expect(wheres.length).toBeGreaterThan(0);
    expect(mentions(wheres, 'tenant-alpha')).toBe(false);
  });

  it('lowercases the requested domain, so case cannot dodge the filter', async () => {
    const { db, wheres } = capturingDb();
    await dmarcSourcesForDomain(db, 'MiXeD.Example.TEST', { tenantId: 't1' });
    expect(mentions(wheres, 'mixed.example.test')).toBe(true);
    expect(mentions(wheres, 'MiXeD.Example.TEST')).toBe(false);
  });
});
