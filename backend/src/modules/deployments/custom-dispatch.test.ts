import { describe, it, expect, vi, beforeEach } from 'vitest';

// The dispatch module reaches into custom-deployments via dynamic import.
// Mock that module so these tests assert ROUTING — that the generic lifecycle
// hands off to the custom implementation — without dragging in the compose
// parser, PAT store and k8s client graph.
const updateCustomDeployment = vi.fn();
const stopCustomDeployment = vi.fn();
const startCustomDeployment = vi.fn();
const redeployCustomDeploymentRow = vi.fn();
const scaleCustomDeployment = vi.fn();
const deleteCustomDeployment = vi.fn();
const deletePullSecret = vi.fn();

vi.mock('../custom-deployments/service.js', () => ({
  updateCustomDeployment,
  stopCustomDeployment,
  startCustomDeployment,
  redeployCustomDeploymentRow,
}));
vi.mock('../custom-deployments/k8s-deployer.js', () => ({
  scaleCustomDeployment,
  deleteCustomDeployment,
}));
vi.mock('../custom-deployments/pat-store.js', () => ({ deletePullSecret }));

const {
  isCustomDeployment,
  customSpecImages,
  customServiceNames,
  dispatchCustomStop,
  dispatchCustomStart,
  dispatchCustomScale,
  dispatchCustomHardDelete,
  dispatchCustomResources,
} = await import('./custom-dispatch.js');

/** Minimal db stub: only `select().from().where()` is used, for the namespace. */
function dbWithNamespace(namespace: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(namespace ? [{ kubernetesNamespace: namespace }] : []),
      }),
    }),
  } as never;
}

const k8s = {} as never;

const simpleSpec = {
  sourceMode: 'simple',
  services: {
    web: {
      image: 'ghcr.io/example/web:1.0',
      resources: { cpuRequest: '4000m', memoryRequest: '1Gi' },
    },
  },
};

const composeSpec = {
  sourceMode: 'compose',
  services: {
    web: { image: 'ghcr.io/example/web:1.0', resources: { cpuRequest: '500m', memoryRequest: '512Mi' } },
    worker: { image: 'ghcr.io/example/worker:1.0', resources: { cpuRequest: '500m', memoryRequest: '512Mi' } },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isCustomDeployment', () => {
  it('is true only for source=custom', () => {
    expect(isCustomDeployment({ source: 'custom' })).toBe(true);
    expect(isCustomDeployment({ source: 'catalog' })).toBe(false);
    expect(isCustomDeployment({ source: null })).toBe(false);
  });
});

describe('spec readers', () => {
  it('customServiceNames returns declaration order', () => {
    expect(customServiceNames(composeSpec)).toEqual(['web', 'worker']);
  });

  it('customSpecImages dedupes across services', () => {
    expect(customSpecImages(composeSpec)).toEqual([
      'ghcr.io/example/web:1.0',
      'ghcr.io/example/worker:1.0',
    ]);
    expect(customSpecImages({ services: { a: { image: 'x' }, b: { image: 'x' } } })).toEqual(['x']);
  });

  it('tolerates a missing or malformed spec', () => {
    expect(customSpecImages(null)).toEqual([]);
    expect(customSpecImages({})).toEqual([]);
    expect(customServiceNames(undefined)).toEqual([]);
  });
});

describe('dispatchCustomResources', () => {
  const target = { id: 'dep-1', name: 'sitewright', source: 'custom', customSpec: simpleSpec };

  it('rewrites the SPEC, not just the row projection', async () => {
    await dispatchCustomResources(dbWithNamespace('tenant-x'), k8s, 'tenant-1', target, {
      cpu_request: '1000m',
    });

    expect(updateCustomDeployment).toHaveBeenCalledTimes(1);
    const [, , tenantId, id, patch] = updateCustomDeployment.mock.calls[0];
    expect(tenantId).toBe('tenant-1');
    expect(id).toBe('dep-1');
    expect(patch.resources.cpuRequest).toBe('1000m');
  });

  it('carries the unspecified axis forward from the spec instead of defaulting it', async () => {
    // Regression: a schema default of 128Mi here would silently shrink memory
    // from 1Gi on a CPU-only edit.
    await dispatchCustomResources(dbWithNamespace('tenant-x'), k8s, 'tenant-1', target, {
      cpu_request: '1000m',
    });
    expect(updateCustomDeployment.mock.calls[0][4].resources.memoryRequest).toBe('1Gi');
  });

  it('rejects compose stacks rather than half-applying a shared budget', async () => {
    await expect(
      dispatchCustomResources(dbWithNamespace('tenant-x'), k8s, 'tenant-1', {
        id: 'dep-2', name: 'stack', source: 'custom', customSpec: composeSpec,
      }, { cpu_request: '1000m' }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED_FOR_COMPOSE' });
    expect(updateCustomDeployment).not.toHaveBeenCalled();
  });

  it('rejects a spec-less row loudly', async () => {
    await expect(
      dispatchCustomResources(dbWithNamespace('tenant-x'), k8s, 'tenant-1', {
        id: 'dep-3', name: 'broken', source: 'custom', customSpec: null,
      }, { cpu_request: '1000m' }),
    ).rejects.toMatchObject({ code: 'CUSTOM_DEPLOYMENT_CORRUPT' });
  });
});

describe('start / stop / scale', () => {
  it('stop routes to the custom implementation', async () => {
    await dispatchCustomStop(dbWithNamespace('tenant-x'), k8s, 't1', 'dep-1');
    expect(stopCustomDeployment).toHaveBeenCalledWith(expect.anything(), k8s, 't1', 'dep-1');
  });

  it('start routes to the custom implementation', async () => {
    await dispatchCustomStart(dbWithNamespace('tenant-x'), k8s, 't1', 'dep-1');
    expect(startCustomDeployment).toHaveBeenCalledWith(expect.anything(), k8s, 't1', 'dep-1');
  });

  it('scale targets the tenant namespace and the requested replica count', async () => {
    await dispatchCustomScale(dbWithNamespace('tenant-x'), k8s, 't1', 'dep-1', 0);
    expect(scaleCustomDeployment).toHaveBeenCalledWith(k8s, 'tenant-x', 'dep-1', 0);
  });

  it('scale is a no-op when the tenant has no namespace', async () => {
    await dispatchCustomScale(dbWithNamespace(null), k8s, 't1', 'dep-1', 0);
    expect(scaleCustomDeployment).not.toHaveBeenCalled();
  });
});

describe('dispatchCustomHardDelete', () => {
  it('removes the workload objects and the pull secret', async () => {
    await dispatchCustomHardDelete(dbWithNamespace('tenant-x'), k8s, 't1', {
      id: 'dep-1', name: 'sitewright', source: 'custom', customSpec: simpleSpec,
    });
    expect(deleteCustomDeployment).toHaveBeenCalledWith(k8s, 'tenant-x', 'dep-1', 'sitewright');
    expect(deletePullSecret).toHaveBeenCalledWith(k8s, 'tenant-x', 'dep-1');
  });

  it('still deletes the workload when there is no pull secret to remove', async () => {
    deletePullSecret.mockRejectedValueOnce(new Error('not found'));
    await expect(
      dispatchCustomHardDelete(dbWithNamespace('tenant-x'), k8s, 't1', {
        id: 'dep-1', name: 'sitewright', source: 'custom', customSpec: simpleSpec,
      }),
    ).resolves.toBeUndefined();
    expect(deleteCustomDeployment).toHaveBeenCalled();
  });
});
