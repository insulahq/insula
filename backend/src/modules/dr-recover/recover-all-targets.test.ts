/**
 * `resolveRecoverAllTargets` — what a batch recover will act on, and what it
 * will pass over (ROADMAP R25 §3).
 *
 * The resolver used to drop both classes of non-target with a bare `continue`,
 * so a dry run answered "N targets" and said nothing about the tenants it had
 * skipped. For a fleet migration that is the wrong silence: an omission reads
 * exactly like a tenant that does not exist, and the operator finds out
 * per-tenant, during the migration, one failure at a time.
 *
 * These tests are mostly about the SKIPPED list, because a target that appears
 * is self-evidently there — it is the absence that was unobservable.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolveRecoverAllTargets } from './routes.js';

type Row = Record<string, unknown>;

/**
 * Drizzle-shaped mock that answers by QUERY SHAPE rather than by call order.
 *
 * The order-queued mock used elsewhere in this module would have to be re-queued
 * whenever the resolver's query order changes, which makes the test assert the
 * implementation's sequence instead of its behaviour — and makes a genuine
 * regression look like a fixture problem. Here each `select()` is routed by the
 * columns it asks for.
 */
function makeDb(opts: {
  distinctTenantIds?: string[];
  tenantsById?: Record<string, { name: string | null; ns: string | null }>;
  completedBundleByTenant?: Record<string, { id: string; createdAt: Date; finishedAt: Date | null }>;
  latestBundleByTenant?: Record<string, { status: string; createdAt: Date }>;
  componentsByBundle?: Record<string, string[]>;
}): FastifyInstance['db'] {
  const build = (rows: Row[]) => {
    const b: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'orderBy', 'limit', 'innerJoin']) b[k] = () => b;
    b.then = (resolve: (r: Row[]) => void) => resolve(rows);
    return b;
  };
  let tenantCursor: string | null = null;
  return {
    selectDistinct: () => build((opts.distinctTenantIds ?? []).map((tenantId) => ({ tenantId }))),
    select: (cols?: Record<string, unknown>) => {
      const keys = Object.keys(cols ?? {});
      if (keys.includes('name') && keys.includes('ns')) {
        const t = tenantCursor ? opts.tenantsById?.[tenantCursor] : undefined;
        return build(t ? [{ name: t.name, ns: t.ns }] : []);
      }
      if (keys.includes('component')) {
        const comps = tenantCursor
          ? opts.componentsByBundle?.[opts.completedBundleByTenant?.[tenantCursor]?.id ?? ''] ?? []
          : [];
        return build(comps.map((component) => ({ component })));
      }
      if (keys.includes('status') && keys.includes('createdAt') && !keys.includes('id')) {
        const l = tenantCursor ? opts.latestBundleByTenant?.[tenantCursor] : undefined;
        return build(l ? [{ status: l.status, createdAt: l.createdAt }] : []);
      }
      if (keys.includes('id')) {
        const bdl = tenantCursor ? opts.completedBundleByTenant?.[tenantCursor] : undefined;
        return build(bdl ? [{ id: bdl.id, createdAt: bdl.createdAt, finishedAt: bdl.finishedAt }] : []);
      }
      return build([]);
    },
    // Test hook: the resolver loops tenant-by-tenant, so the fixture needs to
    // know which tenant the current queries belong to.
    __setTenant: (id: string) => { tenantCursor = id; },
  } as unknown as FastifyInstance['db'];
}

/** Run the resolver one tenant at a time so the shape-routed mock stays honest. */
async function resolveOne(
  db: ReturnType<typeof makeDb>,
  tenantId: string,
  scope: 'missing' | 'all',
  namespaces: Set<string>,
  now = new Date('2026-09-13T00:00:00Z'),
) {
  (db as unknown as { __setTenant: (id: string) => void }).__setTenant(tenantId);
  const app = { db } as unknown as FastifyInstance;
  return resolveRecoverAllTargets(app, { tenantIds: [tenantId], scope }, namespaces, now);
}

