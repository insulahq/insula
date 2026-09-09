import { describe, it, expect, vi } from 'vitest';
import { needsRemediation, remediateMultihostDeployments } from './multihost-remediation.js';
import { MULTIHOST_DISABLED_PHP_FUNCTIONS } from './k8s-deployer.js';

const SITES = '/var/www/sites';
const hardened = { name: 'PHP_DISABLE_FUNCTIONS', value: MULTIHOST_DISABLED_PHP_FUNCTIONS };
const siteMount = { name: 'tenant-storage', mountPath: `${SITES}/shop`, subPath: 'shop' };

describe('detecting a pre-isolation instance', () => {
  it('flags the volume-ROOT mount — the original exposure', () => {
    expect(needsRemediation({ containers: [{
      volumeMounts: [{ name: 'tenant-storage', mountPath: SITES }], env: [hardened],
    }] }, SITES)).toBe(true);
  });

  it('flags a site-serving container with the hardening missing', () => {
    expect(needsRemediation({ containers: [{ volumeMounts: [siteMount], env: [] }] }, SITES)).toBe(true);
  });

  it('flags hardening that was weakened to a subset', () => {
    expect(needsRemediation({ containers: [{
      volumeMounts: [siteMount], env: [{ name: 'PHP_DISABLE_FUNCTIONS', value: 'exec' }],
    }] }, SITES)).toBe(true);
  });

  it('leaves a correctly-isolated instance alone', () => {
    expect(needsRemediation({ containers: [{ volumeMounts: [siteMount], env: [hardened] }] }, SITES)).toBe(false);
  });

  it('does not flag a container that serves no sites', () => {
    // A sidecar has no site mounts, so its lack of hardening means nothing.
    expect(needsRemediation({ containers: [{
      volumeMounts: [{ name: 'tenant-storage', mountPath: '/var/lib/mysql', subPath: 'db' }], env: [],
    }] }, SITES)).toBe(false);
  });

  it('treats an instance serving nothing yet as fine', () => {
    expect(needsRemediation({ containers: [{ volumeMounts: [], env: [] }] }, SITES)).toBe(false);
  });
});

describe('the sweep', () => {
  const CAP = {
    server: 'apache', web_root: '/var/www/html', sites_root: SITES,
    config_dir: '/etc/apache2/insula/sites.d', common_include: '/etc/apache2/insula/site-common.conf',
    listen: 8080, validate: ['a'], reload: ['b'],
  };
  const fakeDb = (rows: unknown[]) => ({
    select: () => ({ from: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => Promise.resolve(rows) }) }) }) }),
  }) as never;

  const row = (name: string, namespace: string | null = 'tenant-acme') => ({
    dep: { id: name, name, tenantId: 't1', multihostEnabled: true, status: 'running' },
    entry: { multihost: CAP },
    namespace,
  });

  it('redeploys only the instances that are actually exposed', async () => {
    const exposed = { spec: { template: { spec: { containers: [{ volumeMounts: [{ name: 'tenant-storage', mountPath: SITES }], env: [hardened] }] } } } };
    const clean = { spec: { template: { spec: { containers: [{ volumeMounts: [siteMount], env: [hardened] }] } } } };
    const k8s = { apps: { readNamespacedDeployment: vi.fn()
      .mockResolvedValueOnce(exposed).mockResolvedValueOnce(clean) } } as never;
    const redeploy = vi.fn().mockResolvedValue({});
    const r = await remediateMultihostDeployments(fakeDb([row('old'), row('new')]), k8s, redeploy);
    expect(r.remediated).toEqual(['old']);
    expect(redeploy).toHaveBeenCalledTimes(1);
  });

  /**
   * A sweep that could not READ an instance must not report it as fine — that
   * is how a run that failed on everything reports a clean result.
   */
  it('reports what it could not inspect instead of counting it as clean', async () => {
    const k8s = { apps: { readNamespacedDeployment: vi.fn().mockRejectedValue(new Error('boom')) } } as never;
    const r = await remediateMultihostDeployments(fakeDb([row('x')]), k8s, vi.fn());
    expect(r.remediated).toEqual([]);
    expect(r.unreadable).toEqual(['x']);
    expect(r.failed).toHaveLength(1);
  });

  it('skips a row whose workload is already gone', async () => {
    const nf = Object.assign(new Error('nf'), { statusCode: 404 });
    const k8s = { apps: { readNamespacedDeployment: vi.fn().mockRejectedValue(nf) } } as never;
    const r = await remediateMultihostDeployments(fakeDb([row('gone')]), k8s, vi.fn());
    expect(r.failed).toEqual([]);
    expect(r.unreadable).toEqual([]);
  });
});

/**
 * The namespace must come from the TENANT ROW. It was composed as
 * `tenant-${tenantId}`, which named a namespace that does not exist — so every
 * lookup 404'd, 404 was treated as "no workload, nothing to do", and the sweep
 * reported every instance already isolated having examined none of them.
 * Verified on DEV by regressing a real deployment to the pre-fix shape and
 * watching the sweep declare it clean.
 */
describe('the sweep looks in the right namespace', () => {
  const CAP = {
    server: 'apache', web_root: '/var/www/html', sites_root: SITES,
    config_dir: '/etc/apache2/insula/sites.d', common_include: '/etc/apache2/insula/site-common.conf',
    listen: 8080, validate: ['a'], reload: ['b'],
  };
  const fakeDb = (rows: unknown[]) => ({
    select: () => ({ from: () => ({ leftJoin: () => ({ leftJoin: () => ({ where: () => Promise.resolve(rows) }) }) }) }),
  }) as never;
  const row = (name: string, namespace: string | null = 'tenant-acme') => ({
    dep: { id: name, name, tenantId: 't1', multihostEnabled: true, status: 'running' },
    entry: { multihost: CAP },
    namespace,
  });

  it('reads the namespace recorded on the tenant', async () => {
    const seen: string[] = [];
    const k8s = { apps: { readNamespacedDeployment: vi.fn(async (a: { namespace: string }) => {
      seen.push(a.namespace);
      return { spec: { template: { spec: { containers: [{ volumeMounts: [siteMount], env: [hardened] }] } } } };
    }) } } as never;
    await remediateMultihostDeployments(fakeDb([row('a', 'tenant-acme')]), k8s, vi.fn());
    expect(seen).toEqual(['tenant-acme']);
    expect(seen[0]).not.toMatch(/^tenant-t1$/);
  });

  it('reports a sweep that examined nothing instead of calling it clean', async () => {
    const nf = Object.assign(new Error('nf'), { statusCode: 404 });
    const k8s = { apps: { readNamespacedDeployment: vi.fn().mockRejectedValue(nf) } } as never;
    const r = await remediateMultihostDeployments(fakeDb([row('a'), row('b')]), k8s, vi.fn());
    expect(r.notFound).toEqual(['a', 'b']);
    expect(r.notFound.length).toBe(r.scanned);
  });

  it('skips a row with no namespace rather than guessing one', async () => {
    const k8s = { apps: { readNamespacedDeployment: vi.fn() } } as never;
    const r = await remediateMultihostDeployments(fakeDb([row('a', null)]), k8s, vi.fn());
    expect(r.unreadable).toEqual(['a']);
    expect(k8s.apps.readNamespacedDeployment).not.toHaveBeenCalled();
  });
});
