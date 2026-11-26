import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two bundle steps that exec into the tenant's file manager run on a pod
// the bundle holds a lease on (bundle-file-manager.ts) — they never start the
// file manager themselves. Both are best-effort: a failed exec must not fail
// the bundle, and must not be silent either.

const execInPod = vi.fn();
vi.mock('../../../shared/k8s-exec.js', () => ({ execInPod }));

const { runSqliteCapture, removePartialSqliteDumps } = await import('./sqlite-predump.js');
const { deletePredumpsFromPvc } = await import('./database-predump-orchestration.js');

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  execInPod.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('runSqliteCapture', () => {
  it('runs on the held pod', async () => {
    execInPod.mockResolvedValue({ stdout: 'FOUND|/data/app.db|\nOK|/data/app.db|42\nDONE||\n', stderr: '', exitCode: 0 });
    const r = await runSqliteCapture({ namespace: 'tenant-a', fmPod: 'file-manager-x', backupId: 'bkp-1' });
    expect(execInPod.mock.calls[0]!.slice(1, 4)).toEqual(['tenant-a', 'file-manager-x', 'file-manager']);
    expect(r.entry?.databases).toEqual([{ name: '/data/app.db', status: 'dumped', sizeBytes: 42 }]);
    expect(r.interrupted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a failed discovery — never "no SQLite files" — and says why when the dump exec fails', async () => {
    execInPod.mockRejectedValue(new Error('container not found'));
    const r = await runSqliteCapture({ namespace: 'tenant-a', fmPod: 'file-manager-x', backupId: 'bkp-1' });
    expect(r.entry!.databases).toEqual([
      { name: '(SQLite discovery)', status: 'failed', sizeBytes: 0, error: expect.stringMatching(/could not run/) },
    ]);
    // nothing is known about how far it got, so partials are cleaned up
    expect(r.interrupted).toBe(true);
    expect(String(warn.mock.calls[0]![0])).toMatch(/tenant-a\/file-manager-x: container not found/);
  });

  it('passes the exec exit code to the parser: a kill mid-dump marks the rest failed', async () => {
    execInPod.mockResolvedValue({
      stdout: 'FOUND|/data/a.db|\nFOUND|/data/b.db|\nOK|/data/a.db|5\n', stderr: '', exitCode: 137,
    });
    const r = await runSqliteCapture({ namespace: 'tenant-a', fmPod: 'file-manager-x', backupId: 'bkp-1' });
    expect(r.entry!.databases.map((d) => [d.name, d.status])).toEqual([['/data/a.db', 'dumped'], ['/data/b.db', 'failed']]);
    expect(r.entry!.databases[1]!.error).toMatch(/\(exit 137\)$/);
    expect(r.interrupted).toBe(true);
  });
});

describe('removePartialSqliteDumps', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('removes only partial dumps, only from a real dump directory, on the pod it is handed', async () => {
    execInPod.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const ok = await removePartialSqliteDumps({ namespace: 'tenant-a', podFor: async () => 'file-manager-y', backupId: 'bkp-1', sleep: noSleep });
    expect(ok).toBe(true);
    const [, ns, pod, container, cmd] = execInPod.mock.calls[0]!;
    expect([ns, pod, container]).toEqual(['tenant-a', 'file-manager-y', 'file-manager']);
    expect((cmd as string[])[2]).toBe(
      'if [ ! -L "/data/.backup-sqlite-dumps" ] && cd "/data/.backup-sqlite-dumps" 2>/dev/null && [ "$(pwd -P)" = "/data/.backup-sqlite-dumps" ]; then rm -f ./.partial-*; fi',
    );
  });

  it('retries while the killed file manager restarts, asking for the pod each time', async () => {
    const pods = ['fm-1', 'fm-1', 'fm-1'];
    const podFor = vi.fn(async () => pods.shift()!);
    const sleeps: number[] = [];
    execInPod
      .mockRejectedValueOnce(new Error('container not running'))
      .mockResolvedValueOnce({ stdout: '', stderr: 'unable to upgrade connection', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    const ok = await removePartialSqliteDumps({
      namespace: 'tenant-a', podFor, backupId: 'bkp-1', sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(ok).toBe(true);
    expect(podFor).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up after three attempts, says why, and never throws — also when the pod cannot be had', async () => {
    const podFor = vi.fn(async () => { throw new Error('file manager not ready'); });
    const ok = await removePartialSqliteDumps({ namespace: 'tenant-a', podFor, backupId: 'bkp-1', sleep: noSleep });
    expect(ok).toBe(false);
    expect(podFor).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toMatch(/partial sqlite dump cleanup failed in tenant-a: file manager not ready/);
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
