/**
 * What a tenant's SQL runs as, and with: `env -i … gosu nobody` and no client
 * commands, psql in restricted mode for a plain-SQL import, and no secret in
 * an argument vector.
 */
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFn = vi.fn();
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig { loadFromFile = vi.fn(); loadFromCluster = vi.fn(); }
  class MockExec { exec = mockExecFn; }
  return { KubeConfig: MockKubeConfig, Exec: MockExec };
});

import {
  PSQL_RESTRICT_LINE_SED, PSQL_TOO_OLD, PSQL_TOO_OLD_MESSAGE, executeQuery, importSql, newPsqlRestrictKey, restrictedPsqlInput, type DbManagerContext,
} from './db-manager.js';

interface Seen { argv: string[]; stdin?: string }
const seen: Seen[] = [];

/** Every exec: record argv and whatever arrives on stdin, then answer. */
function answerWith(reply: (argv: string[]) => { stdout?: string; stderr?: string; fail?: boolean } = () => ({})): void {
  mockExecFn.mockImplementation((
    _ns: string, _pod: string, _c: string, argv: string[],
    out: NodeJS.WritableStream, err: NodeJS.WritableStream, stdin: NodeJS.ReadableStream | null, _tty: boolean,
    cb: (s: Record<string, unknown>) => void,
  ) => {
    const entry: Seen = { argv };
    seen.push(entry);
    const finish = (): void => {
      const r = reply(argv);
      if (r.stdout) out.write(Buffer.from(r.stdout));
      if (r.stderr) err.write(Buffer.from(r.stderr));
      setTimeout(() => cb(r.fail ? { status: 'Failure', message: 'command terminated with exit code 3' } : { status: 'Success' }), 0);
    };
    if (stdin) {
      let data = '';
      stdin.on('data', (c: Buffer) => { data += c.toString(); });
      stdin.on('end', () => { entry.stdin = data; finish(); });
    } else finish();
    return Promise.resolve({});
  });
}

function ctx(engine: DbManagerContext['engine'], over: Partial<DbManagerContext> = {}): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine, rootPassword: 'r00t-secret', rootUsername: 'root', ...over };
}

const LOGIN = { username: 'dbadmin', password: 'tenant-admin-secret' };
const UNPRIVILEGED = ['env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/tmp', 'gosu', 'nobody'];

