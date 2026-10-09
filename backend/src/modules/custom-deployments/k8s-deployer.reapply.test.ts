/**
 * Re-applying a custom deployment over objects that already exist — every
 * edit, restart, tag upgrade and DR redeploy goes through this path.
 *
 * It used to strategic-merge the rendered Deployment and Service. Strategic
 * merge combines lists by key and never removes an entry the patch leaves
 * out, so:
 *
 *   - changing a port number kept the old `containerPort` beside the new one
 *     with the same name, and the API server refused the object
 *     (`ports[1].name: Duplicate value: "http"`) — surfaced to the tenant as
 *     "An unexpected error occurred";
 *   - the Service patch failed the same way (merge key `port`);
 *   - removing an env var, volume or pull secret saved fine and changed
 *     nothing on the running pod.
 */
import { describe, it, expect, vi } from 'vitest';
import { deployCustomDeployment, type DeployCustomInput } from './k8s-deployer.js';
import { MERGE_PATCH, STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { ApiError } from '../../shared/errors.js';
import { customDeploymentSpecSchema, type CustomDeploymentSpec } from './schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const DEPLOYMENT_ID = '11111111-1111-4111-8111-111111111111';

function conflict(): Error {
  return Object.assign(new Error('HTTP-Code: 409'), { code: 409 });
}

/** The client-node v1 shape: `body` is the raw Status JSON text. */
function apiException(code: number, status: Record<string, unknown>): Error {
  return Object.assign(new Error(`HTTP-Code: ${code}\nBody: ${JSON.stringify(status)}`), {
    code,
    body: JSON.stringify(status),
  });
}

interface Recorded { body: Record<string, any>; opts: unknown } // eslint-disable-line @typescript-eslint/no-explicit-any

function makeK8s(existingServices: string[] = []) {
  const deploymentPatches: Recorded[] = [];
  const servicePatches: Recorded[] = [];
  const deletedServices: string[] = [];
  const serviceListSelectors: string[] = [];
  const ok = vi.fn(async () => ({}));
  const empty = vi.fn(async () => ({ items: [] }));
  const k8s = {
    apps: {
      createNamespacedDeployment: vi.fn(async () => { throw conflict(); }),
      patchNamespacedDeployment: vi.fn(async (a: { body: Record<string, unknown> }, opts: unknown) => {
        deploymentPatches.push({ body: a.body, opts });
        return {};
      }),
      listNamespacedDeployment: empty,
      deleteNamespacedDeployment: ok,
    },
    core: {
      createNamespacedConfigMap: ok, patchNamespacedConfigMap: ok, listNamespacedConfigMap: empty, deleteNamespacedConfigMap: ok,
      createNamespacedSecret: ok, patchNamespacedSecret: ok, listNamespacedSecret: empty, deleteNamespacedSecret: ok,
      createNamespacedService: vi.fn(async () => { throw conflict(); }),
      patchNamespacedService: vi.fn(async (a: { body: Record<string, unknown> }, opts: unknown) => {
        servicePatches.push({ body: a.body, opts });
        return {};
      }),
      listNamespacedService: vi.fn(async (a: { labelSelector: string }) => {
        serviceListSelectors.push(a.labelSelector);
        return { items: existingServices.map((name) => ({ metadata: { name } })) };
      }),
      deleteNamespacedService: vi.fn(async (a: { name: string }) => { deletedServices.push(a.name); return {}; }),
    },
  } as unknown as K8sClients;
  return { k8s, deploymentPatches, servicePatches, deletedServices, serviceListSelectors };
}

function spec(ports: unknown[], env = [{ name: 'KEEP', value: '1' }]): CustomDeploymentSpec {
  // Through the real schema, so every defaulted field is present exactly as
  // a stored spec has it.
  return customDeploymentSpecSchema.parse({
    specVersion: 1,
    sourceMode: 'simple',
    services: {
      app: {
        image: 'nginx:1.27',
        ports,
        env,
        resources: { cpuRequest: '100m', memoryRequest: '128Mi' },
      },
    },
  });
}

function input(s: CustomDeploymentSpec): DeployCustomInput {
  return {
    diskLimitMb: 1024,
    deploymentId: DEPLOYMENT_ID,
    deploymentName: 'app',
    namespace: 'tenant-acme-1234',
    storageSubPath: 'custom-deployment/app',
    spec: s,
    hasPullCredential: false,
    nodeName: null,
    storageTier: null,
  };
}

const HTTP_8080 = { containerPort: 8080, name: 'http', protocol: 'TCP' as const, exposeAsService: true, ingressEligible: true };

describe('custom deployer: re-apply over an existing Deployment', () => {
  it('replaces the pod spec as a unit, so a changed port is not merged beside the old one', async () => {
    const { k8s, deploymentPatches } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([HTTP_8080])));

    expect(deploymentPatches).toHaveLength(1);
    const { body, opts } = deploymentPatches[0];
    expect(opts).toBe(STRATEGIC_MERGE_PATCH);
    const podSpec = body.spec.template.spec;
    // The directive is what makes the API server drop list entries this
    // render no longer contains (the old containerPort, a removed env var).
    expect(podSpec.$patch).toBe('replace');
    expect(podSpec.containers[0].ports).toEqual([{ containerPort: 8080, name: 'http', protocol: 'TCP' }]);
    expect(podSpec.containers[0].env.map((e: { name: string }) => e.name)).toEqual(['KEEP']);
  });

  it('leaves template metadata merging, so annotations other controllers stamped survive', async () => {
    const { k8s, deploymentPatches } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([HTTP_8080])));
    // Replacing the metadata would drop e.g. the CPU-tier marker and roll
    // the pod for no reason.
    expect(deploymentPatches[0].body.spec.template.metadata.$patch).toBeUndefined();
  });

  it('does not carry the directive into a fresh create', async () => {
    const created: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { k8s } = makeK8s();
    (k8s.apps.createNamespacedDeployment as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(async (a: { body: Record<string, unknown> }) => { created.push(a.body); return {}; });
    (k8s.core.createNamespacedService as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await deployCustomDeployment(k8s, input(spec([HTTP_8080])));
    expect(created[0].spec.template.spec.$patch).toBeUndefined();
  });
});

