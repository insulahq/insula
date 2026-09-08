import { describe, it, expect, vi } from 'vitest';
import { deployCatalogEntry, buildMultihostMounts, minimalSiteFolders } from './k8s-deployer.js';
import type { K8sClients } from '../../shared/k8s-client.js';

/**
 * Regression pin for EXISTING deployments.
 *
 * Multi-host adds two mounts and one pod volume, and it must add exactly zero
 * of each when a deployment is not multi-host. Getting that wrong would not
 * throw — it would rewrite the pod template of every runtime deployment on the
 * platform on its next redeploy, which presents as a storage or routing fault
 * rather than as a mount bug.
 */
function fakeK8s() {
  const notFound = Object.assign(new Error('nf'), { statusCode: 404 });
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

const RUNTIME_INPUT = {
  deploymentName: 'site',
  namespace: 'tenant-x',
  storagePath: 'runtime/apache-php/site',
  components: [{
    name: 'apache-php', type: 'deployment' as const, image: 'img:1',
    ports: [{ port: 8080, protocol: 'TCP', ingress: true }],
  }],
  volumes: [{ local_path: '.', container_path: '/var/www/html' }],
  replicaCount: 1,
  cpuRequest: '250m',
  memoryRequest: '256Mi',
};

const podSpecOf = (createDeployment: ReturnType<typeof vi.fn>) =>
  createDeployment.mock.calls[0][0].body.spec.template.spec;

describe('multi-host mounts', () => {
  it('adds NOTHING to a deployment that is not multi-host', async () => {
    const { k8s, createDeployment } = fakeK8s();
    await deployCatalogEntry(k8s, { ...RUNTIME_INPUT, multihost: null });

    const spec = podSpecOf(createDeployment);
    // Exactly the pre-multi-host shape: one mount, one pod volume.
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: 'tenant-storage', mountPath: '/var/www/html', subPath: 'runtime/apache-php/site' },
    ]);
    expect(spec.volumes).toHaveLength(1);
    expect(spec.volumes[0].name).toBe('tenant-storage');
    expect(spec.volumes[0].persistentVolumeClaim.claimName).toBe('tenant-x-storage');
    // The two things multi-host introduces must be absent by name, not merely
    // absent by count — a rename would slip past a length check.
    expect(JSON.stringify(spec)).not.toContain('multihost-sites');
    expect(JSON.stringify(spec)).not.toContain('/var/www/sites');
  });

  it('mounts ONLY the folders it serves — never the volume root', async () => {
    const { k8s, createDeployment } = fakeK8s();
    await deployCatalogEntry(k8s, {
      ...RUNTIME_INPUT,
      multihost: {
        configDir: '/etc/apache2/insula/sites.d',
        sitesRoot: '/var/www/sites',
        configMapName: 'site-vhosts',
        siteFolders: ['shop', 'blog'],
      },
    });

    const spec = podSpecOf(createDeployment);
    expect(spec.containers[0].volumeMounts).toEqual([
      { name: 'tenant-storage', mountPath: '/var/www/html', subPath: 'runtime/apache-php/site' },
      { name: 'multihost-sites', mountPath: '/etc/apache2/insula/sites.d', readOnly: true },
      { name: 'tenant-storage', mountPath: '/var/www/sites/blog', subPath: 'blog' },
      { name: 'tenant-storage', mountPath: '/var/www/sites/shop', subPath: 'shop' },
    ]);

    // THE regression this file exists for. A mount of `/var/www/sites` with no
    // subPath is the tenant PVC root, and it is what let any one site read and
    // write every other site's files and every other deployment's data.
    const siteMounts = spec.containers[0].volumeMounts.filter(
      (m: { mountPath: string }) => m.mountPath.startsWith('/var/www/sites'),
    );
    expect(siteMounts.every((m: { subPath?: string }) => Boolean(m.subPath))).toBe(true);
    expect(siteMounts.some((m: { mountPath: string }) => m.mountPath === '/var/www/sites')).toBe(false);

    expect(spec.volumes).toHaveLength(2);
    expect(spec.volumes.map((v: { name: string }) => v.name).sort()).toEqual(['multihost-sites', 'tenant-storage']);
    const cm = spec.volumes.find((v: { name: string }) => v.name === 'multihost-sites');
    // Optional: the reconciler may not have written the ConfigMap yet on a
    // first deploy, and a required volume would hang the pod in
    // ContainerCreating instead of serving the stock document root.
    expect(cm.configMap).toEqual({ name: 'site-vhosts', optional: true });
  });

  it('mounts nothing from the volume when it serves no sites yet', async () => {
    const { k8s, createDeployment } = fakeK8s();
    await deployCatalogEntry(k8s, {
      ...RUNTIME_INPUT,
      multihost: {
        configDir: '/etc/apache2/insula/sites.d',
        sitesRoot: '/var/www/sites',
        configMapName: 'site-vhosts',
        siteFolders: [],
      },
    });
    const spec = podSpecOf(createDeployment);
    // A freshly created multi-host deployment can serve nothing, and that is
    // the correct failure direction: an empty list must not mean "everything".
    expect(
      spec.containers[0].volumeMounts.filter((m: { mountPath: string }) => m.mountPath.startsWith('/var/www/sites')),
    ).toEqual([]);
  });
});

describe('buildMultihostMounts', () => {
  it('is empty for null/undefined so a caller cannot accidentally opt in', () => {
    expect(buildMultihostMounts(null, 'ns')).toEqual({ mounts: [], volumes: [] });
    expect(buildMultihostMounts(undefined, 'ns')).toEqual({ mounts: [], volumes: [] });
  });

  it('drops a nested app root — its files arrive through the parent mount', () => {
    // Mounting both would nest a volumeMount inside a volumeMount: legal, but
    // order-dependent, and a needless way to make a pod fail to start.
    expect(minimalSiteFolders(['shop', 'shop/public', 'blog'])).toEqual(['blog', 'shop']);
  });

  it('keeps siblings that merely share a name prefix', () => {
    expect(minimalSiteFolders(['app', 'app-secrets'])).toEqual(['app', 'app-secrets']);
  });

  it('de-duplicates repeated roots', () => {
    expect(minimalSiteFolders(['a', 'a', 'a'])).toEqual(['a']);
  });
});
