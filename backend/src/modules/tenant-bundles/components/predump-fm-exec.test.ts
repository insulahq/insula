import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two bundle steps that exec into the tenant's file manager run on a pod
// the bundle holds a lease on (bundle-file-manager.ts) — they never start the
// file manager themselves. Both are best-effort: a failed exec must not fail
// the bundle, and must not be silent either.

const execInPod = vi.fn();
vi.mock('../../../shared/k8s-exec.js', () => ({ execInPod }));

const { runSqliteCapture } = await import('./sqlite-predump.js');
const { deletePredumpsFromPvc } = await import('./database-predump-orchestration.js');

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  execInPod.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('runSqliteCapture', () => {
  it('runs on the held pod', async () => {
    execInPod.mockResolvedValue({ stdout: 'OK|/data/app.db|42\n', stderr: '', exitCode: 0 });
    const r = await runSqliteCapture({ namespace: 'tenant-a', fmPod: 'file-manager-x', backupId: 'bkp-1' });
    expect(execInPod.mock.calls[0]!.slice(1, 4)).toEqual(['tenant-a', 'file-manager-x', 'file-manager']);
    expect(r?.databases).toEqual([{ name: '/data/app.db', status: 'dumped', sizeBytes: 42 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and says why when the dump exec fails', async () => {
    execInPod.mockRejectedValue(new Error('container not found'));
    expect(await runSqliteCapture({ namespace: 'tenant-a', fmPod: 'file-manager-x', backupId: 'bkp-1' })).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toMatch(/tenant-a\/file-manager-x: container not found/);
  });
});

describe('deletePredumpsFromPvc', () => {
  it('deletes only this bundle\'s predumps, on the held pod', async () => {
    execInPod.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    await deletePredumpsFromPvc({ namespace: 'tenant-a', fmPod: 'file-manager-x', bundleId: 'bkp-1' });
    const [, ns, pod, container, cmd] = execInPod.mock.calls[0]!;
    expect([ns, pod, container]).toEqual(['tenant-a', 'file-manager-x', 'file-manager']);
    expect((cmd as string[])[2]).toContain("-name 'predump-*-bkp-1.*' -delete");
  });

  it('resolves and says why when the delete exec fails', async () => {
    execInPod.mockRejectedValue(new Error('exec refused'));
    await expect(deletePredumpsFromPvc({ namespace: 'tenant-a', fmPod: 'file-manager-x', bundleId: 'bkp-1' })).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).toMatch(/predump cleanup failed in tenant-a\/file-manager-x: exec refused/);
  });
});
