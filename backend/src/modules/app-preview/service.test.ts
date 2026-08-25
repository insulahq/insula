import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { resolvePreviewTargets } from './service.js';

/** Sequenced select-chain mock: each awaited query resolves the next row set. */
function fakeDb(rowSets: unknown[][]): Database {
  let call = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) =>
    Promise.resolve(rowSets[call++] ?? []).then(resolve);
  return { select: vi.fn(() => chain) } as unknown as Database;
}

const TENANT = [{ ns: 'tenant-abc123' }];

describe('resolvePreviewTargets', () => {
  it('404s on a missing deployment', async () => {
    await expect(resolvePreviewTargets(fakeDb([[]]), 't1', 'd1')).rejects.toMatchObject({
      code: 'DEPLOYMENT_NOT_FOUND',
    });
  });

  it('409s when the deployment is stopped', async () => {
    const db = fakeDb([[{ id: 'd1', name: 'blog', status: 'stopped', source: 'catalog', catalogEntryId: 'e1', customSpec: null }]]);
    await expect(resolvePreviewTargets(db, 't1', 'd1')).rejects.toMatchObject({
      code: 'PREVIEW_NOT_RUNNING',
    });
  });

  it('catalog single-component: service named after the deployment, ingress port primary', async () => {
    const db = fakeDb([
      [{ id: 'd1', name: 'blog', status: 'running', source: 'catalog', catalogEntryId: 'e1', customSpec: null }],
      TENANT,
      [{
        type: 'app',
        components: [{ name: 'web', ports: [{ port: 8080, ingress: true }, { port: 9000 }] }],
        networking: null,
      }],
    ]);
    const r = await resolvePreviewTargets(db, 't1', 'd1');
    expect(r.namespace).toBe('tenant-abc123');
    expect(r.targets).toEqual([
      { serviceName: 'blog', port: 8080, memberName: 'web', portName: null, primary: true },
      { serviceName: 'blog', port: 9000, memberName: 'web', portName: null, primary: false },
    ]);
  });

  it('catalog multi-component: per-component service names; cronjobs skipped', async () => {
    const db = fakeDb([
      [{ id: 'd1', name: 'shop', status: 'running', source: 'catalog', catalogEntryId: 'e1', customSpec: null }],
      TENANT,
      [{
        type: 'app',
        components: [
          { name: 'web', ports: [{ port: 80, ingress: true }] },
          { name: 'worker', type: 'cronjob', ports: [{ port: 9999 }] },
          { name: 'search', ports: [{ port: 7700 }] },
        ],
        networking: null,
      }],
    ]);
    const r = await resolvePreviewTargets(db, 't1', 'd1');
    expect(r.targets.map((t) => t.serviceName)).toEqual(['shop-web', 'shop-search']);
    expect(r.targets[0].primary).toBe(true);
  });

  it('catalog database entry (not ingressable): ports still previewable, first marked primary', async () => {
    const db = fakeDb([
      [{ id: 'd1', name: 'pg', status: 'running', source: 'catalog', catalogEntryId: 'e1', customSpec: null }],
      TENANT,
      [{ type: 'database', components: [{ name: 'db', ports: [{ port: 5432 }] }], networking: null }],
    ]);
    const r = await resolvePreviewTargets(db, 't1', 'd1');
    expect(r.targets).toEqual([
      { serviceName: 'pg', port: 5432, memberName: 'db', portName: null, primary: true },
    ]);
  });

  it('custom deployment: per-port service objects; ingressEligible port primary; UDP + unexposed skipped', async () => {
    const spec = {
      services: {
        app: {
          ports: [
            { name: 'http', containerPort: 8080, ingressEligible: true },
            { name: 'metrics', containerPort: 9100 },
            { name: 'syslog', containerPort: 514, protocol: 'UDP' },
            { name: 'internal', containerPort: 6000, exposeAsService: false },
          ],
        },
      },
    };
    const db = fakeDb([
      [{ id: 'd1', name: 'myapp', status: 'running', source: 'custom', catalogEntryId: null, customSpec: spec }],
      TENANT,
    ]);
    const r = await resolvePreviewTargets(db, 't1', 'd1');
    expect(r.targets).toEqual([
      { serviceName: 'myapp-http', port: 8080, memberName: 'app', portName: 'http', primary: true },
      { serviceName: 'myapp-metrics', port: 9100, memberName: 'app', portName: 'metrics', primary: false },
    ]);
  });

  it('custom multi-service: service names include the stack-service segment', async () => {
    const spec = {
      services: {
        web: { ports: [{ name: 'http', containerPort: 80 }] },
        api: { ports: [{ name: 'http', containerPort: 3000 }] },
      },
    };
    const db = fakeDb([
      [{ id: 'd1', name: 'stack', status: 'running', source: 'custom', catalogEntryId: null, customSpec: spec }],
      TENANT,
    ]);
    const r = await resolvePreviewTargets(db, 't1', 'd1');
    expect(r.targets.map((t) => t.serviceName)).toEqual(['stack-web-http', 'stack-api-http']);
    expect(r.targets[0].primary).toBe(true);
  });

  it('409s when nothing is previewable', async () => {
    const db = fakeDb([
      [{ id: 'd1', name: 'x', status: 'running', source: 'custom', catalogEntryId: null, customSpec: { services: {} } }],
      TENANT,
    ]);
    await expect(resolvePreviewTargets(db, 't1', 'd1')).rejects.toMatchObject({
      code: 'PREVIEW_NO_HTTP_PORTS',
    });
  });
});
