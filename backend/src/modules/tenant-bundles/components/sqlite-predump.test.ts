/**
 * Unit tests for the SQLite pre-capture parser + script builder, and runs of
 * the generated script itself under `sh` against a temporary volume (with a
 * stub sqlite3, so only sh + GNU find + coreutils are needed). The k8s exec
 * side is covered by the tenant backup/restore integration harness (E2E).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseSqliteCapture,
  parseSqliteDumpOutput,
  buildSqliteCaptureScript,
  SQLITE_DISCOVERY_ENTRY,
  SQLITE_DUMP_DIR,
} from './sqlite-predump.js';

describe('parseSqliteCapture — a capture cut short', () => {
  // The production case: the file manager was OOM-killed on the third of 21
  // files. Exec still resolved (exit 137) with the stdout written so far.
  const killed = [
    'FOUND|/data/a/one.db|',
    'FOUND|/data/a/two.db|',
    'FOUND|/data/b/three.sqlite|',
    'OK|/data/a/one.db|125740260',
    'OK|/data/a/two.db|274566',
  ].join('\n');

  it('reports every announced file it never finished as failed, naming the exit code', () => {
    const { entry, interrupted } = parseSqliteCapture(killed, { exitCode: 137 });
    expect(entry!.databases).toEqual([
      { name: '/data/a/one.db', status: 'dumped', sizeBytes: 125740260 },
      { name: '/data/a/two.db', status: 'dumped', sizeBytes: 274566 },
      { name: '/data/b/three.sqlite', status: 'failed', sizeBytes: 0, error: expect.stringMatching(/interrupted.*\(exit 137\)$/) },
    ]);
    expect(interrupted).toBe(true);
  });

  it('keeps the announced order and ignores a repeated FOUND', () => {
    const entry = parseSqliteDumpOutput(`FOUND|/data/z.db|\nFOUND|/data/a.db|\nFOUND|/data/z.db|\nOK|/data/a.db|1\nDONE||`);
    expect(entry!.databases.map((d) => d.name)).toEqual(['/data/z.db', '/data/a.db']);
  });

  it('a completed run is not interrupted, even when a file failed on its own', () => {
    const { entry, interrupted } = parseSqliteCapture(
      'FOUND|/data/x.db|\nFOUND|/data/y.db|\nOK|/data/x.db|10\nFAIL|/data/y.db|sqlite .dump failed (locked or corrupt)\nDONE||',
      { exitCode: 0 },
    );
    expect(entry!.databases).toEqual([
      { name: '/data/x.db', status: 'dumped', sizeBytes: 10 },
      { name: '/data/y.db', status: 'failed', sizeBytes: 0, error: 'sqlite .dump failed (locked or corrupt)' },
    ]);
    expect(interrupted).toBe(false);
  });

  it('a run that completed with no SQLite files is nothing to summarise', () => {
    expect(parseSqliteCapture('DONE||', { exitCode: 0 })).toEqual({ entry: null, interrupted: false });
  });

  it('a discovery killed before it announced anything is a failed discovery, not "no files"', () => {
    const { entry, interrupted } = parseSqliteCapture('', { exitCode: 137 });
    expect(entry!.databases).toEqual([
      { name: SQLITE_DISCOVERY_ENTRY, status: 'failed', sizeBytes: 0, error: expect.stringMatching(/cut short \(exit 137\)/) },
    ]);
    // nothing was being dumped, so there is no partial file to clean up
    expect(interrupted).toBe(false);
  });

  it('a capture-wide FAIL from the script is reported as the discovery entry', () => {
    const { entry, interrupted } = parseSqliteCapture('FAIL|(SQLite discovery)|the dump directory is a symlink; nothing was dumped', { exitCode: 0 });
    expect(entry!.databases).toEqual([
      { name: SQLITE_DISCOVERY_ENTRY, status: 'failed', sizeBytes: 0, error: expect.stringMatching(/symlink/) },
    ]);
    expect(interrupted).toBe(false);
  });

  it('an empty, successful exec stays "no files" (an older file manager without DONE)', () => {
    expect(parseSqliteDumpOutput('', { exitCode: 0 })).toBeNull();
    expect(parseSqliteDumpOutput('')).toBeNull();
  });
});

describe('parseSqliteDumpOutput', () => {
  it('returns null when no SQLite files were found', () => {
    expect(parseSqliteDumpOutput('')).toBeNull();
    expect(parseSqliteDumpOutput('\n  \n')).toBeNull();
  });

  it('maps OK/DEGRADED/FAIL lines to dumped/degraded/failed', () => {
    const out = [
      'OK|/data/app/site.sqlite|4096',
      'DEGRADED|/data/x.db|PVC 95% full — sqlite dump skipped; raw file still captured',
      'FAIL|/data/broken.sqlite3|sqlite .dump failed (locked or corrupt)',
    ].join('\n');
    const entry = parseSqliteDumpOutput(out);
    expect(entry).not.toBeNull();
    expect(entry!.engine).toBe('sqlite');
    expect(entry!.deploymentName).toBe('(sqlite files)');
    expect(entry!.databases).toEqual([
      { name: '/data/app/site.sqlite', status: 'dumped', sizeBytes: 4096 },
      { name: '/data/x.db', status: 'degraded', sizeBytes: 0, error: expect.stringMatching(/full/) },
      { name: '/data/broken.sqlite3', status: 'failed', sizeBytes: 0, error: expect.stringMatching(/locked or corrupt/) },
    ]);
  });

  it('preserves file paths that themselves contain a pipe in the reason field only', () => {
    // The reason is taken from the LAST '|', so a normal path parses cleanly.
    const entry = parseSqliteDumpOutput('OK|/data/a b/c.sqlite|123');
    expect(entry!.databases[0]).toEqual({ name: '/data/a b/c.sqlite', status: 'dumped', sizeBytes: 123 });
  });

  it('ignores malformed lines', () => {
    expect(parseSqliteDumpOutput('garbage-no-bar\nOK|/data/x.sqlite|10')).toEqual({
      deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite',
      databases: [{ name: '/data/x.sqlite', status: 'dumped', sizeBytes: 10 }],
    });
  });
});

describe('buildSqliteCaptureScript', () => {
  it('sanitises the backupId into the dump filename + targets the dedicated dir', () => {
    const script = buildSqliteCaptureScript('bkp-abc/../evil');
    expect(script).toContain(`DEST='${SQLITE_DUMP_DIR}'`);
    // path-SEPARATORS in the id are collapsed to '_' (dots are allowlisted, so
    // '..' survives — harmless mid-filename with no '/', cannot traverse).
    expect(script).toContain('predump-${rel}-${h}-bkp-abc_.._evil.sqlite.sql');
    expect(script).toContain('SQLite format 3');
    expect(script).toContain('head -n 200');
  });

  it('announces every file before dumping and ends with DONE', () => {
    const script = buildSqliteCaptureScript('bkp-1');
    const found = script.indexOf('say FOUND "$f" ""');
    const dump = script.indexOf('sqlite3 $RO "$f" ".dump"');
    expect(found).toBeGreaterThan(0);
    expect(dump).toBeGreaterThan(found);
    expect(script.trimEnd().endsWith('say DONE "" ""')).toBe(true);
  });
});

// ── The generated script, run ───────────────────────────────────────────

/**
 * The start of a SQLite database header: the 16-byte magic, the page size,
 * then the write/read format versions (bytes 18-19): 1 = rollback journal,
 * 2 = WAL.
 */