describe('resolveRecoverAllTargets', () => {
  it('reports a tenant with no completed bundle instead of omitting it', async () => {
    // The failure this whole change is about: the operator NAMED this tenant,
    // and it came back in neither list.
    const db = makeDb({
      tenantsById: { 't-1': { name: 'Acme', ns: 'tenant-acme' } },
      latestBundleByTenant: { 't-1': { status: 'partial', createdAt: new Date('2026-09-11T00:00:00Z') } },
    });
    const { targets, skipped } = await resolveOne(db, 't-1', 'all', new Set());
    expect(targets).toHaveLength(0);
    expect(skipped).toEqual([{
      tenantId: 't-1',
      tenantName: 'Acme',
      reason: 'no_completed_bundle',
      latestBundleStatus: 'partial',
      latestBundleAt: '2026-09-11T00:00:00.000Z',
    }]);
  });

  it('distinguishes "never backed up" from "latest bundle was partial"', async () => {
    // Two very different operator responses; a bare omission made them
    // indistinguishable.
    const db = makeDb({ tenantsById: { 't-2': { name: 'NoBackups', ns: 'tenant-nb' } } });
    const { skipped } = await resolveOne(db, 't-2', 'all', new Set());
    expect(skipped[0]).toMatchObject({ reason: 'no_completed_bundle', latestBundleStatus: null, latestBundleAt: null });
  });

  it('carries bundle age and components on a target', async () => {
    const db = makeDb({
      tenantsById: { 't-3': { name: 'Live', ns: 'tenant-live' } },
      completedBundleByTenant: {
        't-3': { id: 'b-3', createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: new Date('2026-09-03T00:00:00Z') },
      },
      componentsByBundle: { 'b-3': ['config', 'files', 'mailboxes'] },
    });
    const { targets, skipped } = await resolveOne(db, 't-3', 'all', new Set());
    expect(skipped).toHaveLength(0);
    expect(targets[0]).toMatchObject({
      tenantId: 't-3',
      bundleId: 'b-3',
      // finishedAt wins over createdAt — the bundle is as old as when it FINISHED.
      bundleCreatedAt: '2026-09-03T00:00:00.000Z',
      bundleAgeDays: 10,
      components: ['config', 'files', 'mailboxes'],
    });
  });

  it('reports a live tenant as skipped under scope=missing rather than dropping it', async () => {
    // Not a fault — but the totals have to add up against what was asked for.
    const db = makeDb({
      tenantsById: { 't-4': { name: 'Running', ns: 'tenant-running' } },
      completedBundleByTenant: {
        't-4': { id: 'b-4', createdAt: new Date('2026-09-12T00:00:00Z'), finishedAt: null },
      },
      componentsByBundle: { 'b-4': ['config'] },
    });
    const { targets, skipped } = await resolveOne(db, 't-4', 'missing', new Set(['tenant-running']));
    expect(targets).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: 'namespace_present', latestBundleStatus: 'completed' });
  });

  it('still returns a live tenant as a target under scope=all', async () => {
    const db = makeDb({
      tenantsById: { 't-5': { name: 'Running', ns: 'tenant-running' } },
      completedBundleByTenant: {
        't-5': { id: 'b-5', createdAt: new Date('2026-09-12T00:00:00Z'), finishedAt: null },
      },
      componentsByBundle: { 'b-5': ['config'] },
    });
    const { targets, skipped } = await resolveOne(db, 't-5', 'all', new Set(['tenant-running']));
    expect(skipped).toHaveLength(0);
    expect(targets[0]).toMatchObject({ tenantId: 't-5', namespacePresent: true });
  });

  it('falls back to createdAt when the bundle never recorded finishedAt', async () => {
    const db = makeDb({
      tenantsById: { 't-6': { name: null, ns: 'tenant-six' } },
      completedBundleByTenant: {
        't-6': { id: 'b-6', createdAt: new Date('2026-08-14T00:00:00Z'), finishedAt: null },
      },
      componentsByBundle: { 'b-6': [] },
    });
    const { targets } = await resolveOne(db, 't-6', 'all', new Set());
    expect(targets[0]).toMatchObject({ bundleCreatedAt: '2026-08-14T00:00:00.000Z', bundleAgeDays: 30 });
  });

  it('never reports a negative age for a bundle stamped in the future', async () => {
    // Clock skew between nodes is real; a "-2 days old" bundle in the UI reads
    // as a bug in the platform rather than as a clock problem.
    const db = makeDb({
      tenantsById: { 't-7': { name: null, ns: 'tenant-seven' } },
      completedBundleByTenant: {
        't-7': { id: 'b-7', createdAt: new Date('2026-09-15T00:00:00Z'), finishedAt: null },
      },
      componentsByBundle: { 'b-7': [] },
    });
    const { targets } = await resolveOne(db, 't-7', 'all', new Set());
    expect(targets[0].bundleAgeDays).toBe(0);
  });
});
