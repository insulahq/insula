import { describe, it, expect, vi, beforeEach } from 'vitest';

const forgetMock = vi.fn();
vi.mock('./restic-driver.js', () => ({ runResticForget: (a: unknown) => forgetMock(a) }));

const {
  importUploadPath,
  importIdFromUploadName,
  reapImportUpload,
  forgetImportSnapshots,
  sweepAbandonedImportUploads,
  ABANDONED_UPLOAD_AGE_MS,
} = await import('./import-reaper.js');

type Entry = { name: string; modifiedAt?: string | number | null };

function fakeFm(entries: Entry[] | Error) {
  const removed: Array<{ path: string; permanent: boolean }> = [];
  return {
    removed,
    gw: {
      remove: async (_ns: string, path: string, permanent: boolean) => { removed.push({ path, permanent }); },
      list: async () => { if (entries instanceof Error) throw entries; return entries; },
    },
  };
}

/**
 * db stub returning in-flight bundle ROWS.
 *
 * ★ Rows carry a `bkp-<uuid>` id and an import id only inside the
 * description — exactly as the real schema does. The previous stub returned
 * `{ id: '<importId>' }`, which is a shape the database can never produce, so
 * the test agreed with the bug instead of catching it.
 */
function fakeDb(liveImportIds: string[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(liveImportIds.map((id, i) => ({
          id: `bkp-0000000${i}-0000-0000-0000-000000000000`,
          description: `Imported from an uploaded bundle [import:${id}]`,
        }))),
      }),
    }),
  } as never;
}

const NOW = 1_700_000_000_000;
const OLD = new Date(NOW - ABANDONED_UPLOAD_AGE_MS - 1000).toISOString();
const FRESH = new Date(NOW - 1000).toISOString();

beforeEach(() => forgetMock.mockReset());