describe('custom deployer: re-apply over an existing Service', () => {
  it('replaces the port list instead of merging by port number', async () => {
    const { k8s, servicePatches } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([HTTP_8080])));

    expect(servicePatches).toHaveLength(1);
    const { body, opts } = servicePatches[0];
    // RFC 7396: a list in the patch replaces the list on the object.
    expect(opts).toBe(MERGE_PATCH);
    expect(body.spec.ports).toEqual([{ port: 8080, targetPort: 8080, protocol: 'TCP', name: 'http' }]);
  });

  it('keeps the ingress-eligible label in step with the port, clearing it when unticked', async () => {
    const { k8s, servicePatches } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([{ ...HTTP_8080, ingressEligible: false }])));
    expect(servicePatches[0].body.metadata.labels['insula.host/ingress-eligible']).toBeNull();
  });
});

describe('custom deployer: Services a port edit leaves behind', () => {
  it('deletes the Service of a renamed or removed port and keeps the current ones', async () => {
    const web = { ...HTTP_8080, name: 'web' };
    const { k8s, deletedServices } = makeK8s(['app-http', 'app-web']);
    await deployCustomDeployment(k8s, input(spec([web])));
    expect(deletedServices).toEqual(['app-http']);
  });

  it('deletes the Service of a port that is no longer exposed', async () => {
    const { k8s, deletedServices } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([{ ...HTTP_8080, exposeAsService: false }])));
    expect(deletedServices).toEqual(['app-http']);
  });

  it('only looks at Services this deployment owns', async () => {
    const { k8s, serviceListSelectors } = makeK8s(['app-http']);
    await deployCustomDeployment(k8s, input(spec([HTTP_8080])));
    expect(serviceListSelectors).toEqual([
      `insula.host/deployment-id=${DEPLOYMENT_ID},insula.host/owner=custom-deployments`,
    ]);
  });
});

describe('custom deployer: a Kubernetes rejection', () => {
  const duplicate = {
    kind: 'Status',
    status: 'Failure',
    reason: 'Invalid',
    code: 422,
    message: 'Deployment.apps "app" is invalid: spec.template.spec.containers[0].env[0].value: Invalid value: "s3cr3t-token"',
    details: {
      causes: [
        { reason: 'FieldValueDuplicate', message: 'Duplicate value: "http"', field: 'spec.template.spec.containers[0].ports[1].name' },
        { reason: 'FieldValueInvalid', message: 'Invalid value: "s3cr3t-token"', field: 'spec.template.spec.containers[0].env[0].value' },
      ],
    },
  };

  it('names the rejected fields as a 422, instead of an anonymous 500', async () => {
    const { k8s } = makeK8s(['app-http']);
    (k8s.apps.patchNamespacedDeployment as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(apiException(422, duplicate));

    const err = await deployCustomDeployment(k8s, input(spec([HTTP_8080]))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('K8S_SPEC_REJECTED');
    expect(apiErr.status).toBe(422);
    expect(apiErr.message).toContain("Deployment 'app'");
    expect(apiErr.message).toContain('spec.template.spec.containers[0].ports[1].name (duplicate value)');
    expect(apiErr.details).toEqual({
      kind: 'Deployment',
      name: 'app',
      fields: [
        'spec.template.spec.containers[0].ports[1].name',
        'spec.template.spec.containers[0].env[0].value',
      ],
    });
  });

  it('never repeats a value from the request — the API server echoes env values', async () => {
    const { k8s } = makeK8s(['app-http']);
    (k8s.apps.patchNamespacedDeployment as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(apiException(422, duplicate));
    const err = await deployCustomDeployment(k8s, input(spec([HTTP_8080]))).catch((e: unknown) => e) as ApiError;
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain('s3cr3t-token');
  });

  it('reports any other failure as an upstream error with its HTTP status and nothing else', async () => {
    const { k8s } = makeK8s(['app-http']);
    (k8s.core.patchNamespacedService as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(apiException(503, { kind: 'Status', message: 'etcd s3cr3t-token' }));
    const err = await deployCustomDeployment(k8s, input(spec([HTTP_8080]))).catch((e: unknown) => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('K8S_APPLY_FAILED');
    expect(err.status).toBe(502);
    expect(err.message).toBe("Failed to patch Service 'app-http' (Kubernetes API HTTP 503)");
  });

  it('reports a failure with no HTTP status without inventing one', async () => {
    const { k8s } = makeK8s(['app-http']);
    (k8s.apps.patchNamespacedDeployment as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('socket hang up'));
    const err = await deployCustomDeployment(k8s, input(spec([HTTP_8080]))).catch((e: unknown) => e) as ApiError;
    expect(err.code).toBe('K8S_APPLY_FAILED');
    expect(err.message).toBe("Failed to patch Deployment 'app' (no HTTP response from the Kubernetes API)");
  });
});
