import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suspendCnpgArchiving, resumeCnpgArchiving } from './wal-suspend.js';

// Mock readClusterCR so tests don't dial the cluster.
const readClusterCRMock = vi.fn();
vi.mock('./wal-archive.js', () => ({
  readClusterCR: (...args: unknown[]) => readClusterCRMock(...args),
}));

const BARMAN = 'barman-cloud.cloudnative-pg.io';

function makeK8s() {
  const patch = vi.fn().mockResolvedValue({});
  return {
    k8s: { custom: { patchNamespacedCustomObject: patch } } as unknown as Parameters<typeof suspendCnpgArchiving>[0],
    patch,
  };
}

beforeEach(() => {
  readClusterCRMock.mockReset();
});

describe('suspendCnpgArchiving', () => {
  it('returns false + makes no patch when cluster CR is not found', async () => {
    readClusterCRMock.mockResolvedValue(null);
    const { k8s, patch } = makeK8s();
    await expect(suspendCnpgArchiving(k8s, 'platform', 'system-db')).resolves.toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it('returns false + makes no patch when plugin already detached', async () => {
    readClusterCRMock.mockResolvedValue({ spec: { plugins: [{ name: 'some-other-plugin' }] } });
    const { k8s, patch } = makeK8s();
    await expect(suspendCnpgArchiving(k8s, 'platform', 'system-db')).resolves.toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it('patches plugins[] removing only the barman entry, preserving others', async () => {
    readClusterCRMock.mockResolvedValue({
      spec: {
        plugins: [
          { name: 'audit-plugin' },
          { name: BARMAN, isWALArchiver: true, parameters: { barmanObjectName: 'system-db-objectstore' } },
          { name: 'another-plugin' },
        ],
      },
    });
    const { k8s, patch } = makeK8s();
    await expect(suspendCnpgArchiving(k8s, 'platform', 'system-db')).resolves.toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    const call = patch.mock.calls[0][0] as { body: { spec: { plugins: Array<{ name?: string }> } } };
    expect(call.body.spec.plugins).toHaveLength(2);
    expect(call.body.spec.plugins.map((p) => p.name)).toEqual(['audit-plugin', 'another-plugin']);
  });

  it('uses the correct CNPG CRD coordinates', async () => {
    readClusterCRMock.mockResolvedValue({ spec: { plugins: [{ name: BARMAN }] } });
    const { k8s, patch } = makeK8s();
    await suspendCnpgArchiving(k8s, 'mail', 'mail-db');
    const call = patch.mock.calls[0][0] as { group: string; version: string; namespace: string; plural: string; name: string };
    expect(call.group).toBe('postgresql.cnpg.io');
    expect(call.version).toBe('v1');
    expect(call.plural).toBe('clusters');
    expect(call.namespace).toBe('mail');
    expect(call.name).toBe('mail-db');
  });
});

describe('resumeCnpgArchiving', () => {
  it('throws when cluster CR is not found', async () => {
    readClusterCRMock.mockResolvedValue(null);
    const { k8s } = makeK8s();
    await expect(resumeCnpgArchiving(k8s, 'platform', 'system-db')).rejects.toThrow(/not found/);
  });

  it('returns false + makes no patch when plugin already attached', async () => {
    readClusterCRMock.mockResolvedValue({
      spec: { plugins: [{ name: BARMAN, isWALArchiver: true }] },
    });
    const { k8s, patch } = makeK8s();
    await expect(resumeCnpgArchiving(k8s, 'platform', 'system-db')).resolves.toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it('appends barman entry with default ObjectStore name', async () => {
    readClusterCRMock.mockResolvedValue({ spec: { plugins: [{ name: 'audit-plugin' }] } });
    const { k8s, patch } = makeK8s();
    await expect(resumeCnpgArchiving(k8s, 'platform', 'system-db')).resolves.toBe(true);
    const call = patch.mock.calls[0][0] as { body: { spec: { plugins: Array<{ name?: string; parameters?: Record<string, string> }> } } };
    expect(call.body.spec.plugins).toHaveLength(2);
    const barman = call.body.spec.plugins.find((p) => p.name === BARMAN);
    expect(barman).toBeDefined();
    expect(barman?.parameters?.barmanObjectName).toBe('system-db-objectstore');
  });

  it('accepts an explicit objectStoreName override', async () => {
    readClusterCRMock.mockResolvedValue({ spec: { plugins: [] } });
    const { k8s, patch } = makeK8s();
    await resumeCnpgArchiving(k8s, 'platform', 'system-db', { objectStoreName: 'sysdb-recovery-target' });
    const call = patch.mock.calls[0][0] as { body: { spec: { plugins: Array<{ parameters?: Record<string, string> }> } } };
    expect(call.body.spec.plugins[0].parameters?.barmanObjectName).toBe('sysdb-recovery-target');
  });

  it('accepts isWALArchiver=false (scheduled-backups-only mode)', async () => {
    readClusterCRMock.mockResolvedValue({ spec: { plugins: [] } });
    const { k8s, patch } = makeK8s();
    await resumeCnpgArchiving(k8s, 'platform', 'system-db', { isWALArchiver: false });
    const call = patch.mock.calls[0][0] as { body: { spec: { plugins: Array<{ isWALArchiver?: boolean }> } } };
    expect(call.body.spec.plugins[0].isWALArchiver).toBe(false);
  });
});