beforeEach(() => {
  vi.clearAllMocks();
  seen.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('restrictedPsqlInput / newPsqlRestrictKey', () => {
  it('a fresh 128-bit alphanumeric key each time', () => {
    const a = newPsqlRestrictKey();
    const b = newPsqlRestrictKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('the first line is the restrict command with the key, then the SQL', () => {
    expect(restrictedPsqlInput('SELECT 1;\n', 'abc123')).toBe('\\restrict abc123\nSELECT 1;\n');
  });

  it('a dump\'s own \\restrict / \\unrestrict lines are dropped, so the file cannot lift the restriction', () => {
    const dump = [
      '\\restrict ABC123',
      'CREATE TABLE t (a int);',
      '\\unrestrict ABC123',
      '\\unrestrict guess',
      'SELECT 1;',
    ].join('\n');
    const out = restrictedPsqlInput(dump, 'mykey');
    expect(out.split('\n')[0]).toBe('\\restrict mykey');
    expect(out).not.toMatch(/ABC123|guess/);
    expect(out.match(/\\restrict/g)).toHaveLength(1);
    expect(out).not.toContain('unrestrict');
    expect(out).toContain('CREATE TABLE t (a int);');
  });

  it('CRLF dumps are handled', () => {
    const out = restrictedPsqlInput('\\unrestrict k1\r\nSELECT 1;\r\n', 'mykey');
    expect(out).not.toContain('unrestrict');
    expect(out).toContain('SELECT 1;');
  });

  it('COPY data and other lines are untouched', () => {
    const copy = [
      'COPY public.notes (id, body) FROM stdin;',
      '1\tthe text \\restrict abc inside a field',
      '2\t\\\\restrict abc',
      '\\\\unrestrict abc',
      '\\.',
      'SELECT \'\\restrict abc\';',
      '-- \\unrestrict abc',
      '\\restricted abc',
      '\\restrict',
      '\\restrict abc def',
    ].join('\n');
    expect(restrictedPsqlInput(copy, 'k')).toBe(`\\restrict k\n${copy}`);
  });

  it('the key line never needs the SQL to be well formed', () => {
    expect(restrictedPsqlInput('', 'k')).toBe('\\restrict k\n');
  });
});

describe('PSQL_RESTRICT_LINE_SED', () => {
  const sed = spawnSync('sed', ['--version'], { encoding: 'utf8' });
  const gnu = sed.status === 0 && /GNU sed/.test(sed.stdout);
  const FIXTURE = [
    '\\restrict Zk93aB',
    'CREATE TABLE t (a int);',
    'COPY t (a) FROM stdin;',
    '\\\\restrict abc',
    'x\\restrict abc',
    '\\.',
    '\\unrestrict Zk93aB   ',
    '\\unrestrict Zk93aB\r',
    '\\restricted abc',
    '\\restrict',
    '\\restrict a b',
    "SELECT '\\restrict abc';",
    '',
  ].join('\n');

  it.runIf(gnu)('removes exactly the lines the JavaScript rewrite empties', () => {
    const r = spawnSync('sed', ['-E', PSQL_RESTRICT_LINE_SED], { input: FIXTURE, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const viaJs = restrictedPsqlInput(FIXTURE, 'k').split('\n').slice(1);
    const original = FIXTURE.split('\n');
    // sed deletes the line, JS leaves it empty: the same lines, once the empty ones are dropped.
    const dropped = original.filter((_l, i) => viaJs[i] !== '' || original[i] === '');
    expect(r.stdout.split('\n')).toEqual(dropped);
    expect(r.stdout).not.toMatch(/Zk93aB/);
    expect(r.stdout).toContain('\\\\restrict abc');
    expect(r.stdout).toContain('x\\restrict abc');
    expect(r.stdout).toContain('\\restricted abc');
  });

  it('is a delete of one address', () => {
    expect(PSQL_RESTRICT_LINE_SED.endsWith('/d')).toBe(true);
  });
});

describe('a plain-SQL import into PostgreSQL as the tenant administrator', () => {
  it('runs psql unprivileged in restricted mode: the key line first, the dump\'s own restrict lines gone', async () => {
    answerWith();
    const dump = '\\restrict FROMDUMP\nCREATE TABLE t (a int);\n\\unrestrict FROMDUMP\n';
    const r = await importSql(ctx('postgresql', { rootUsername: 'postgres' }), 'shop', dump, { as: LOGIN });
    expect(r).toEqual({ success: true });
    expect(seen).toHaveLength(1);
    const { argv, stdin } = seen[0]!;
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    // the database goes in as a connection string, so a name cannot read as an option
    expect(argv.slice(3)).toEqual(['sh', 'dbadmin', "dbname='shop'"]);
    // psql must know \restrict before anything runs, and nothing runs as the OS root
    expect(argv[2]).toContain("psql -X -U \"$1\" -d \"$2\" -c '\\restrict probe'");
    expect(argv[2]).toContain(PSQL_TOO_OLD);
    expect(argv[2]).toContain(UNPRIVILEGED.map((a) => `'${a}'`).join(' '));
    expect(argv[2]).toMatch(/exec .* psql -X -U "\$1" -d "\$2"$/);
    expect(stdin).toMatch(/^\\restrict [0-9a-f]{32}\n\nCREATE TABLE t \(a int\);\n\n$/);
    expect(stdin).not.toMatch(/FROMDUMP|unrestrict/);
    // no secret in the argument vector
    expect(argv.join('\u0000')).not.toContain('tenant-admin-secret');
  });

  it('uses a different key for each import', async () => {
    answerWith();
    await importSql(ctx('postgresql'), 'shop', 'SELECT 1;', { as: LOGIN });
    await importSql(ctx('postgresql'), 'shop', 'SELECT 1;', { as: LOGIN });
    const keys = seen.map((s) => /^\\restrict (\w+)\n/.exec(s.stdin!)![1]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a psql too old for restricted mode is refused with the explanation, not run', async () => {
    answerWith(() => ({ stderr: PSQL_TOO_OLD, fail: true }));
    const r = await importSql(ctx('postgresql'), 'shop', 'SELECT 1;', { as: LOGIN });
    expect(r).toEqual({ success: false, error: PSQL_TOO_OLD_MESSAGE });
  });

  it('an ERROR from the server is the result', async () => {
    answerWith(() => ({ stderr: 'ERROR:  relation "x" does not exist' }));
    const r = await importSql(ctx('postgresql'), 'shop', 'SELECT * FROM x;', { as: LOGIN });
    expect(r.success).toBe(false);
    expect(r.error).toContain('relation "x" does not exist');
  });

  it('the platform\'s own import (no login) is the superuser\'s psql in the pinned session, with the SQL untouched', async () => {
    answerWith();
    await importSql(ctx('postgresql', { rootUsername: 'myapp' }), 'shop', '\\restrict keep\nSELECT 1;', {});
    const { argv, stdin } = seen[0]!;
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    expect(argv.join(' ')).toContain('PGOPTIONS');
    expect(argv.join(' ')).not.toContain('gosu');
    expect(stdin).toBe('\\restrict keep\nSELECT 1;');
  });
});

describe('a tenant\'s SQL on MariaDB / MySQL', () => {
  it('runs the client as nobody with an empty environment, over TCP with its own login, with no client commands', async () => {
    answerWith(() => ({ stdout: 'a\n1\n' }));
    await executeQuery(ctx('mariadb'), 'shop', 'SELECT 1 AS a', { as: LOGIN });
    const argv = seen[0]!.argv;
    expect(argv.slice(0, UNPRIVILEGED.length)).toEqual(UNPRIVILEGED);
    expect(argv.slice(UNPRIVILEGED.length, UNPRIVILEGED.length + 6)).toEqual(['mariadb', '-udbadmin', '-ptenant-admin-secret', '-h127.0.0.1', '--protocol=TCP', '--binary-mode']);
    expect(argv).toContain('--local-infile=0');
    expect(argv.join('\u0000')).not.toContain('r00t-secret');
  });

  it('MySQL asks for the server\'s public key (caching_sha2 over TCP)', async () => {
    // The mariadb binary is tried first; a missing binary falls back to mysql.
    answerWith((argv) => (argv.includes('mariadb') ? { stderr: 'exec: "mariadb": executable file not found in $PATH', fail: true } : { stdout: 'a\n1\n' }));
    await executeQuery(ctx('mysql'), 'shop', 'SELECT 1 AS a', { as: LOGIN });
    const last = seen.at(-1)!.argv;
    expect(last).toContain('mysql');
    expect(last).toContain('--get-server-public-key');
    expect(last.slice(0, UNPRIVILEGED.length)).toEqual(UNPRIVILEGED);
  });

  it('the platform\'s own query is root over the socket, without the unprivileged prefix', async () => {
    answerWith(() => ({ stdout: 'a\n1\n' }));
    await executeQuery(ctx('mariadb'), 'shop', 'SELECT 1 AS a');
    const argv = seen[0]!.argv;
    expect(argv[0]).toBe('mariadb');
    expect(argv.slice(1, 4)).toEqual(['-u', 'root', '-pr00t-secret']);
    expect(argv).not.toContain('gosu');
  });

  it('a tenant dump import is rewritten (no DEFINER, no SQL_LOG_BIN) and run as the tenant', async () => {
    answerWith();
    await importSql(ctx('mariadb'), 'shop', 'SET @@SESSION.SQL_LOG_BIN= 0;\nCREATE DEFINER=`root`@`localhost` VIEW v AS SELECT 1;\n', { as: LOGIN });
    expect(seen[0]!.stdin).not.toMatch(/DEFINER|SQL_LOG_BIN/i);
    expect(seen[0]!.argv.slice(0, UNPRIVILEGED.length)).toEqual(UNPRIVILEGED);
    expect(seen[0]!.argv).toContain('--database=shop');
  });

  it('the platform\'s own import is not rewritten', async () => {
    answerWith();
    const dump = 'CREATE DEFINER=`app`@`%` VIEW v AS SELECT 1;\n';
    await importSql(ctx('mariadb'), 'shop', dump, {});
    expect(seen[0]!.stdin).toBe(dump);
  });

  it('refuses a dump that switches to the system schema, before any exec', async () => {
    const r = await importSql(ctx('mariadb'), 'shop', 'USE mysql;\nDROP TABLE user;', { as: LOGIN });
    expect(r.success).toBe(false);
    expect(mockExecFn).not.toHaveBeenCalled();
  });
});

describe('a tenant\'s MongoDB commands', () => {
  it('log in with -p and no value: the password is stdin\'s first line, never argv', async () => {
    answerWith(() => ({ stdout: '[]' }));
    await executeQuery(ctx('mongodb', { rootUsername: 'boss' }), 'shop', 'db.t.find()', { as: LOGIN });
    const { argv, stdin } = seen[0]!;
    expect(argv.slice(0, UNPRIVILEGED.length)).toEqual(UNPRIVILEGED);
    expect(argv.join('\u0000')).not.toMatch(/tenant-admin-secret|r00t-secret/);
    expect(argv[argv.indexOf('-p') + 1]).toBe('--authenticationDatabase');
    expect(argv[argv.indexOf('-u') + 1]).toBe('dbadmin');
    expect(stdin).toBe('tenant-admin-secret\n');
  });

  it('the platform\'s own command is root with root\'s password on stdin', async () => {
    answerWith(() => ({ stdout: '[]' }));
    await executeQuery(ctx('mongodb', { rootUsername: 'boss' }), 'shop', 'db.t.find()');
    const { argv, stdin } = seen[0]!;
    expect(argv[argv.indexOf('-u') + 1]).toBe('boss');
    expect(argv).not.toContain('gosu');
    expect(argv.join('\u0000')).not.toContain('r00t-secret');
    expect(stdin).toBe('r00t-secret\n');
  });

  it('a mongorestore import hands the password to a root-only config file through stdin', async () => {
    answerWith();
    await importSql(ctx('mongodb'), 'shop', 'ARCHIVE-BYTES', { as: LOGIN });
    const { argv, stdin } = seen[0]!;
    expect(argv.join('\u0000')).not.toContain('tenant-admin-secret');
    expect(argv[2]).toContain('umask 077');
    expect(stdin).toBe('"tenant-admin-secret"\nARCHIVE-BYTES');
  });
});
