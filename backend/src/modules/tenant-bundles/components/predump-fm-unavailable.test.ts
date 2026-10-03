import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Both pre-capture steps that reach the tenant PVC through the file manager are
// best-effort: a file manager that cannot start must not fail the bundle. It
// must not be SILENT either — a file manager stuck on a node its volume cannot
// attach to was the first visible symptom of a capture that later failed, and
// it left no trace at all.

const getReadyFileManagerPod = vi.fn();
const execInPod = vi.fn();

vi.mock('../../file-manager/service.js', () => ({ getReadyFileManagerPod }));
vi.mock('../../../shared/k8s-exec.js', () => ({ execInPod }));

const { runSqliteCapture } = await import('./sqlite-predump.js');
const { deletePredumpsFromPvc } = await import('./database-predump-orchestration.js');

const k8s = {} as never;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getReadyFileManagerPod.mockReset();
  execInPod.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('runSqliteCapture', () => {
  it('returns null and says why when the file manager is not ready', async () => {
    getReadyFileManagerPod.mockRejectedValue(new Error('File manager not ready: timeout'));
    expect(await runSqliteCapture({ k8s, namespace: 'tenant-a', backupId: 'bkp-1' })).toBeNull();
    expect(execInPod).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/bkp-1.*tenant-a.*file manager not ready \(File manager not ready: timeout\)/);
  });

  it('returns null and says why when the dump exec fails', async () => {
    getReadyFileManagerPod.mockResolvedValue('file-manager-x');
    execInPod.mockRejectedValue(new Error('container not found'));
    expect(await runSqliteCapture({ k8s, namespace: 'tenant-a', backupId: 'bkp-1' })).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toMatch(/tenant-a\/file-manager-x: container not found/);
  });

  it('stays quiet on success', async () => {
    getReadyFileManagerPod.mockResolvedValue('file-manager-x');
    execInPod.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await runSqliteCapture({ k8s, namespace: 'tenant-a', backupId: 'bkp-1' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('deletePredumpsFromPvc', () => {
  it('resolves and says why when the file manager is not ready', async () => {
    getReadyFileManagerPod.mockRejectedValue(new Error('File manager not ready: timeout'));
    await expect(deletePredumpsFromPvc({ k8s, namespace: 'tenant-a', bundleId: 'bkp-1' })).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).toMatch(/bkp-1.*predump cleanup skipped in tenant-a/);
  });

  it('resolves and says why when the delete exec fails', async () => {
    getReadyFileManagerPod.mockResolvedValue('file-manager-x');
    execInPod.mockRejectedValue(new Error('exec refused'));
    await expect(deletePredumpsFromPvc({ k8s, namespace: 'tenant-a', bundleId: 'bkp-1' })).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).toMatch(/predump cleanup failed in tenant-a\/file-manager-x: exec refused/);
  });
});
