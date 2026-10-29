/**
 * Editing a compose stack replaces it IN PLACE. The editor used to delete the
 * stack and create it again; a refused create then left the tenant with no
 * stack, and even a successful one lost its routes, credential and settings.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../system-settings/service.js', () => ({
  getSettings: async () => ({ customDeploymentsEnabled: true, customDeploymentsAllowCompose: true, customDeploymentsWarnUnpinnedTags: false }),
}));
const pruneMock = vi.fn();
vi.mock('./k8s-deployer.js', () => ({ pruneRemovedStackObjects: (...a: unknown[]) => pruneMock(...a) }));
const reconcileIngressMock = vi.fn();
vi.mock('../domains/k8s-ingress.js', () => ({ reconcileIngress: (...a: unknown[]) => reconcileIngressMock(...a) }));

const { replaceComposeDeploymentWith, carryRowOwnedFields } = await import('./compose-replace.js');
const { parseCompose } = await import('./compose-parser.js');

const yamlFor = (services: string) => `services:\n${services}`;
const WEB = '  web:\n    image: nginx:1.27.5\n    ports:\n      - "80"\n';
const API = '  api:\n    image: nginx:1.27.5\n    ports:\n      - "8080"\n';

function currentSpec(yaml: string) {
  const spec = parseCompose({ composeYaml: yaml }).spec!;
  return { ...spec, allowRoot: true, autoUpdate: true, pullCredentialId: '11111111-1111-4111-8111-111111111111' };
}

function harness(opts: { routes?: Array<{ id: string; hostname: string; servicePort: number | null }>; imageIssues?: unknown[]; status?: string; mode?: 'compose' | 'simple' } = {}) {
  const current = { id: 'd1', name: 'stack', status: opts.status ?? 'running', storagePath: null, customSpec: { ...currentSpec(yamlFor(WEB + API)), sourceMode: opts.mode ?? 'compose' } };
  const writes: unknown[] = [];
  const tx = { update: vi.fn(() => ({ set: vi.fn((v: unknown) => ({ where: vi.fn(async () => { writes.push(v); }) })) })) };
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => opts.routes ?? []) })) })),
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
  };
  const deployed: unknown[] = [];
  const deps = {
    getCustomDeployment: vi.fn(async () => current),
    checkImages: vi.fn(async () => opts.imageIssues ?? []),
    sumResources: () => ({ cpuRequest: '200m', memoryRequest: '256Mi' }),
    loadTenantContext: async () => ({ namespace: 'tenant-ns', nodeName: 'n1', storageTier: 'local' as const }),
    deployToCluster: vi.fn(async (spec: unknown) => { deployed.push(spec); }),
  };
  return { deps, db: db as never, writes, deployed, current };
}

beforeEach(() => { pruneMock.mockReset(); reconcileIngressMock.mockReset(); });

describe('replaceComposeDeploymentWith', () => {
  it('★ refused YAML changes nothing — no write, no deploy, nothing removed', async () => {
    const h = harness();
    const yaml = yamlFor('  web:\n    image: nginx:1.27.5\n    cap_add:\n      - SYS_ADMIN\n');
    await expect(replaceComposeDeploymentWith(h.deps, h.db, {} as never, 't1', 'd1', { compose_yaml: yaml }))
      .rejects.toMatchObject({ code: 'CUSTOM_DEPLOYMENT_INVALID', status: 422 });
    expect(h.writes).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('★ checks images with the stack\'s own id (its stored credential), and a refusal changes nothing', async () => {
    const h = harness({ imageIssues: [{ severity: 'error', code: 'IMAGE_NOT_FOUND', path: 'services.web.image', message: 'access denied' }] });
    await expect(replaceComposeDeploymentWith(h.deps, h.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) }))
      .rejects.toMatchObject({ code: 'CUSTOM_DEPLOYMENT_INVALID' });
    expect(h.deps.checkImages).toHaveBeenCalledWith(expect.anything(), 'd1');
    expect(h.writes).toHaveLength(0);
  });

  it('updates the same row, keeps what the row owns, deploys, and removes the dropped service', async () => {
    const h = harness();
    await replaceComposeDeploymentWith(h.deps, h.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) });
    expect(h.writes).toHaveLength(1);
    const written = (h.writes[0] as { customSpec: Record<string, unknown>; status: string });
    expect(written.status).toBe('deploying');
    expect(Object.keys(written.customSpec.services as object)).toEqual(['web']);
    expect(written.customSpec).toMatchObject({ allowRoot: true, autoUpdate: true, pullCredentialId: '11111111-1111-4111-8111-111111111111' });
    expect(h.deployed).toHaveLength(1);
    expect(pruneMock).toHaveBeenCalledWith({}, 'tenant-ns', 'd1', expect.objectContaining({ services: expect.objectContaining({ web: expect.anything() }) }));
  });

  it('refuses an edit that leaves a route with no port — before writing', async () => {
    const h = harness({ routes: [{ id: 'r1', hostname: 'api.example.test', servicePort: 8080 }] });
    await expect(replaceComposeDeploymentWith(h.deps, h.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) }))
      .rejects.toMatchObject({ code: 'PORT_IN_USE_BY_ROUTE', status: 409 });
    expect(h.writes).toHaveLength(0);
  });

  it('rebuilds the ingress when the stack has routes', async () => {
    const h = harness({ routes: [{ id: 'r1', hostname: 'www.example.test', servicePort: 80 }] });
    await replaceComposeDeploymentWith(h.deps, h.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) });
    expect(reconcileIngressMock).toHaveBeenCalledWith(h.db, {}, 't1', 'tenant-ns');
  });

  it('refuses a single container and a deleted stack', async () => {
    const simple = harness({ mode: 'simple' });
    await expect(replaceComposeDeploymentWith(simple.deps, simple.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) }))
      .rejects.toMatchObject({ code: 'NOT_A_COMPOSE_STACK' });
    const gone = harness({ status: 'deleted' });
    await expect(replaceComposeDeploymentWith(gone.deps, gone.db, {} as never, 't1', 'd1', { compose_yaml: yamlFor(WEB) }))
      .rejects.toMatchObject({ code: 'DEPLOYMENT_DELETED' });
  });
});

describe('carryRowOwnedFields', () => {
  it('takes allowRoot, autoUpdate and the credential from the row, never from the YAML', () => {
    const next = parseCompose({ composeYaml: yamlFor(WEB) }).spec!;
    const merged = carryRowOwnedFields(next, currentSpec(yamlFor(WEB)));
    expect(merged).toMatchObject({ allowRoot: true, autoUpdate: true, pullCredentialId: '11111111-1111-4111-8111-111111111111' });
    expect(carryRowOwnedFields(next, { ...next, allowRoot: false, autoUpdate: false })).not.toHaveProperty('pullCredentialId');
  });
});
