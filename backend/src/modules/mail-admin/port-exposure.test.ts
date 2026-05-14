import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * port-exposure unit tests — covers the 2026-05-14 streamline change
 * where the haproxy DaemonSet lifecycle moved out of Flux into
 * platform-api. The mode-flip transition now:
 *   thisNodeOnly → allServerNodes: removeHostPorts → CREATE DS
 *   allServerNodes → thisNodeOnly: DELETE DS → addHostPorts
 *
 * Previously the DS was always present with a dummy nodeSelector and
 * we patched the selector to enable/disable. These tests assert the
 * new create/delete contract.
 */

const mockReadDs = vi.fn();
const mockCreateDs = vi.fn();
const mockDeleteDs = vi.fn();
const mockReadDeployment = vi.fn();
const mockPatchDeployment = vi.fn();

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromCluster() {}
    loadFromFile() {}
    makeApiClient(api: unknown) {
      const name = (api as { name?: string })?.name ?? '';
      if (name === 'AppsV1Api') {
        return {
          readNamespacedDaemonSet: mockReadDs,
          createNamespacedDaemonSet: mockCreateDs,
          deleteNamespacedDaemonSet: mockDeleteDs,
          readNamespacedDeployment: mockReadDeployment,
          patchNamespacedDeployment: mockPatchDeployment,
        };
      }
      return {};
    }
  },
  AppsV1Api: { name: 'AppsV1Api' },
}));

vi.mock('../../shared/k8s-patch.js', () => ({
  JSON_PATCH: { headers: { 'Content-Type': 'application/json-patch+json' } },
}));

// Minimal Database stub — drizzle queries are mocked away.
function buildDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ v: null }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  } as unknown as import('../../db/index.js').Database;
}

function notFoundError() {
  return Object.assign(new Error('not found'), { code: 404 });
}

describe('mail-admin/port-exposure.updateMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default Deployment shape for hostPort patching
    mockReadDeployment.mockResolvedValue({
      spec: { template: { spec: { containers: [{ name: 'stalwart', ports: [
        { containerPort: 25, hostPort: 25, name: 'smtp', protocol: 'TCP' },
        { containerPort: 8080, name: 'mgmt-http', protocol: 'TCP' },
      ] }] } } },
    });
    mockPatchDeployment.mockResolvedValue({});
  });

  it('thisNodeOnly → allServerNodes: removes hostPorts then CREATES the haproxy DS', async () => {
    mockReadDs.mockRejectedValue(notFoundError()); // DS absent at start
    mockCreateDs.mockResolvedValue({});
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
    expect(mockCreateDs).toHaveBeenCalledTimes(1);
    expect(mockDeleteDs).not.toHaveBeenCalled();
    // The create body must be the buildHaproxyDaemonSet() shape.
    const createArg = mockCreateDs.mock.calls[0][0] as { body: { kind: string; metadata: { name: string } } };
    expect(createArg.body.kind).toBe('DaemonSet');
    expect(createArg.body.metadata.name).toBe('stalwart-haproxy');
  });

  it('thisNodeOnly → allServerNodes: does NOT re-create when DS already exists', async () => {
    mockReadDs.mockResolvedValue({ metadata: { name: 'stalwart-haproxy' } });
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'allServerNodes' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockDeleteDs).not.toHaveBeenCalled();
  });

  it('allServerNodes → thisNodeOnly: DELETES the haproxy DS then re-adds hostPorts', async () => {
    mockDeleteDs.mockResolvedValue({});
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await updateMailPortExposure(
      { mode: 'thisNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    );
    expect(mockDeleteDs).toHaveBeenCalledTimes(1);
    expect(mockCreateDs).not.toHaveBeenCalled();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  });

  it('allServerNodes → thisNodeOnly: tolerates DS already absent (404 → idempotent)', async () => {
    mockDeleteDs.mockRejectedValue(notFoundError());
    const { updateMailPortExposure } = await import('./port-exposure.js');
    await expect(updateMailPortExposure(
      { mode: 'thisNodeOnly' },
      buildDb(),
      { kubeconfigPath: undefined },
    )).resolves.not.toThrow();
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
  });
});

describe('mail-admin/port-exposure.getMailPortExposure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports daemonSetStatus when DS is present', async () => {
    mockReadDs.mockResolvedValue({
      status: { numberReady: 3, desiredNumberScheduled: 3 },
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'allServerNodes' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('allServerNodes');
    expect(r.proxyProtocolActive).toBe(true);
    expect(r.daemonSetStatus).toEqual({ ready: 3, desired: 3 });
  });

  it('reports daemonSetStatus=null when DS is absent (thisNodeOnly mode)', async () => {
    mockReadDs.mockRejectedValue(notFoundError());
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ v: 'thisNodeOnly' }]),
        })),
      })),
    } as unknown as import('../../db/index.js').Database;
    const { getMailPortExposure } = await import('./port-exposure.js');
    const r = await getMailPortExposure(db, { kubeconfigPath: undefined });
    expect(r.mode).toBe('thisNodeOnly');
    expect(r.proxyProtocolActive).toBe(false);
    expect(r.daemonSetStatus).toBeNull();
  });
});