describe('importUploadPath / importIdFromUploadName', () => {
  it('round-trips a normal id', () => {
    expect(importUploadPath('imp-1')).toBe('.insula-imports/imp-1.tar.gz');
    expect(importIdFromUploadName('imp-1.tar.gz')).toBe('imp-1');
    expect(importIdFromUploadName('imp-1.tar.gz.enc')).toBe('imp-1');
  });

  it('refuses an id that would escape the upload directory', () => {
    for (const bad of ['../../etc/passwd', 'a/b', '', 'a;id', 'a b', 'a'.repeat(65)]) {
      expect(() => importUploadPath(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('ignores files that are not uploads', () => {
    for (const n of ['notes.txt', 'imp-1.tar.gz.part', '.keep', 'a/b.tar.gz']) {
      expect(importIdFromUploadName(n), n).toBeNull();
    }
  });
});

describe('reapImportUpload', () => {
  it('deletes PERMANENTLY — the bin would keep charging the tenant', () => {
    const { removed, gw } = fakeFm([]);
    return reapImportUpload(gw, 'tenant-x', '.insula-imports/imp-1.tar.gz').then((ok) => {
      expect(ok).toBe(true);
      expect(removed).toEqual([{ path: '/.insula-imports/imp-1.tar.gz', permanent: true }]);
    });
  });

  it('reports failure instead of throwing, so a reap cannot fail a good import', async () => {
    const gw = { remove: async () => { throw new Error('sidecar down'); }, list: async () => [] };
    const warn = vi.fn();
    await expect(reapImportUpload(gw, 'tenant-x', '.insula-imports/imp-1.tar.gz', { warn })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('forgetImportSnapshots', () => {
  const target = { kind: 'hostpath', hostPath: '/srv' } as never;

  it('forgets per repo, because files and mailboxes are different repositories', async () => {
    const byRepo = new Map([
      ['repo-files', ['a'.repeat(64)]],
      ['repo-mail', ['b'.repeat(64), 'c'.repeat(64)]],
    ]);
    const r = await forgetImportSnapshots({ target, passwordHex: 'k', byRepo });
    expect(forgetMock).toHaveBeenCalledTimes(2);
    expect(forgetMock.mock.calls.map((c) => (c[0] as { repoUri: string }).repoUri)).toEqual(['repo-files', 'repo-mail']);
    expect(r).toEqual({ forgotten: 3, failed: 0 });
  });

  it('never passes a malformed id to restic argv', async () => {
    const byRepo = new Map([['r', ['not-a-snapshot', 'Z'.repeat(64), 'd'.repeat(64)]]]);
    await forgetImportSnapshots({ target, passwordHex: 'k', byRepo });
    expect((forgetMock.mock.calls[0]![0] as { snapshotIds: string[] }).snapshotIds).toEqual(['d'.repeat(64)]);
  });

  it('makes no call at all for a repo with nothing valid to forget', async () => {
    await forgetImportSnapshots({ target, passwordHex: 'k', byRepo: new Map([['r', ['bad']]]) });
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('keeps tearing down when a forget fails', async () => {
    forgetMock.mockRejectedValueOnce(new Error('repo locked'));
    const warn = vi.fn();
    const r = await forgetImportSnapshots({
      target, passwordHex: 'k', byRepo: new Map([['r', ['e'.repeat(64)]]]), log: { warn },
    });
    expect(r).toEqual({ forgotten: 0, failed: 1 });
    expect(warn).toHaveBeenCalled();
  });
});

describe('sweepAbandonedImportUploads', () => {
  it('deletes an old upload whose import is dead', async () => {
    const { removed, gw } = fakeFm([{ name: 'imp-old.tar.gz', modifiedAt: OLD }]);
    const r = await sweepAbandonedImportUploads({ db: fakeDb([]), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW });
    expect(r.deleted).toBe(1);
    expect(removed[0]!.permanent).toBe(true);
  });

  it('★ keeps an upload whose import is still running', async () => {
    const { removed, gw } = fakeFm([{ name: 'imp-live.tar.gz', modifiedAt: OLD }]);
    const r = await sweepAbandonedImportUploads({
      db: fakeDb(['imp-live']), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW,
    });
    expect(r).toMatchObject({ deleted: 0, skippedLive: 1 });
    expect(removed).toEqual([]);
  });

  it('★ keeps a FRESH upload — it has no bundle row yet because it is still streaming', async () => {
    const { removed, gw } = fakeFm([{ name: 'imp-new.tar.gz', modifiedAt: FRESH }]);
    const r = await sweepAbandonedImportUploads({ db: fakeDb([]), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW });
    expect(r).toMatchObject({ deleted: 0, skippedYoung: 1 });
    expect(removed).toEqual([]);
  });

  it('★ treats an unreadable mtime as YOUNG, never as ancient', async () => {
    // Reading a missing/garbage mtime as 0 would make `now - mtime` enormous
    // and delete a live upload mid-stream.
    for (const mtime of [null, undefined, 'not-a-date', '']) {
      const { removed, gw } = fakeFm([{ name: 'imp-x.tar.gz', modifiedAt: mtime as never }]);
      const r = await sweepAbandonedImportUploads({ db: fakeDb([]), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW });
      expect(r.deleted, String(mtime)).toBe(0);
      expect(removed).toEqual([]);
    }
  });

  it('ignores unrelated files in the directory', async () => {
    const { removed, gw } = fakeFm([{ name: 'README.txt', modifiedAt: OLD }, { name: '.keep', modifiedAt: OLD }]);
    const r = await sweepAbandonedImportUploads({ db: fakeDb([]), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW });
    expect(r.deleted).toBe(0);
    expect(removed).toEqual([]);
  });

  it('★ correlates via the description, because the row id is a DIFFERENT identifier', async () => {
    // backup_jobs.id is `bkp-<uuid>`; the import id is `imp<hex>`. Comparing
    // them directly (as an earlier version did) can never match, so the
    // liveness check silently did not exist and a live upload was deletable.
    const { importIdFromDescription } = await import('./import-reaper.js');
    expect(importIdFromDescription('Imported from uploaded bundle bkp-x [import:imp1]')).toBe('imp1');
    expect(importIdFromDescription('no marker here')).toBeNull();
    expect(importIdFromDescription(null)).toBeNull();
    // a bundle id must never be mistaken for an import id
    expect(importIdFromDescription('bkp-2f1c9a10-0000-0000-0000-000000000000')).toBeNull();
  });

  it('is a no-op when the tenant never imported (no upload directory)', async () => {
    const { gw } = fakeFm(new Error('ENOENT'));
    await expect(sweepAbandonedImportUploads({ db: fakeDb([]), fm: gw, namespace: 'tenant-x', tenantId: 't-1', now: NOW }))
      .resolves.toEqual({ scanned: 0, deleted: 0, skippedLive: 0, skippedYoung: 0 });
  });
});
