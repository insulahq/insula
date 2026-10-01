/**
 * The loader around exact route naming: what it reads, what it skips, and
 * that it never throws.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadExactRouteNamer, loadRouteRows } from './route-naming.js';
import { indexLiveRoutes, traefikServiceLabel, type LiveRoute } from './traefik-routes.js';

const NS = 'tenant-example-0a1b2c3d';
const NESTED_NS = `${NS}-eu-9c0d1e2f`;

function fakeDb(rows: unknown[] | Error): { db: never; selects: () => number } {
  let selects = 0;
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) c[m] = () => chain();
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      (rows instanceof Error ? reject(rows) : resolve(rows));
    return c;
  };
  return { db: { select: () => { selects += 1; return chain(); } } as never, selects: () => selects };
}

const WORKER: LiveRoute = {
  namespace: NESTED_NS, objectName: `${NESTED_NS}-ingress`, entryPoints: ['websecure'],
  match: 'Host(`tunnel.example.test`)', backendService: 'pw-anchor',
};
const WORKER_LABEL = traefikServiceLabel(WORKER.namespace, WORKER.objectName, WORKER.match);

describe('loadRouteRows', () => {
  it('names the target by deployment, else by private worker', async () => {
    const { db } = fakeDb([
      { ns: NS, hostname: 'www.example.test', path: '/', wwwRedirect: 'none', deploymentName: 'website', workerName: null },
      { ns: NS, hostname: 'tunnel.example.test', path: '/', wwwRedirect: 'none', deploymentName: null, workerName: 'office-nas' },
      { ns: NS, hostname: 'old.example.test', path: '/', wwwRedirect: 'none', deploymentName: null, workerName: null },
      { ns: null, hostname: 'orphan.example.test', path: '/', wwwRedirect: 'none', deploymentName: 'x', workerName: null },
    ]);
    const rows = await loadRouteRows(db, [NS]);
    expect(rows.map((r) => [r.hostname, r.targetName])).toEqual([
      ['www.example.test', 'website'],
      ['tunnel.example.test', 'office-nas'],
      ['old.example.test', null],
    ]);
  });

  it('does not query for no namespaces', async () => {
    const f = fakeDb([]);
    expect(await loadRouteRows(f.db, [])).toEqual([]);
    expect(f.selects()).toBe(0);
  });
});

describe('loadExactRouteNamer', () => {
  it('reports the namespaces its matches live in, nested and solver ones included', async () => {
    const f = fakeDb([]);
    const namer = await loadExactRouteNamer(
      [WORKER_LABEL, `${NS}-cm-acme-http-solver-x7k2q-8089@kubernetes`, 'platform-a-ingress-0123456789abcdef0123@kubernetescrd'],
      { db: f.db, liveRoutes: () => Promise.resolve(indexLiveRoutes([WORKER])), tenantView: true },
    );
    expect([...namer.namespaces].sort()).toEqual([NS, NESTED_NS].sort());
  });

  it('reads nothing when there is nothing to name', async () => {
    const f = fakeDb([]);
    const liveRoutes = vi.fn(() => Promise.resolve(indexLiveRoutes([WORKER])));
    const namer = await loadExactRouteNamer([], { db: f.db, liveRoutes, tenantView: false });
    expect(liveRoutes).not.toHaveBeenCalled();
    expect(f.selects()).toBe(0);
    expect(namer.namespaces).toEqual([]);
  });

  it('skips the row query when no series matched a live route', async () => {
    const f = fakeDb([]);
    await loadExactRouteNamer(['platform-a-ingress-0123456789abcdef0123@kubernetescrd'], {
      db: f.db, liveRoutes: () => Promise.resolve(new Map()), tenantView: false,
    });
    expect(f.selects()).toBe(0);
  });

  it('never throws — a failed cluster read or row query is a warning', async () => {
    const warn = vi.fn();
    const failingCluster = await loadExactRouteNamer([WORKER_LABEL], {
      db: fakeDb([]).db, liveRoutes: () => Promise.reject(new Error('forbidden')), tenantView: true, log: { warn },
    });
    expect(failingCluster.name(WORKER_LABEL, new Map([[NESTED_NS, 'Acme EU']]))).toBeNull();

    const failingDb = await loadExactRouteNamer([WORKER_LABEL], {
      db: fakeDb(new Error('db down')).db,
      liveRoutes: () => Promise.resolve(indexLiveRoutes([WORKER])),
      tenantView: true,
      log: { warn },
    });
    expect(failingDb.name(WORKER_LABEL, new Map([[NESTED_NS, 'Acme EU']]))).toBe('tunnel.example.test → pw-anchor');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
