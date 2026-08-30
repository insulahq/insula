import { describe, it, expect, vi } from 'vitest';
import { deployCatalogEntry, extraMountSpecs, primaryComponentIndex, assertSafePvcRootPath } from './k8s-deployer.js';
import type { DeployCatalogEntryInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function makeK8sMock() {
  const notFound = Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
  const createDeployment = vi.fn().mockResolvedValue({});
  const k8s = {
    apps: {
      createNamespacedDeployment: createDeployment,
      replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
      readNamespacedDeployment: vi.fn().mockRejectedValue(notFound),
      createNamespacedStatefulSet: vi.fn().mockResolvedValue({}),
    },
    core: {
      createNamespacedService: vi.fn().mockResolvedValue({}),
      replaceNamespacedService: vi.fn().mockResolvedValue({}),
      readNamespacedService: vi.fn().mockRejectedValue(notFound),
      deleteNamespacedService: vi.fn().mockResolvedValue({}),
    },
    batch: {
      createNamespacedCronJob: vi.fn().mockResolvedValue({}),
      replaceNamespacedCronJob: vi.fn().mockResolvedValue({}),
      readNamespacedCronJob: vi.fn().mockRejectedValue(notFound),
      createNamespacedJob: vi.fn().mockResolvedValue({}),
      readNamespacedJob: vi.fn().mockRejectedValue(notFound),
    },
    networking: {
      createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
      replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    },
  } as unknown as K8sClients;
  return { k8s, createDeployment };
}

const WEB = {
  name: 'web', type: 'deployment' as const, image: 'php:8.4',
  ports: [{ port: 8080, protocol: 'TCP', ingress: true }],
};
const DB = { name: 'db', type: 'deployment' as const, image: 'mariadb:11', ports: [] };

function input(overrides: Partial<DeployCatalogEntryInput> = {}): DeployCatalogEntryInput {
  return {
    deploymentName: 'site',
    namespace: 'tenant-acme-1234',
    storagePath: 'runtime/apache-php/site',
    components: [WEB],
    volumes: [{ container_path: '/var/www/html', local_path: '.' }],
    replicaCount: 1,
    cpuRequest: '0.1',
    memoryRequest: '128Mi',
    ...overrides,
  } as DeployCatalogEntryInput;
}

function podSpecOf(createDeployment: ReturnType<typeof vi.fn>, index = 0) {
  const body = createDeployment.mock.calls[index][0].body;
  return body.spec.template.spec;
}

describe('extraMountSpecs', () => {
  it('orders parents before nested children so kubelet does not shadow one', () => {
    const specs = extraMountSpecs([
      { folder: 'deep', mount_path: '/var/www/html/media/raw' },
      { folder: 'shallow', mount_path: '/srv/x' },
    ]);
    expect(specs.map(s => s.container_path)).toEqual(['/srv/x', '/var/www/html/media/raw']);
  });
  it('defaults read_only to false', () => {
    expect(extraMountSpecs([{ folder: 'a', mount_path: '/srv/a' }])[0].read_only).toBe(false);
  });
});

describe('primaryComponentIndex', () => {
  it('picks the ingress component, not merely the first', () => {
    expect(primaryComponentIndex([DB, WEB])).toBe(1);
  });
  it('falls back to the first when nothing publishes ingress', () => {
    expect(primaryComponentIndex([DB, { ...DB, name: 'worker' }])).toBe(0);
  });
});

describe('deployCatalogEntry with tenant extra mounts', () => {
  it('mounts the folder from the PVC ROOT, not under the deployment storagePath', async () => {
    // This is the whole point of the feature: a folder addressed from the PVC
    // root is reachable by a second deployment. Prefixing storagePath would
    // silo it and quietly break sharing.
    const { k8s, createDeployment } = makeK8sMock();
    await deployCatalogEntry(k8s, input({
      extraMounts: [{ folder: 'shared-assets', mount_path: '/var/www/html/media' }],
    }));
    const mounts = podSpecOf(createDeployment).containers[0].volumeMounts;
    expect(mounts).toContainEqual({
      name: 'tenant-storage', mountPath: '/var/www/html/media', subPath: 'shared-assets',
    });
    // the catalog's own mount still resolves under storagePath
    expect(mounts).toContainEqual({
      name: 'tenant-storage', mountPath: '/var/www/html', subPath: 'runtime/apache-php/site',
    });
  });

  it('marks a read-only mount readOnly', async () => {
    const { k8s, createDeployment } = makeK8sMock();
    await deployCatalogEntry(k8s, input({
      extraMounts: [{ folder: 'reference', mount_path: '/srv/reference', read_only: true }],
    }));
    expect(podSpecOf(createDeployment).containers[0].volumeMounts).toContainEqual({
      name: 'tenant-storage', mountPath: '/srv/reference', subPath: 'reference', readOnly: true,
    });
  });

  it('creates the shared folder in the init container', async () => {
    const { k8s, createDeployment } = makeK8sMock();
    await deployCatalogEntry(k8s, input({
      extraMounts: [{ folder: 'shared-assets', mount_path: '/var/www/html/media' }],
    }));
    const init = podSpecOf(createDeployment).initContainers.find(
      (c: { name: string }) => c.name === 'init-dirs',
    );
    expect(init.command[2]).toContain('mkdir -p /data/shared-assets');
    expect(init.command[2]).toContain('chmod 777 /data/shared-assets');
  });

  it('attaches extras to the ingress component only, never the database', async () => {
    const { k8s, createDeployment } = makeK8sMock();
    await deployCatalogEntry(k8s, input({
      components: [DB, WEB],
      extraMounts: [{ folder: 'shared-assets', mount_path: '/var/www/html/media' }],
    }));
    const call = (name: string) => createDeployment.mock.calls.findIndex(
      (c) => c[0].body.metadata.name.includes(name),
    );
    const dbMounts = podSpecOf(createDeployment, call('db')).containers[0].volumeMounts ?? [];
    const webMounts = podSpecOf(createDeployment, call('web')).containers[0].volumeMounts ?? [];
    expect(JSON.stringify(dbMounts)).not.toContain('shared-assets');
    expect(JSON.stringify(webMounts)).toContain('shared-assets');
  });

  it('changes nothing when no extra mounts are configured', async () => {
    const { k8s, createDeployment } = makeK8sMock();
    await deployCatalogEntry(k8s, input());
    expect(podSpecOf(createDeployment).containers[0].volumeMounts).toEqual([
      { name: 'tenant-storage', mountPath: '/var/www/html', subPath: 'runtime/apache-php/site' },
    ]);
  });
});

describe('assertSafePvcRootPath (defence in depth)', () => {
  it('accepts a nested folder', () => {
    expect(assertSafePvcRootPath('media/library/2026')).toBe('media/library/2026');
  });
  it.each([
    '../escape',
    'a/../../etc',
    'foo;rm -rf /',
    'foo bar',
    '$(whoami)',
    '`id`',
    '/absolute',
    'UPPER',
    'a/b/c/d/e',
  ])('refuses %j rather than emitting a pod spec', (bad) => {
    // These cannot reach here through the API (the Zod schema rejects them
    // first) — the point is that the deployer does not depend on that.
    expect(() => assertSafePvcRootPath(bad)).toThrow(/unsafe folder/);
  });
});
