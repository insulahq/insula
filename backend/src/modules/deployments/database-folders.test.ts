/**
 * The protected-folder file operations (R48). The script itself runs here for
 * real, against a temporary directory standing in for the volume root.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, readFileSync, statSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FOLDER_OPS_SH,
  folderSizes,
  formatFolderBytes,
  isPlatformPath,
  keptFolderCandidates,
  listProtectedEntries,
  moveFolder,
  moveToKept,
  removeFolder,
  sanitizeDataFolder,
  stageTenantFile,
  folderState,
  canMoveFolder,
  unlinkInPlace,
  type PlatformFilesRun,
} from './database-folders.js';
import { gzipSync } from 'node:zlib';

let root = '';

/** Runs the script as `platform-files` would, with `/data` mapped to the temp root. */
const run: PlatformFilesRun = (argv) => new Promise((resolve) => {
  const [, , script, ...rest] = argv;
  // Only `/data` as a whole path component: `/database` contains it too.
  execFile('sh', ['-c', String(script).replace(/\/data(?![A-Za-z0-9_-])/g, root), ...rest], (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ stdout, stderr, exitCode: code });
  });
});

const p = (rel: string): string => join(root, rel);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'r48-'));
  mkdirSync(p('database/mariadb/live'), { recursive: true });
  writeFileSync(p('database/mariadb/live/user.MYD'), 'live');
  mkdirSync(p('upload/old/mysql'), { recursive: true });
  writeFileSync(p('upload/old/mysql/global_priv.MAD'), 'grants');
  mkdirSync(p('public/site'), { recursive: true });
  writeFileSync(p('public/site/dump.sql'), 'select 1;');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('isPlatformPath', () => {
  it.each(['database/mariadb/shop', 'kept-databases/shop-20261126-120000', 'a'])('accepts %j', (x) => expect(isPlatformPath(x)).toBe(true));
  it.each(['', '/database', 'database/../etc', 'a//b', '.trash/x', 'a/b/c/d/e/f/g', 'a b'])('refuses %j', (x) => expect(isPlatformPath(x)).toBe(false));
});

