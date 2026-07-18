import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
// Keep the real path helpers (META_FILENAME, componentDir) so addressing is
// exercised; stub parseMeta so we don't need a fully-valid BackupMetaV1 here
// (meta validation has its own coverage).
vi.mock('./meta.js', async (orig) => {
  const actual = await orig<typeof import('./meta.js')>();
  return { ...actual, parseMeta: (s: string) => JSON.parse(s) };
});

import {
  RcloneBackupStore,
  __setRcloneSpawnForTest,
  __resetRcloneSpawnForTest,
} from './rclone-backup-store.js';

// Fake rclone child process: emits `stdout`, exits `code`, then `close`.
function fakeProc(stdout: string, code = 0, stderr = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  const out = Readable.from([Buffer.from(stdout)]);
  proc.stdout = out;
  proc.stderr = Readable.from([Buffer.from(stderr)]);
  out.once('end', () => setImmediate(() => proc.emit('close', code)));
  // empty-stdout case: Readable.from([]) still ends; ensure close fires.
  if (stdout.length === 0) setImmediate(() => setImmediate(() => proc.emit('close', code)));
  return proc as never;
}

function store() {
  return new RcloneBackupStore({
    rcloneEnv: { RCLONE_CONFIG_SRC_TYPE: 'smb', RCLONE_CONFIG_SRC_HOST: 'nas' },
    remoteName: 'src',
    basePath: 'backups/tenant',
  });
}

afterEach(() => __resetRcloneSpawnForTest());

describe('RcloneBackupStore (read-only rclone reader)', () => {
  it('kind is rclone', () => {
    expect(store().kind).toBe('rclone');
  });

  it('listBundleIds runs `lsf --dirs-only <remote>:<base>` and parses dir names', async () => {
    const calls: string[][] = [];
    __setRcloneSpawnForTest((args) => { calls.push([...args]); return fakeProc('bkp-1/\nbkp-2/\n'); });
    const ids = await store().listBundleIds();
    expect(ids).toEqual(['bkp-1', 'bkp-2']);
    const a = calls[0].join(' ');
    expect(a).toContain('lsf');
    expect(a).toContain('--dirs-only');
    expect(a).toContain('src:backups/tenant');
  });

  it('listBundleIds treats "directory not found" as empty (fresh source)', async () => {
    __setRcloneSpawnForTest(() => fakeProc('', 3, 'directory not found'));
    expect(await store().listBundleIds()).toEqual([]);
  });

  it('getMeta cats <bundleId>/meta.json and parses it', async () => {
    const meta = { schemaVersion: 2, tenantId: 't1', capturedAt: '2026-07-18T00:00:00Z', components: {} };
    const calls: string[][] = [];
    __setRcloneSpawnForTest((args) => { calls.push([...args]); return fakeProc(JSON.stringify(meta)); });
    const got = await store().getMeta({ bundleId: 'bkp-1', _backend: {} });
    expect(got.tenantId).toBe('t1');
    expect(calls[0].join(' ')).toContain('cat src:backups/tenant/bkp-1/meta.json');
  });

  it('readComponent streams `cat <bundleId>/components/<c>/<name>`', async () => {
    const calls: string[][] = [];
    __setRcloneSpawnForTest((args) => { calls.push([...args]); return fakeProc('SECRET-BYTES'); });
    const rs = await store().readComponent({ bundleId: 'bkp-1', _backend: {} }, 'secrets', 'tls.json.gz.enc');
    const chunks: Buffer[] = [];
    for await (const c of rs) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('SECRET-BYTES');
    expect(calls[0].join(' ')).toContain('cat src:backups/tenant/bkp-1/components/secrets/tls.json.gz.enc');
  });

  it('listArtifacts parses lsjson entries (files only)', async () => {
    __setRcloneSpawnForTest(() => fakeProc(JSON.stringify([
      { Name: 'db-rows.json.gz', Size: 42, IsDir: false },
      { Name: 'nested', Size: 0, IsDir: true },
    ])));
    const refs = await store().listArtifacts({ bundleId: 'bkp-1', _backend: {} }, 'config');
    expect(refs).toEqual([{ component: 'config', name: 'db-rows.json.gz', sizeBytes: 42 }]);
  });

  it('write methods throw (read-only source)', async () => {
    const s = store();
    await expect(s.reserveBundle()).rejects.toThrow(/read-only/);
    await expect(s.writeComponent()).rejects.toThrow(/read-only/);
    await expect(s.putMeta()).rejects.toThrow(/read-only/);
    await expect(s.delete()).rejects.toThrow(/read-only/);
  });
});