function header(mode: 1 | 2): Buffer {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from([0x10, 0x00, mode, mode]), Buffer.alloc(80)]);
}

describe('the generated capture script, run under sh', () => {
  let base: string;
  let root: string;
  let bin: string;

  beforeEach(() => {
    // realpath: the script compares the dump dir with `pwd -P`.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sqlite-capture-')));
    root = join(base, 'data');
    bin = join(base, 'bin');
    mkdirSync(root);
    mkdirSync(bin);
    // A stub sqlite3: `sqlite3 [-readonly] <file> .dump` prints a recognisable dump.
    stub('sqlite3', '#!/bin/sh\nfor a; do case "$a" in -*|.dump) ;; *) f=$a ;; esac; done\nprintf "BEGIN TRANSACTION;\\n-- dump of %s\\nCOMMIT;\\n" "$f"\n');
    // A roomy volume unless a test says otherwise: the host's own disk must not decide a test.
    stub('df', '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 100000000 1000000 99000000 1% /data"\n');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function stub(name: string, body: string): void {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  function db(rel: string, mode: 1 | 2 = 1): string {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, Buffer.concat([header(mode), Buffer.from('rest of the database')]));
    return p;
  }
  function run(id = 'bkp-t1', budgetSeconds?: number): { lines: string[]; status: number | null } {
    const r = spawnSync('sh', ['-c', buildSqliteCaptureScript(id, { root, budgetSeconds })], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    return { lines: r.stdout.split('\n').filter(Boolean), status: r.status };
  }
  const dest = (): string => join(root, '.backup-sqlite-dumps');
  const dumps = (): string[] => (existsSync(dest()) ? readdirSync(dest()).sort() : []);

  it('dumps every SQLite file (spaces in names included), skips other .db files, removes stale partials', () => {
    const a = db('site one/db/main.sqlite');
    const b = db('app/data.db');
    writeFileSync(join(root, 'app/fake.db'), 'not a database');
    mkdirSync(dest());
    writeFileSync(join(dest(), '.partial-OLD123'), 'half a dump');
    writeFileSync(join(dest(), 'predump-stale-x-bkp-old.sqlite.sql'), 'older bundle');

    const { lines, status } = run();
    expect(status).toBe(0);
    expect(lines.filter((l) => l.startsWith('FOUND|')).sort()).toEqual([`FOUND|${b}|`, `FOUND|${a}|`].sort());
    expect(lines.filter((l) => l.startsWith('OK|')).map((l) => l.split('|')[1]).sort()).toEqual([a, b].sort());
    expect(lines.at(-1)).toBe('DONE||');
    const files = dumps();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^predump-.+-[0-9a-f]{12}-bkp-t1\.sqlite\.sql$/.test(f))).toBe(true);
    expect(readFileSync(join(dest(), files.find((f) => f.includes('main.sqlite'))!), 'utf8')).toContain(`-- dump of ${a}`);
    // the parser agrees
    const { entry, interrupted } = parseSqliteCapture(lines.join('\n'), { exitCode: 0 });
    expect(entry!.databases.map((d) => d.status)).toEqual(['dumped', 'dumped']);
    expect(interrupted).toBe(false);
  });

  it('keeps two paths that flatten to the same name apart (a/b.db and a_b.db)', () => {
    db('a/b.db');
    db('a_b.db');
    run();
    expect(dumps()).toHaveLength(2);
  });

  it('completes with no SQLite files at all', () => {
    writeFileSync(join(root, 'index.php'), '<?php');
    const { lines, status } = run();
    expect(status).toBe(0);
    expect(lines).toEqual(['DONE||']);
    expect(parseSqliteCapture(lines.join('\n'), { exitCode: 0 }).entry).toBeNull();
  });

  it('refuses a dump directory the tenant replaced with a symlink, and writes nothing through it', () => {
    db('app/x.db');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'predump-keep-me.sqlite.sql'), 'not ours to delete');
    symlinkSync(elsewhere, dest());
    const { lines } = run();
    expect(lines).toEqual(['FAIL|(SQLite discovery)|the dump directory is not a plain directory on the volume; nothing was dumped']);
    expect(readdirSync(elsewhere)).toEqual(['predump-keep-me.sqlite.sql']);
  });

  it('skips a directory whose name holds a newline (it would split into a path outside the volume)', () => {
    db('ok/fine.db');
    db('evil\n/etc/x.db');
    const { lines } = run();
    const found = lines.filter((l) => l.startsWith('FOUND|'));
    expect(found).toEqual([`FOUND|${join(root, 'ok/fine.db')}|`]);
  });

  it('reports a file search cut short by a signal as a failed discovery, without DONE', () => {
    db('app/x.db');
    stub('find', '#!/bin/sh\nexit 137\n');
    const { lines, status } = run();
    expect(status).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/^FAIL\|\(SQLite discovery\)\|the file search was stopped \(exit 137\)/)]);
  });

  it('carries on past a path that vanished mid-walk (find exit 1)', () => {
    const a = db('app/x.db');
    // GNU find exits 1 when an entry disappears while it walks; simulate it.
    stub('find', `#!/bin/sh\nprintf '%s\\n' '${a}'\nexit 1\n`);
    const { lines } = run();
    expect(lines).toEqual([`FOUND|${a}|`, expect.stringMatching(new RegExp(`^OK\\|${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|\\d+$`)), 'DONE||']);
  });

  it('a failing dump leaves neither a partial nor a final file', () => {
    const a = db('app/x.db');
    stub('sqlite3', '#!/bin/sh\necho "BEGIN;"\nexit 1\n');
    const { lines } = run();
    expect(lines).toContain(`FAIL|${a}|sqlite .dump failed (locked, corrupt or over 900 s)`);
    expect(dumps()).toEqual([]);
  });

  it('opens a rollback-journal database read-only and a WAL database normally', () => {
    const plain = db('app/plain.db', 1);
    const wal = db('app/wal.db', 2);
    const log = join(base, 'argv.log');
    stub('sqlite3', `#!/bin/sh\necho "$*" >> '${log}'\necho "-- dump"\n`);
    run();
    const argv = readFileSync(log, 'utf8').trim().split('\n').sort();
    expect(argv).toEqual([`-readonly ${plain} .dump`, `${wal} .dump`].sort());
  });

  it('closes the dump directory to everyone but its owner', () => {
    db('app/x.db');
    run();
    expect(statSync(dest()).mode & 0o777).toBe(0o700);
  });

  it('takes the first 200 of more SQLite files without mistaking its own cut-off for a killed search', () => {
    for (let i = 0; i < 230; i++) db(`many/f${String(i).padStart(3, '0')}.db`);
    const { lines, status } = run();
    expect(status).toBe(0);
    expect(lines.filter((l) => l.startsWith('FOUND|'))).toHaveLength(200);
    expect(lines.filter((l) => l.startsWith('OK|'))).toHaveLength(200);
    expect(lines.at(-1)).toBe('DONE||');
  });

  it('skips a database with a hot rollback journal instead of replaying it as root', () => {
    const a = db('app/x.db');
    writeFileSync(`${a}-journal`, 'a journal the tenant could have crafted');
    const { lines } = run();
    expect(lines).toContain(`DEGRADED|${a}|an unfinished transaction (rollback journal) is pending; dump skipped, raw file still captured`);
    expect(dumps()).toEqual([]);
  });

  it('says so when the free space cannot be read', () => {
    const a = db('app/x.db');
    stub('df', '#!/bin/sh\nexit 1\n');
    const { lines } = run();
    expect(lines).toContain(`DEGRADED|${a}|the free space on the volume could not be read; sqlite dump skipped, raw file still captured`);
  });

  it('skips the dump when the volume is already 90% full', () => {
    const a = db('app/x.db');
    // total 1,000,000 KiB, 50,000 available: below the 10% that must stay free.
    stub('df', '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 1000000 950000 50000 95% /data"\n');
    const { lines } = run();
    expect(lines).toContain(`DEGRADED|${a}|PVC 90% full or more — sqlite dump skipped; raw file still captured`);
    expect(dumps()).toEqual([]);
  });

  it('stops a dump that would push the volume past 90%, and leaves nothing of it behind', () => {
    const a = db('app/x.db');
    // 100,004 KiB free of 1,000,000: room for 4 KiB of dump.
    stub('df', '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 1000000 899996 100004 90% /data"\n');
    stub('sqlite3', '#!/bin/sh\nhead -c 65536 /dev/zero | tr "\\0" x\n');
    const { lines } = run();
    expect(lines).toContain(`DEGRADED|${a}|the dump would fill the volume past 90%; skipped, raw file still captured`);
    expect(dumps()).toEqual([]);
  });

  it('reports the files it had no time left for, and still ends the run', () => {
    const a = db('app/x.db');
    const { lines } = run('bkp-t1', 0);
    expect(lines).toEqual([`FOUND|${a}|`, `FAIL|${a}|the capture ran out of time (0 s); the raw file is still in the files snapshot`, 'DONE||']);
  });

  it('replaces a symlink planted at the final dump name instead of writing through it', () => {
    const a = db('app/x.db');
    // Learn the name the script will use, then plant a symlink there.
    run();
    const name = dumps()[0]!;
    rmSync(join(dest(), name));
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dest(), name));
    const { lines } = run();
    expect(lines).toContain(`FOUND|${a}|`);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(join(dest(), name), 'utf8')).toContain(`-- dump of ${a}`);
  });
});
