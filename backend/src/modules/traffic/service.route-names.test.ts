/**
 * Route-scope frames name each series from the live IngressRoute it came
 * from — and only the NAME changes: the key is what the panel sends back as
 * `subject`, so it must stay the raw Traefik service label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { traefikServiceLabel, indexLiveRoutes, type LiveRoute } from './traefik-routes.js';

let labels: string[] = [];
vi.mock('../monitoring/vm-client.js', () => ({
  queryRange: () => Promise.resolve(labels.map((service, i) => ({
    labels: { service },
    points: [[Math.floor(Date.now() / 1000) - 300, i + 1], [Math.floor(Date.now() / 1000), i + 1]],
  }))),
  queryInstant: () => Promise.resolve([]),
}));

const { fetchTrafficFrame, fetchTrafficSubjects } = await import('./service.js');

const NS = 'tenant-example-0a1b2c3d';
const live = (match: string, backendService: string, objectName = `${NS}-ingress`, entryPoints = ['websecure']): LiveRoute => ({
  namespace: NS, objectName, entryPoints, match, backendService,
});
const WWW = live('Host(`www.example.test`)', 'website');
const SHOP = live('Host(`example.test`) && PathPrefix(`/shop`)', 'shop');
const WWW_HTTP = live('Host(`www.example.test`)', 'website', `${NS}-ingress-http`, ['web']);
const PLATFORM: LiveRoute = {
  namespace: 'platform', objectName: 'platform-ingress', entryPoints: ['websecure'],
  match: 'Host(`admin.example.test`)', backendService: 'admin-panel',
};
const label = (r: LiveRoute): string => traefikServiceLabel(r.namespace, r.objectName, r.match);
const SOLVER = `${NS}-cm-acme-http-solver-x7k2q-8089@kubernetes`;
const STALE = `${NS}-${NS}-ingress-0123456789abcdef0123@kubernetescrd`;

let rowsQueryFails = false;
function makeDb(): unknown {
  let pending: unknown = [];
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where']) c[m] = () => chain();
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      (pending instanceof Error ? reject(pending) : resolve(pending));
    return c;
  };
  return {
    select: (cols?: Record<string, unknown>) => {
      const keys = Object.keys(cols ?? {}).sort().join(',');
      if (keys === 'nested') pending = [];
      else if (keys === 'name,ns') pending = [{ ns: NS, name: 'Acme Ltd' }];
      else if (keys === 'host,ns') pending = [{ ns: NS, host: 'www.example.test' }, { ns: NS, host: 'example.test' }];
      else if (keys.includes('hostname')) {
        pending = rowsQueryFails ? new Error('db down') : [
          { ns: NS, hostname: 'www.example.test', path: '/', wwwRedirect: 'none', deploymentName: 'website', workerName: null },
          { ns: NS, hostname: 'example.test', path: '/shop', wwwRedirect: 'none', deploymentName: 'shop', workerName: null },
        ];
      } else pending = [];
      return chain();
    },
  };
}

const range = { from: new Date(Date.now() - 3_600_000), to: new Date() };
const liveRoutes = () => Promise.resolve(indexLiveRoutes([WWW, SHOP, WWW_HTTP, PLATFORM]));
// `noFold`: six series would otherwise fold the smallest into `Other`.
const routeFrame = (deps: Record<string, unknown>, extra: Record<string, unknown> = {}) => fetchTrafficFrame({
  ...range, scope: 'route', metric: 'traffic', direction: 'out', backups: 'included', ...extra,
}, { db: makeDb() as never, ...deps }, { noFold: true });
const namesByKey = (series: ReadonlyArray<{ key: string; name: string }>) =>
  Object.fromEntries(series.map((s) => [s.key, s.name]));

beforeEach(() => {
  labels = [label(WWW), label(SHOP), label(WWW_HTTP), SOLVER, STALE, label(PLATFORM)];
  rowsQueryFails = false;
});

describe('route-scope frame naming', () => {
  it('names each series exactly — admin format', async () => {
    const frame = await routeFrame({ liveRoutes });
    const byKey = namesByKey(frame.series);
    expect(byKey[`out:${label(WWW)}`]).toBe('www.example.test → website · Acme Ltd');
    expect(byKey[`out:${label(SHOP)}`]).toBe('example.test/shop → shop · Acme Ltd');
    expect(byKey[`out:${label(WWW_HTTP)}`]).toBe('www.example.test (http → https redirect) · Acme Ltd');
    // Not a tenant's: named from its live rule too, owned by its namespace —
    // on DEV these read `platform #1 … #4`, the admin API's own traffic among them.
    expect(byKey[`out:${label(PLATFORM)}`]).toBe('admin.example.test → admin-panel · platform');
  });

  it('names each series exactly — tenant-panel format', async () => {
    labels = [label(WWW), label(SHOP), label(WWW_HTTP), SOLVER];
    const frame = await routeFrame({ liveRoutes }, { restrictToNamespace: NS });
    expect(namesByKey(frame.series)).toEqual({
      [`out:${label(WWW)}`]: 'www.example.test → website',
      [`out:${label(SHOP)}`]: 'example.test/shop → shop',
      [`out:${label(WWW_HTTP)}`]: 'www.example.test (http → https redirect)',
    });
  });

  it('never changes a key — only names', async () => {
    labels = [label(WWW), label(SHOP), label(WWW_HTTP), label(PLATFORM)];
    const before = await routeFrame({});
    const after = await routeFrame({ liveRoutes });
    expect(after.series.map((s) => s.key)).toEqual(before.series.map((s) => s.key));
    expect(after.series.map((s) => s.key)).toEqual(labels.map((l) => `out:${l}`));
  });

  it('keeps keys and adds the direction to names across both directions', async () => {
    labels = [label(WWW)];
    const frame = await routeFrame({ liveRoutes }, { direction: 'both' });
    expect(namesByKey(frame.series)).toEqual({
      [`out:${label(WWW)}`]: 'www.example.test → website · Acme Ltd · out',
      [`in:${label(WWW)}`]: 'www.example.test → website · Acme Ltd · in',
    });
  });

  it('carries the exact names into the subject picker, with bare subject keys', async () => {
    const subjects = await fetchTrafficSubjects({
      ...range, scope: 'route', metric: 'traffic',
    }, { db: makeDb() as never, liveRoutes });
    const www = subjects.find((s) => s.key === label(WWW));
    expect(www?.name).toBe('www.example.test → website · Acme Ltd');
  });
});

describe('series that are not a route of anyone’s', () => {
  it('hides cert-manager solvers and routes that no longer exist', async () => {
    const frame = await routeFrame({ liveRoutes });
    const keys = frame.series.map((s) => s.key);
    expect(keys).not.toContain(`out:${SOLVER}`);
    expect(keys).not.toContain(`out:${STALE}`);
    expect(keys).toEqual([label(WWW), label(SHOP), label(WWW_HTTP), label(PLATFORM)].map((l) => `out:${l}`));
  });

  it('gives a hidden series no top-N slot and no share of Other', async () => {
    // The stale route is the BIGGEST series here (values rise with position).
    labels = [label(WWW), label(SHOP), label(WWW_HTTP), label(PLATFORM), SOLVER, STALE];
    const frame = await fetchTrafficFrame({
      ...range, scope: 'route', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db: makeDb() as never, liveRoutes });
    expect(frame.series.map((s) => s.key)).toEqual(
      [label(PLATFORM), label(WWW_HTTP), label(SHOP), label(WWW)].map((l) => `out:${l}`),
    );
    expect(frame.othersFolded).toBe(0);
  });

  it('leaves them out of the subject picker too', async () => {
    const subjects = await fetchTrafficSubjects({
      ...range, scope: 'route', metric: 'traffic',
    }, { db: makeDb() as never, liveRoutes });
    const keys = subjects.map((s) => s.key);
    expect(keys).not.toContain(SOLVER);
    expect(keys).not.toContain(STALE);
    expect(keys).toHaveLength(4);
  });

  it('keeps a series it cannot verify when the cluster is unreadable — dropping it would lose real traffic', async () => {
    const frame = await routeFrame({ liveRoutes: () => Promise.reject(new Error('forbidden')), log: { warn: vi.fn() } });
    const keys = frame.series.map((s) => s.key);
    expect(keys).toContain(`out:${STALE}`);
    // A solver is recognisable by its name alone, so it goes either way.
    expect(keys).not.toContain(`out:${SOLVER}`);
  });
});

describe('route naming never fails the request', () => {
  it('falls back to today’s names when the cluster cannot be read, and says so', async () => {
    const warn = vi.fn();
    const frame = await routeFrame({ liveRoutes: () => Promise.reject(new Error('forbidden')), log: { warn } });
    const byKey = namesByKey(frame.series);
    // Multi-host tenant, no live index: tenant · ingress, numbered.
    expect(byKey[`out:${label(WWW)}`]).toMatch(/^Acme Ltd · tenant-example-0a1b2c3d #\d$/);
    expect(Object.values(byKey).some((n) => n.includes('→'))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain('forbidden');
  });

  it('still names from the live rule when the route rows cannot be read', async () => {
    rowsQueryFails = true;
    const warn = vi.fn();
    const frame = await routeFrame({ liveRoutes, log: { warn } });
    const byKey = namesByKey(frame.series);
    // No row → host plus the backend Service the live route points at.
    expect(byKey[`out:${label(WWW)}`]).toBe('www.example.test → website · Acme Ltd');
    expect(byKey[`out:${label(SHOP)}`]).toBe('example.test/shop → shop · Acme Ltd');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not touch the cluster for any other scope', async () => {
    const spy = vi.fn(liveRoutes);
    await fetchTrafficFrame({
      ...range, scope: 'tenant', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db: makeDb() as never, liveRoutes: spy });
    expect(spy).not.toHaveBeenCalled();
  });
});
