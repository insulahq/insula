import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leaseBundleFileManager, predumpsNeedCleanup } from './bundle-file-manager.js';

const k8s = {} as never;

describe('predumpsNeedCleanup', () => {
  const dep = (dumps: number, failures: number) => ({
    deploymentId: 'd', deploymentName: 'db', namespace: 'tenant-a', engine: null, durationMs: 1,
    databaseDumps: Array.from({ length: dumps }, (_, i) => ({ database: `db${i}`, pvcPath: '/x', sizeBytes: 1 })),
    databaseFailures: Array.from({ length: failures }, (_, i) => ({ database: `f${i}`, error: 'x', benign: false })),
  });
  const sqlite = (...statuses: Array<'dumped' | 'degraded' | 'failed'>) => ({
    deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite' as const,
    databases: statuses.map((status, i) => ({ name: `/data/${i}.db`, status, sizeBytes: 0 })),
  });

  it('is false for the common tenant — no database, no SQLite file', () => {
    expect(predumpsNeedCleanup([], null)).toBe(false);
    expect(predumpsNeedCleanup([dep(0, 0)], null)).toBe(false);
  });

  it('is true when any database dump was attempted — a failed one can leave a partial file', () => {
    expect(predumpsNeedCleanup([dep(1, 0)], null)).toBe(true);
    expect(predumpsNeedCleanup([dep(0, 1)], null)).toBe(true);
  });

  it('is true only for SQLite dumps that were written', () => {
    expect(predumpsNeedCleanup([], sqlite('degraded', 'failed') as never)).toBe(false);
    expect(predumpsNeedCleanup([], sqlite('degraded', 'dumped') as never)).toBe(true);
  });
});

describe('leaseBundleFileManager', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('holds a bundle lease', async () => {
    const lease = { podName: 'file-manager-x', currentPod: vi.fn(), release: vi.fn() };
    const acquire = vi.fn(async () => lease);
    expect(await leaseBundleFileManager(k8s, 'tenant-a', 'bkp-1', acquire)).toBe(lease);
    expect(acquire).toHaveBeenCalledWith(k8s, 'tenant-a', 'bundle');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and says why when the file manager cannot start', async () => {
    const acquire = vi.fn(async () => { throw new Error('File manager not ready: timeout'); });
    expect(await leaseBundleFileManager(k8s, 'tenant-a', 'bkp-1', acquire)).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toMatch(/bkp-1.*tenant-a.*skipped \(File manager not ready: timeout\)/);
  });
});