describe('the folder script', () => {
  it('moves a folder in, creating the parents', async () => {
    expect(await moveFolder(run, 'upload/old', 'database/mariadb/adopted', true)).toEqual({ ok: true });
    expect(readFileSync(p('database/mariadb/adopted/mysql/global_priv.MAD'), 'utf8')).toBe('grants');
    expect(existsSync(p('upload/old'))).toBe(false);
  });

  it('refuses to move in a folder that holds hard-linked files, and moves nothing', async () => {
    mkdirSync(p('outside'));
    linkSync(p('upload/old/mysql/global_priv.MAD'), p('outside/second-name'));
    expect(await moveFolder(run, 'upload/old', 'database/mariadb/adopted', true)).toMatchObject({ ok: false, reason: 'links' });
    expect(existsSync(p('upload/old/mysql/global_priv.MAD'))).toBe(true);
    expect(existsSync(p('database/mariadb/adopted'))).toBe(false);
    // A plain move (out of the protected folder) does not care.
    expect(await moveFolder(run, 'upload/old', 'kept-databases/old', false)).toEqual({ ok: true });
  });

  it('copies apart hard links in place, so a second name no longer reaches the file', async () => {
    mkdirSync(p('outside'));
    linkSync(p('database/mariadb/live/user.MYD'), p('outside/second-name'));
    expect(await unlinkInPlace(run, 'database/mariadb/live')).toBe(true);
    writeFileSync(p('outside/second-name'), 'tampered');
    expect(readFileSync(p('database/mariadb/live/user.MYD'), 'utf8')).toBe('live');
    expect(statSync(p('database/mariadb/live/user.MYD')).nlink).toBe(1);
  });

  it('checks a move without making it', async () => {
    expect(await canMoveFolder(run, 'upload/old', 'database/mariadb/x')).toEqual({ ok: true });
    expect(existsSync(p('upload/old'))).toBe(true);
    symlinkSync(p('upload'), p('linked'));
    expect(await canMoveFolder(run, 'linked/old', 'database/mariadb/x')).toMatchObject({ ok: false, reason: 'symlink' });
  });

  it('refuses a source behind a symlink', async () => {
    symlinkSync(p('upload'), p('linked'));
    const r = await moveFolder(run, 'linked/old', 'database/mariadb/x', true);
    expect(r).toMatchObject({ ok: false, reason: 'symlink' });
    expect(existsSync(p('upload/old'))).toBe(true);
  });

  it('refuses a destination whose parent is a symlink', async () => {
    mkdirSync(p('elsewhere'));
    rmSync(p('database/mariadb'), { recursive: true });
    symlinkSync(p('elsewhere'), p('database/mariadb'));
    expect(await moveFolder(run, 'upload/old', 'database/mariadb/x', true)).toMatchObject({ ok: false, reason: 'symlink' });
  });

  it('refuses an existing destination and a missing source', async () => {
    mkdirSync(p('kept-databases/live'), { recursive: true });
    expect(await moveFolder(run, 'database/mariadb/live', 'kept-databases/live', false)).toMatchObject({ ok: false, reason: 'exists' });
    expect(await moveFolder(run, 'upload/missing', 'database/mariadb/y', true)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('moveToKept takes the next free name', async () => {
    mkdirSync(p('kept-databases/live'), { recursive: true });
    const r = await moveToKept(run, 'database/mariadb/live', 'live');
    expect(r.ok).toBe(true);
    expect(r.ok && r.path).toMatch(/^kept-databases\/live-\d{8}-\d{6}$/);
  });

  it('measures folders and reports a missing one or a symlink as unknown', async () => {
    symlinkSync(p('public'), p('linkdir'));
    const sizes = await folderSizes(run, ['database/mariadb/live', 'nope', 'linkdir']);
    expect(sizes.get('database/mariadb/live')).toBeGreaterThan(0);
    expect(sizes.get('nope')).toBeNull();
    expect(sizes.get('linkdir')).toBeNull();
  });

  it('lists the protected folder two levels deep, and anything else at the top', async () => {
    writeFileSync(p('database/stray'), 'x');
    expect((await listProtectedEntries(run)).sort()).toEqual(['database/mariadb/live', 'database/stray']);
  });

  it('removes a folder, refusing one behind a symlink', async () => {
    symlinkSync(p('public'), p('linkdir'));
    await expect(removeFolder(run, 'linkdir/site')).rejects.toThrow(/symlink/);
    await removeFolder(run, 'database/mariadb/live');
    expect(existsSync(p('database/mariadb/live'))).toBe(false);
  });

  it('stages a tenant file into an instance folder, copied or decompressed', async () => {
    writeFileSync(p('public/site/dump.sql.gz'), gzipSync('select 2;'));
    expect(await stageTenantFile(run, 'public/site/dump.sql', 'database/mariadb/live/a.sql', 'copy')).toEqual({ ok: true });
    expect(readFileSync(p('database/mariadb/live/a.sql'), 'utf8')).toBe('select 1;');
    expect(await stageTenantFile(run, 'public/site/dump.sql.gz', 'database/mariadb/live/b.sql', 'gunzip')).toEqual({ ok: true });
    expect(readFileSync(p('database/mariadb/live/b.sql'), 'utf8')).toBe('select 2;');
    expect(await stageTenantFile(run, 'public/site/dump.sql', 'database/mariadb/live/a.sql', 'copy')).toEqual({ ok: false, reason: 'exists' });
    expect(await stageTenantFile(run, 'public/site/none.sql', 'database/mariadb/live/c.sql', 'copy')).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['a symlink to a file in the protected folder', '../../database/mariadb/live/user.MYD', 'public/site/evil'],
    ['a path through a symlink to the folder itself', '../../database', 'public/site/evil/mariadb/live/user.MYD'],
  ])('refuses to stage %s', async (_label, target, file) => {
    symlinkSync(target, p('public/site/evil'));
    expect(await stageTenantFile(run, file, 'database/mariadb/live/x.sql', 'copy')).toEqual({ ok: false, reason: 'protected' });
    expect(existsSync(p('database/mariadb/live/x.sql'))).toBe(false);
  });

  it('stages from the instance\'s own folder only when asked to', async () => {
    writeFileSync(p('database/mariadb/live/predump-shop-b1.sql'), 'dump');
    expect(await stageTenantFile(run, 'database/mariadb/live/predump-shop-b1.sql', 'database/mariadb/live/y.sql', 'copy', 'database/mariadb/live')).toEqual({ ok: true });
    expect(await stageTenantFile(run, 'database/mariadb/live/predump-shop-b1.sql', 'database/mariadb/live/z.sql', 'copy', 'database/mariadb/other')).toEqual({ ok: false, reason: 'protected' });
    expect(await stageTenantFile(run, 'database/mariadb/live/predump-shop-b1.sql', 'database/mariadb/live/z.sql', 'copy')).toEqual({ ok: false, reason: 'protected' });
  });

  it('never copies apart to a name the folder could already hold (a planted link there is ignored)', async () => {
    mkdirSync(p('outside'));
    writeFileSync(p('outside/target'), 'untouched');
    linkSync(p('database/mariadb/live/user.MYD'), p('outside/second-name'));
    symlinkSync('../../../outside/target', p('database/mariadb/live/user.MYD.r48-unlink'));
    expect(await unlinkInPlace(run, 'database/mariadb/live')).toBe(true);
    expect(readFileSync(p('outside/target'), 'utf8')).toBe('untouched');
    expect(statSync(p('database/mariadb/live/user.MYD')).nlink).toBe(1);
  });

  it('cleans an attached folder: PostgreSQL settings that run or load code, and MySQL persisted settings', async () => {
    mkdirSync(p('database/postgresql/pg/18/docker'), { recursive: true });
    writeFileSync(p('database/postgresql/pg/18/docker/postgresql.conf'), [
      "shared_buffers = '128MB'",
      "shared_preload_libraries = '/var/lib/postgresql/18/docker/evil.so'",
      "  archive_command='curl x | sh'",
      "Shared_Preload_Libraries = 'evil2'",
      "ARCHIVE_COMMAND = 'id'",
      "hba_file = '/var/lib/postgresql/18/docker/other_hba.conf'",
      "include_dir 'conf.d'",
      '# shared_preload_libraries in a comment stays',
      "work_mem = '4MB'",
    ].join('\n'));
    writeFileSync(p('database/postgresql/pg/18/docker/pg_hba.conf'), [
      'local all all scram-sha-256',
      'host all all 0.0.0.0/0 trust',
      'HOST all all ::/0 Trust',
      'hostssl all all 10.0.0.0/8 cert',
      'host all all 0.0.0.0/0 scram-sha-256',
      'include_dir hba.d',
    ].join('\n'));
    writeFileSync(p('database/postgresql/pg/18/docker/postgresql.auto.conf'), "ssl_passphrase_command = 'id'\nmax_connections = '50'\n");
    writeFileSync(p('database/mariadb/live/mysqld-auto.cnf'), '{"mysql_server": {}}');
    await sanitizeDataFolder(run, 'database/postgresql/pg');
    await sanitizeDataFolder(run, 'database/mariadb/live');
    expect(readFileSync(p('database/postgresql/pg/18/docker/postgresql.conf'), 'utf8').split('\n')).toEqual([
      "shared_buffers = '128MB'", '# shared_preload_libraries in a comment stays', "work_mem = '4MB'",
    ]);
    expect(readFileSync(p('database/postgresql/pg/18/docker/postgresql.auto.conf'), 'utf8')).toBe("max_connections = '50'\n");
    expect(readFileSync(p('database/postgresql/pg/18/docker/pg_hba.conf'), 'utf8').trimEnd().split('\n')).toEqual([
      'local all all scram-sha-256', 'host all all 0.0.0.0/0 scram-sha-256',
    ]);
    expect(existsSync(p('database/mariadb/live/mysqld-auto.cnf'))).toBe(false);
  });

  it('tells what sits at two paths', async () => {
    symlinkSync(p('public'), p('linkdir'));
    expect(await folderState(run, 'database/mariadb/live', 'nothing/here')).toEqual(['dir', 'missing']);
    expect(await folderState(run, 'linkdir', 'public/site/dump.sql')).toEqual(['link', 'other']);
  });

  it('reports a move that left hard links and could not go back as stranded', async () => {
    const fake: PlatformFilesRun = async () => ({ stdout: 'hard links; could not move back', stderr: '', exitCode: 10 });
    expect(await moveFolder(fake, 'a', 'database/b/c', true)).toMatchObject({ ok: false, reason: 'stranded' });
  });

  it('passes every path as an argument, never inside the script', () => {
    expect(FOLDER_OPS_SH).not.toMatch(/\$\{?(src|dst)\}?[^"]/);
    expect(lstatSync(root).isDirectory()).toBe(true);
  });
});

describe('formatting and names', () => {
  it('formats like the file manager', () => {
    expect(formatFolderBytes(0)).toBe('0 B');
    expect(formatFolderBytes(1536)).toBe('1.5 KB');
    expect(formatFolderBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
  it('offers the plain kept name first, then time-suffixed ones', () => {
    const [a, b, c] = keptFolderCandidates('shop', new Date('2026-11-26T12:34:56Z'));
    expect([a, b, c]).toEqual(['kept-databases/shop', 'kept-databases/shop-20261126-123456', 'kept-databases/shop-20261126-123456-2']);
  });
});
