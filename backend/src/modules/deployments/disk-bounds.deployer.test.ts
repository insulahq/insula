/**
 * Every pod the catalog deployer renders carries a node-disk bound (R37):
 * each container and init container an `ephemeral-storage` limit and a small
 * explicit request, each disk-backed emptyDir a sizeLimit. Database components
 * get the larger limit. Rendered through the real deployer, captured at the
 * API call — the shape the cluster actually receives.
 */
import { describe, it, expect, vi } from 'vitest';
import { deployCatalogEntry } from './k8s-deployer.js';
import type { DeployCatalogEntryInput, DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function makeK8s() {
  const notFound = Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
  const created: Array<{ kind: string; body: Record<string, unknown> }> = [];
  const capture = (kind: string) => vi.fn(async (a: { body: Record<string, unknown> }) => { created.push({ kind, body: a.body }); return {}; });
  const k8s = {
    apps: {
      createNamespacedDeployment: capture('Deployment'),
      replaceNamespacedDeployment: vi.fn(),
      readNamespacedDeployment: vi.fn().mockRejectedValue(notFound),
    },
    core: {
      createNamespacedService: vi.fn().mockResolvedValue({}),
      replaceNamespacedService: vi.fn(),
      readNamespacedService: vi.fn().mockRejectedValue(notFound),
      deleteNamespacedService: vi.fn(),
    },
    batch: {
      createNamespacedCronJob: capture('CronJob'),
      replaceNamespacedCronJob: vi.fn(),
      createNamespacedJob: capture('Job'),
    },
    networking: { createNamespacedNetworkPolicy: vi.fn(), replaceNamespacedNetworkPolicy: vi.fn() },
  } as unknown as K8sClients;
  return { k8s, created };
}

function podSpecOf(o: { kind: string; body: Record<string, unknown> }): Record<string, unknown> {
  const spec = o.body.spec as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return o.kind === 'CronJob' ? spec.jobTemplate.spec.template.spec : spec.template.spec;
}

type C = { name: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } };

function component(name: string, type: DeployComponentInput['type'], diskClass: DeployComponentInput['diskClass'], extra: Partial<DeployComponentInput> = {}): DeployComponentInput {
  return { name, type, image: `${name}:1`, ports: [], diskClass, ...extra };
}

const WORDPRESS: DeployCatalogEntryInput = {
  diskLimits: { appMb: 2048, databaseMb: 8192 },
  deploymentName: 'blog',
  namespace: 'tenant-acme-1234',
  storagePath: 'applications/wordpress/blog',
  components: [
    component('wordpress', 'deployment', 'app', { ports: [{ port: 80, protocol: 'TCP', ingress: true }], volumes: ['content'] }),
    component('mariadb', 'deployment', 'database', { ports: [{ port: 3306, protocol: 'TCP' }], volumes: ['database'] }),
    component('wp-cron', 'cronjob', 'app', { schedule: '*/15 * * * *', volumes: ['content'] }),
    component('wp-install', 'job', 'app', { volumes: ['content'], resources: { cpu: '100m', memory: '128Mi' } }),
  ],
  volumes: [
    { container_path: '/var/www/html', local_path: 'content' },
    { container_path: '/var/lib/mysql', local_path: 'database' },
  ],
  replicaCount: 1,
  cpuRequest: '500m',
  memoryRequest: '512Mi',
};

describe('catalog deployer: node-disk bounds (R37)', () => {
  it('bounds every container and init container of every object it creates', async () => {
    const { k8s, created } = makeK8s();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deployCatalogEntry(k8s, WORDPRESS);

    expect(created.map((o) => o.kind).sort()).toEqual(['CronJob', 'Deployment', 'Deployment', 'Job']);
    let checked = 0;
    for (const o of created) {
      const spec = podSpecOf(o);
      const all = [...((spec.containers as C[]) ?? []), ...((spec.initContainers as C[]) ?? [])];
      expect(all.length).toBeGreaterThan(0);
      for (const c of all) {
        expect(c.resources?.limits?.['ephemeral-storage'], `${o.kind}/${c.name}`).toMatch(/^\d+Mi$/);
        expect(c.resources?.requests?.['ephemeral-storage'], `${o.kind}/${c.name}`).toBe('64Mi');
        checked++;
      }
      for (const v of (spec.volumes as Array<{ name: string; emptyDir?: { medium?: string; sizeLimit?: string } }>) ?? []) {
        if (v.emptyDir && v.emptyDir.medium !== 'Memory') expect(v.emptyDir.sizeLimit, v.name).toBeDefined();
      }
    }
    // init-dirs rides in front of every pod that mounts the volume.
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('gives the database component the database limit and the rest the app limit', async () => {
    const { k8s, created } = makeK8s();
    await deployCatalogEntry(k8s, WORDPRESS);
    const limitOf = (kind: string, container: string) => {
      const o = created.find((x) => x.kind === kind && ((podSpecOf(x).containers as C[])[0].name === container))!;
      return (podSpecOf(o).containers as C[])[0].resources?.limits?.['ephemeral-storage'];
    };
    expect(limitOf('Deployment', 'mariadb')).toBe('8192Mi');
    expect(limitOf('Deployment', 'wordpress')).toBe('2048Mi');
    expect(limitOf('CronJob', 'wp-cron')).toBe('2048Mi');
    expect(limitOf('Job', 'wp-install')).toBe('2048Mi');
  });

  it('renders the operator\'s current values, not constants', async () => {
    const { k8s, created } = makeK8s();
    await deployCatalogEntry(k8s, { ...WORDPRESS, diskLimits: { appMb: 512, databaseMb: 4096 } });
    const limits = created.flatMap((o) => (podSpecOf(o).containers as C[]).map((c) => c.resources?.limits?.['ephemeral-storage']));
    expect(new Set(limits)).toEqual(new Set(['512Mi', '4096Mi']));
  });

  it('keeps cpu and memory exactly as the QoS rules render them', async () => {
    const { k8s, created } = makeK8s();
    await deployCatalogEntry(k8s, WORDPRESS);
    const job = created.find((o) => o.kind === 'Job')!;
    const r = (podSpecOf(job).containers as C[])[0].resources!;
    expect(r.requests).toMatchObject({ cpu: '100m', memory: '128Mi' });
    expect(r.limits).toMatchObject({ memory: '128Mi' });
    expect(r.limits).not.toHaveProperty('cpu');
  });

  it('bounds the password-reset init container of a reused data directory too', async () => {
    const { k8s, created } = makeK8s();
    await deployCatalogEntry(k8s, {
      ...WORDPRESS,
      components: [component('mariadb', 'deployment', 'database', { ports: [{ port: 3306, protocol: 'TCP' }], volumes: ['database'] })],
      reuseExistingData: true,
      catalogCode: 'mariadb',
      passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
    } as DeployCatalogEntryInput);
    const spec = podSpecOf(created.find((o) => o.kind === 'Deployment')!);
    const inits = (spec.initContainers as C[]) ?? [];
    expect(inits.length).toBeGreaterThanOrEqual(2);
    for (const c of inits) expect(c.resources?.limits?.['ephemeral-storage'], c.name).toBe('8192Mi');
  });
});
