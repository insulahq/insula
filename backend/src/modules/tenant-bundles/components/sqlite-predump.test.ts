/**
 * Unit tests for the SQLite pre-capture parser + script builder, and runs of
 * the generated script itself under `sh` against a temporary volume (with a
 * stub sqlite3, so only sh + GNU find + coreutils are needed). The k8s exec
 * side is covered by the tenant backup/restore integration harness (E2E).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseSqliteCapture,
  parseSqliteDumpOutput,
  buildSqliteCaptureScript,
  ON_COPY_SCRIPT,
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
    const dump = script.indexOf('todump inplace');
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
    // Opened in its own directory, by its name there.
    expect(readFileSync(join(dest(), files.find((f) => f.includes('main.sqlite'))!), 'utf8')).toContain('-- dump of ./main.sqlite');
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

  it('opens every database read-only, from its own directory, refusing a link', () => {
    db('app/plain.db', 1);
    db('app/wal/wal.db', 2);
    const log = join(base, 'argv.log');
    stub('sqlite3', `#!/bin/sh\necho "$(pwd -P) $*" >> '${log}'\necho "-- dump"\n`);
    run();
    const argv = readFileSync(log, 'utf8').trim().split('\n').sort();
    expect(argv).toEqual([
      `${join(root, 'app')} -nofollow -readonly ./plain.db .dump`,
      `${join(root, 'app/wal')} -nofollow -readonly ./wal.db .dump`,
    ].sort());
  });

  it('refuses a directory swapped for a link after the walk', () => {
    const a = db('app/x.db');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'x.db'), readFileSync(a));
    // find lists the real directory; by the dump, it is a link elsewhere.
    stub('find', `#!/bin/sh\nprintf '%s\\n' '${a}'\n`);
    rmSync(join(root, 'app'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'app'));
    const log = join(base, 'argv.log');
    stub('sqlite3', `#!/bin/sh\necho "$*" >> '${log}'\necho "-- dump"\n`);
    const { lines } = run();
    expect(lines.some((l) => l.startsWith(`FAIL|${a}|`))).toBe(true);
    expect(existsSync(log)).toBe(false);
  });

  it('sweeps a planted copy folder without following what is in it', () => {
    db('app/x.db');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(join(elsewhere, 'db'), { recursive: true });
    writeFileSync(join(elsewhere, 'db', 'keep'), 'not ours');
    writeFileSync(join(elsewhere, 'db-journal'), 'not ours either');
    mkdirSync(join(dest(), '.partial-planted.d'), { recursive: true });
    // A folder link where a copy's file would be, and a link to a file: a recursive delete would follow the first.
    symlinkSync(join(elsewhere, 'db'), join(dest(), '.partial-planted.d', 'db'));
    symlinkSync(join(elsewhere, 'db-journal'), join(dest(), '.partial-planted.d', 'db-journal'));
    run();
    expect(readFileSync(join(elsewhere, 'db', 'keep'), 'utf8')).toBe('not ours');
    expect(readFileSync(join(elsewhere, 'db-journal'), 'utf8')).toBe('not ours either');
  });

  it('writes dumps readable by root alone (the directory is passable, the names predictable)', () => {
    db('app/x.db');
    run();
    expect(statSync(join(dest(), dumps()[0]!)).mode & 0o777).toBe(0o600);
  });

  it('closes the dump directory to everyone but its owner, who may only pass through', () => {
    db('app/x.db');
    run();
    // 0711: nobody else lists, creates or removes an entry; the owner of a
    // file being rolled back reaches the copy folder made for them.
    expect(statSync(dest()).mode & 0o777).toBe(0o711);
  });

  it('takes the first 200 of more SQLite files without mistaking its own cut-off for a killed search', () => {
    for (let i = 0; i < 230; i++) db(`many/f${String(i).padStart(3, '0')}.db`);
    const { lines, status } = run();
    expect(status).toBe(0);
    expect(lines.filter((l) => l.startsWith('FOUND|'))).toHaveLength(200);
    expect(lines.filter((l) => l.startsWith('OK|'))).toHaveLength(200);
    expect(lines.at(-1)).toBe('DONE||');
  });

  describe('an unfinished transaction left behind (a hot rollback journal)', () => {
    /** A journal SQLite would call hot: a non-zero first byte (the real header starts with its magic). */
    const HOT = Buffer.concat([Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]), Buffer.alloc(504, 1)]);
    const twentyMinutesAgo = (): number => Date.now() / 1000 - 1200;
    function journal(file: string, body: Buffer, at: number | null = twentyMinutesAgo()): string {
      writeFileSync(`${file}-journal`, body);
      if (at !== null) {
        utimesSync(`${file}-journal`, at, at);
        utimesSync(file, at, at);
      }
      return `${file}-journal`;
    }
    /** A sqlite3 that records how it was called and, like the real one, rolls a hot journal back (removing it) unless read-only. */
    function recordingSqlite(log: string): void {
      stub('sqlite3', [
        '#!/bin/sh',
        'for a; do case "$a" in -*|.dump) ;; *) f=$a ;; esac; done',
        `echo "$* journal=$( [ -f "$f-journal" ] && echo yes || echo no )" >> '${log}'`,
        'case " $* " in *" -readonly "*) ;; *) rm -f "$f-journal" ;; esac',
        'printf -- "-- dump of %s\\n" "$f"',
      ].join('\n'));
    }

    it('dumps a copy rolled back there, never replaying the journal in place, and leaves the tenant\'s pair alone', () => {
      const a = db('app/x.db');
      const j = journal(a, HOT);
      const log = join(base, 'argv.log');
      recordingSqlite(log);
      const { lines } = run();
      expect(lines).toContain(`FOUND|${a}|`);
      expect(lines.some((l) => l.startsWith(`OK|${a}|`))).toBe(true);
      // Opened read-write (so it rolls back) — the copy, with its journal beside it.
      expect(readFileSync(log, 'utf8').trim()).toBe('-nofollow ./db .dump journal=yes');
      // The copy folder is gone; only the dump stays.
      expect(readdirSync(dest())).toHaveLength(1);
      expect(dumps()[0]).toMatch(/^predump-/);
      expect(readFileSync(join(dest(), dumps()[0]!), 'utf8')).toContain('-- dump of ./db');
      // The tenant's database and journal are as they were.
      expect(readFileSync(j)).toEqual(HOT);
      expect(parseSqliteCapture(lines.join('\n'), { exitCode: 0 }).entry!.databases[0]!.status).toBe('dumped');
    });

    it('treats a journal with a zeroed header as finished (journal_mode=PERSIST) and dumps read-only', () => {
      const a = db('app/x.db');
      journal(a, Buffer.alloc(8720), null);
      const log = join(base, 'argv.log');
      recordingSqlite(log);
      const { lines } = run();
      expect(lines.some((l) => l.startsWith(`OK|${a}|`))).toBe(true);
      expect(readFileSync(log, 'utf8').trim()).toBe('-nofollow -readonly ./x.db .dump journal=yes');
    });

    it('waits for the next bundle when the journal changed in the last 10 minutes (a transaction in progress)', () => {
      const a = db('app/x.db');
      journal(a, HOT, null);
      const { lines } = run();
      expect(lines).toContain(`DEGRADED|${a}|a transaction is in progress (its rollback journal changed in the last 10 minutes); dump skipped, raw file still captured`);
      expect(dumps()).toEqual([]);
    });

    it('skips one whose journal names a super-journal (a multi-database transaction)', () => {
      const a = db('app/x.db');
      const superRecord = Buffer.concat([Buffer.from('/etc/victim'), Buffer.from([0, 0, 0, 11, 0, 0, 0, 0]), HOT.subarray(0, 8)]);
      journal(a, Buffer.concat([HOT, superRecord]));
      const { lines } = run();
      expect(lines).toContain(`DEGRADED|${a}|an unfinished transaction spanning several databases is pending; dump skipped, raw file still captured`);
      expect(dumps()).toEqual([]);
    });

    it('skips one whose journal is a symlink', () => {
      const a = db('app/x.db');
      writeFileSync(join(base, 'elsewhere-journal'), HOT);
      symlinkSync(join(base, 'elsewhere-journal'), `${a}-journal`);
      const { lines } = run();
      expect(lines).toContain(`DEGRADED|${a}|its rollback journal is not a regular file; dump skipped, raw file still captured`);
    });

    it('skips one whose header says WAL (a hot rollback journal there is not SQLite\'s own state)', () => {
      const a = db('app/x.db', 2);
      journal(a, HOT);
      const { lines } = run();
      expect(lines).toContain(`DEGRADED|${a}|an unfinished transaction is pending on a database not in rollback-journal mode; dump skipped, raw file still captured`);
    });

    it('a failed dump of the copy leaves neither the copy nor a partial dump behind', () => {
      const a = db('app/x.db');
      journal(a, HOT);
      stub('sqlite3', '#!/bin/sh\necho "BEGIN;"\nexit 1\n');
      const { lines } = run();
      expect(lines).toContain(`FAIL|${a}|sqlite .dump failed (locked, corrupt or over 900 s)`);
      expect(readdirSync(dest())).toEqual([]);
    });

    it('skips it when the copy would push the volume past 90%', () => {
      const a = db('app/x.db');
      journal(a, HOT);
      // 1 KiB free above the 10% that must stay free: no room for the copy.
      stub('df', '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 1000000 899999 100001 90% /data"\n');
      const { lines } = run();
      expect(lines).toContain(`DEGRADED|${a}|an unfinished transaction is pending and there is no room to roll it back on a copy without filling the volume past 90%; dump skipped, raw file still captured`);
      expect(readdirSync(dest())).toEqual([]);
    });
  });

  describe('the checks made on the copy (ON_COPY_SCRIPT)', () => {
    const HOTJ = Buffer.concat([Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]), Buffer.alloc(504, 1)]);
    function onCopy(dbMode: 1 | 2, journalBody: Buffer | 'link'): number | null {
      const dir = join(base, 'copy');
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'db'), Buffer.concat([header(dbMode), Buffer.from('rest')]));
      if (journalBody === 'link') symlinkSync(join(base, 'nowhere'), join(dir, 'db-journal'));
      else writeFileSync(join(dir, 'db-journal'), journalBody);
      stub('sqlite3', '#!/bin/sh\necho "-- dump"\n');
      return spawnSync('sh', ['-c', ON_COPY_SCRIPT], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } }).status;
    }

    it('dumps a hot journal on a rollback-journal database', () => {
      expect(onCopy(1, HOTJ)).toBe(0);
    });
    it('10: the copied journal is finished after all (committed while it was copied)', () => {
      expect(onCopy(1, Buffer.alloc(512))).toBe(10);
    });
    it('11: the copied journal names a super-journal, whatever the tenant\'s file said when checked', () => {
      expect(onCopy(1, Buffer.concat([HOTJ, Buffer.from('/etc/victim'), Buffer.from([0, 0, 0, 11, 0, 0, 0, 0]), HOTJ.subarray(0, 8)]))).toBe(11);
    });
    it('12: the copy is not a rollback-journal database', () => {
      expect(onCopy(2, HOTJ)).toBe(12);
    });
    it('13: the copied journal is a link', () => {
      expect(onCopy(1, 'link')).toBe(13);
    });
  });

  it('leaves dependency folders and the files Nextcloud users keep to the files snapshot', () => {
    mkdirSync(join(root, 'nc'));
    writeFileSync(join(root, 'nc/.ocdata'), '');
    const kept = [
      db('nc/owncloud.db'),
      db('nc/appdata_oc1/mail/AddressBook.sqlite'),
      db('drupal/sites/default/files/.ht.sqlite'),
      db('app/storage/app.db'),
      // A user-like folder outside a Nextcloud data directory is still searched.
      db('other/bob/files/real.db'),
    ];
    for (const rel of [
      'nc/alice/files/Music/Project/Ableton Project Info/IndexWin.db',
      'nc/alice/files_trashbin/files/old.db',
      'nc/alice/files_versions/Music/IndexWin.db',
      'nc/alice/uploads/chunk.db',
      'nc/__groupfolders/1/shared.db',
      'nc/updater-oc1/backups/nextcloud-34/config/x.db',
      'site/public_html/apps/suspicious_login/vendor/rubix/ml/tests/test.sqlite',
      'app/node_modules/pkg/fixture.db',
      'app/.git/x.db',
      'app/bower_components/x/y.sqlite3',
    ]) db(rel);
    const { lines, status } = run();
    expect(status).toBe(0);
    expect(lines.filter((l) => l.startsWith('FOUND|')).map((l) => l.split('|')[1]).sort()).toEqual([...kept].sort());
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
    expect(readFileSync(join(dest(), name), 'utf8')).toContain('-- dump of ./x.db');
  });
});
