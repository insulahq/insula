/**
 * Bring-your-own containers write wherever their image writes — the custom
 * deployer cannot know where. So every container and init container it renders
 * carries the node-disk limit (R37), captured at the API call. RAM-backed tmpfs
 * mounts stay as declared: they are charged to the container's memory.
 */
import { describe, it, expect, vi } from 'vitest';
import { deployCustomDeployment } from './k8s-deployer.js';
import { parseCompose } from './compose-parser.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports:
      - "80"
    depends_on:
      - api
    volumes:
      - "html:/usr/share/nginx/html"
    tmpfs:
      - /var/cache/nginx
  api:
    image: ghcr.io/owner/api:v1.2
    ports:
      - "3000"
volumes:
  html: {}
`;

function makeK8s() {
  const deployments: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const empty = vi.fn(async () => ({ items: [] }));
  const ok = vi.fn(async () => ({}));
  const k8s = {
    apps: {
      createNamespacedDeployment: vi.fn(async (a: { body: Record<string, unknown> }) => { deployments.push(a.body); return {}; }),
      patchNamespacedDeployment: ok, listNamespacedDeployment: empty, deleteNamespacedDeployment: ok,
    },
    core: {
      createNamespacedConfigMap: ok, patchNamespacedConfigMap: ok, listNamespacedConfigMap: empty, deleteNamespacedConfigMap: ok,
      createNamespacedSecret: ok, patchNamespacedSecret: ok, listNamespacedSecret: empty, deleteNamespacedSecret: ok,
      createNamespacedService: ok, patchNamespacedService: ok, listNamespacedService: empty, deleteNamespacedService: ok,
    },
  } as unknown as K8sClients;
  return { k8s, deployments };
}

type C = { name: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } };

describe('custom deployer: node-disk bounds (R37)', () => {
  it('bounds every container and init container of every service, and leaves RAM tmpfs alone', async () => {
    const parsed = parseCompose({ composeYaml: COMPOSE });
    expect(parsed.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const { k8s, deployments } = makeK8s();
    await deployCustomDeployment(k8s, {
      diskLimitMb: 1536,
      deploymentId: '11111111-1111-4111-8111-111111111111',
      deploymentName: 'stack',
      namespace: 'tenant-acme-1234',
      storageSubPath: 'custom-deployment/stack',
      spec: parsed.spec!,
      hasPullCredential: false,
      nodeName: null,
      storageTier: null,
    });

    expect(deployments).toHaveLength(2);
    let containers = 0;
    let inits = 0;
    for (const d of deployments) {
      const pod = d.spec.template.spec;
      for (const c of pod.containers as C[]) {
        expect(c.resources?.limits?.['ephemeral-storage'], c.name).toBe('1536Mi');
        expect(c.resources?.requests?.['ephemeral-storage'], c.name).toBe('64Mi');
        containers++;
      }
      for (const c of (pod.initContainers as C[] | undefined) ?? []) {
        expect(c.resources?.limits?.['ephemeral-storage'], c.name).toBe('1536Mi');
        inits++;
      }
      for (const v of (pod.volumes as Array<{ name: string; emptyDir?: { medium?: string; sizeLimit?: string } }>) ?? []) {
        if (v.emptyDir) expect(v.emptyDir.sizeLimit, v.name).toBeDefined();
      }
    }
    expect(containers).toBe(2);
    // web waits for api and prepares its volume folder: both init containers bounded.
    expect(inits).toBeGreaterThanOrEqual(2);

    const web = deployments.find((d) => (d.spec.template.spec.containers as C[])[0].name === 'web')!;
    const tmpfs = (web.spec.template.spec.volumes as Array<{ emptyDir?: { medium?: string; sizeLimit?: string } }>)
      .find((v) => v.emptyDir?.medium === 'Memory');
    expect(tmpfs?.emptyDir?.sizeLimit).toMatch(/Mi$/);
  });
});
