import { describe, expect, it } from 'vitest';
import { DbExecError, type DbManagerContext } from './db-manager.js';
import {
  fromHexColumn, hexColumnSql, mysqlAccount, fromHex, mongoResult, mongoRoot, mysqlClient, mysqlIdent, mysqlRoot, mysqlRootScript, mysqlString, outputLines, pgIdent, pgString, pgSuperuser,
  shellQuote, sh, tryRun, unescapeBatch, withoutClientNoise, works, MONGO_OK_JS, type DbCommandRunner,
} from './db-exec.js';
import { PG_RECONCILER_SESSION_SH, PG_SAFE_SESSION_SH } from './pg-session.js';

function ctx(engine: DbManagerContext['engine'] = 'mariadb', over: Partial<DbManagerContext> = {}): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine, rootPassword: 'r00t', rootUsername: 'root', ...over };
}

describe('unescapeBatch', () => {
  it.each([
    ['plain', 'plain'],
    ['a\\nb', 'a\nb'],
    ['a\\tb', 'a\tb'],
    ['a\\0b', 'a\0b'],
    ['C:\\\\path', 'C:\\path'],
    ['\\\\n', '\\n'],
    ['', ''],
    ['trailing\\\\', 'trailing\\'],
    ['\\x', 'x'],
  ])('%j -> %j', (input, expected) => {
    expect(unescapeBatch(input)).toBe(expected);
  });

  it('handles an escaped backslash followed by n as a backslash and an n, not a newline', () => {
    expect(unescapeBatch('a\\\\nb')).toBe('a\\nb');
  });
});

describe('fromHex', () => {
  it('decodes UTF-8, including characters a plain row could not carry', () => {
    expect(fromHex(Buffer.from('shop\ndb\t1').toString('hex'))).toBe('shop\ndb\t1');
    expect(fromHex(Buffer.from('café 🚀').toString('hex'))).toBe('café 🚀');
    expect(fromHex('')).toBe('');
    expect(fromHex('4A4a')).toBe('JJ');
  });

  it.each(['zz', '4', 'abc', '4g', 'ok\n', ' 41', '0x41', 'ERROR 1045 (28000)'])('rejects %j as unexpected database output', (bad) => {
    expect(() => fromHex(bad)).toThrow(DbExecError);
  });

  it('puts at most 40 characters of the output in the error', () => {
    expect(() => fromHex('x'.repeat(200))).toThrow(new RegExp(`unexpected output from the database: x{40}$`));
  });
});

describe('quoting', () => {
  it('mysqlString escapes backslash before the quote', () => {
    expect(mysqlString("a'b")).toBe("'a\\'b'");
    expect(mysqlString('a\\')).toBe("'a\\\\'");
    expect(mysqlString("\\'")).toBe("'\\\\\\''");
    expect(mysqlString('')).toBe("''");
  });
  it('mysqlIdent doubles backticks', () => expect(mysqlIdent('a`b')).toBe('`a``b`'));
  it('pgIdent doubles double quotes', () => expect(pgIdent('a"b')).toBe('"a""b"'));
  it('pgString doubles single quotes and leaves backslashes', () => expect(pgString("it's\\")).toBe("'it''s\\'"));
  it('shellQuote survives a quote', () => expect(shellQuote("a'b")).toBe("'a'\\''b'"));
});

describe('mysql commands', () => {
  it('mysqlRoot logs in as root over the socket with the stored password, SQL last after -e', () => {
    const argv = mysqlRoot(ctx('mariadb'), 'SELECT 1');
    expect(argv.slice(0, 3)).toEqual(['mariadb', '-uroot', '-pr00t']);
    expect(argv).toEqual(expect.arrayContaining(['--protocol=socket', '--batch', '--skip-column-names', '--default-character-set=utf8mb4', '--binary-mode']));
    expect(argv).toContain("--init-command=SET SESSION sql_mode = '', SESSION lock_wait_timeout = 30");
    expect(argv.slice(-2)).toEqual(['-e', 'SELECT 1']);
  });

  it('uses the mysql client for MySQL', () => {
    expect(mysqlRoot(ctx('mysql'), 'x')[0]).toBe('mysql');
    expect(mysqlClient(ctx('mysql'))).toBe('mysql');
    expect(mysqlClient(ctx('mariadb'))).toBe('mariadb');
  });

  it('a socket-only root has no stored password: a placeholder keeps -p from prompting', () => {
    expect(mysqlRoot(ctx('mariadb', { rootPassword: '' }), 'x')).toContain('-px');
  });

  it('mysqlRootScript sends the script on stdin, never in argv', () => {
    const script = 'DELIMITER $$abc\nSELECT 1$$abc\nDELIMITER ;\n';
    const c = mysqlRootScript(ctx(), script);
    expect(c.stdin).toBe(script);
    expect(c.argv).not.toContain('-e');
    expect(c.argv.join(' ')).not.toContain('DELIMITER');
  });
});

describe('pgSuperuser', () => {
  it('runs psql inside the pinned session script, as the configured superuser', () => {
    const argv = pgSuperuser(ctx('postgresql', { rootUsername: 'myapp' }), 'SELECT 1');
    expect(argv.slice(0, 5)).toEqual(['sh', '-c', PG_RECONCILER_SESSION_SH, 'sh', 'psql']);
    expect(argv).toEqual(expect.arrayContaining(['-X', '-U', 'myapp', '-d', "dbname='postgres'", 'ON_ERROR_STOP=1']));
    expect(argv[argv.length - 2]).toBe('-qtAc');
    expect(argv[argv.length - 1]).toBe('SELECT 1');
  });

  it('connects to the database asked for', () => {
    const argv = pgSuperuser(ctx('postgresql'), 'SELECT 1', 'shop');
    expect(argv[argv.indexOf('-d') + 1]).toBe("dbname='shop'");
    // a name that reads as a connection string stays a database name
    expect(pgSuperuser(ctx('postgresql'), 'x', "a' host=evil\\")[argv.indexOf('-d') + 1]).toBe("dbname='a\\' host=evil\\\\'");
  });

  it('SQL is one argv element, however many quotes and newlines it holds', () => {
    const sql = "SELECT 'a';\nDO $$ BEGIN END $$;";
    expect(pgSuperuser(ctx('postgresql'), sql).filter((a) => a === sql)).toHaveLength(1);
  });

  it('the reconciler session also gives up on locks and forces writable transactions', () => {
    expect(PG_RECONCILER_SESSION_SH).toContain('default_transaction_read_only=off');
    expect(PG_RECONCILER_SESSION_SH).toContain('statement_timeout=300000');
    expect(PG_RECONCILER_SESSION_SH).toContain('lock_timeout=30000');
    expect(PG_RECONCILER_SESSION_SH).toContain('postgres -V || psql -V');
    // the platform's own long-running work (dumps, restores) has no time limit
    expect(PG_SAFE_SESSION_SH).not.toContain('statement_timeout');
  });

  it('every session pins the string-literal rules the platform\'s quoting relies on', () => {
    for (const sh of [PG_SAFE_SESSION_SH, PG_RECONCILER_SESSION_SH]) {
      expect(sh).toContain('standard_conforming_strings=on');
      expect(sh).toContain('backslash_quote=safe_encoding');
    }
  });

  it('the pinned session pins search_path and turns event triggers off from 17', () => {
    expect(PG_SAFE_SESSION_SH).toContain('search_path=pg_catalog,pg_temp');
    expect(PG_SAFE_SESSION_SH).toContain('event_triggers=off');
    expect(PG_SAFE_SESSION_SH).toMatch(/\[ "\$v" -ge 17 \]/);
    expect(PG_SAFE_SESSION_SH.endsWith('exec "$@"')).toBe(true);
  });
});

describe('mongoRoot', () => {
  it('puts the password on stdin and only on stdin', () => {
    const c = mongoRoot(ctx('mongodb', { rootPassword: 'S3cr3t-pw' }), 'db.hello().ok');
    expect(c.stdin).toBe('S3cr3t-pw\n');
    expect(c.argv.join('\u0000')).not.toContain('S3cr3t-pw');
    // `-p` with no value after it: mongosh prompts, and reads the line from stdin.
    const p = c.argv.indexOf('-p');
    expect(c.argv[p + 1]).toBe('--authenticationDatabase');
    expect(c.argv).toEqual(expect.arrayContaining(['--quiet', '--norc', '-u', 'root', 'admin', '--eval', 'db.hello().ok']));
  });

  it('a second stdin line follows the password (passwordPrompt())', () => {
    expect(mongoRoot(ctx('mongodb', { rootPassword: 'a' }), 'js', 'next-pw\n').stdin).toBe('a\nnext-pw\n');
  });

  it('uses the configured root user name', () => {
    const c = mongoRoot(ctx('mongodb', { rootUsername: 'boss' }), 'js');
    expect(c.argv[c.argv.indexOf('-u') + 1]).toBe('boss');
  });

  it('the proof expression is not a bare quoted string (mongosh would strip the quotes)', () => {
    expect(MONGO_OK_JS).toBe('String("ok")');
  });

  it('mongoResult is the last line', () => {
    expect(mongoResult('warn\nok\n')).toBe('ok');
    expect(mongoResult('')).toBe('');
  });
});

describe('running commands', () => {
  const x = (run: DbCommandRunner) => ({ ctx: ctx(), run });

  it('tryRun passes argv and stdin to the runner', async () => {
    const seen: Array<[string[], string | undefined]> = [];
    const run: DbCommandRunner = async (_c, argv, stdin) => { seen.push([argv, stdin]); return { stdout: 'o', stderr: '' }; };
    expect(await tryRun(x(run), { argv: ['a', 'b'], stdin: 'in\n' })).toEqual({ ok: true, stdout: 'o', error: '' });
    expect(await tryRun(x(run), ['c'])).toMatchObject({ ok: true });
    expect(seen).toEqual([[['a', 'b'], 'in\n'], [['c'], undefined]]);
  });

  it('an ERROR on stderr is a failure even when the exec exited 0 (batch mode)', async () => {
    const run: DbCommandRunner = async () => ({ stdout: 'partial', stderr: 'ERROR 1064 (42000): syntax' });
    expect(await tryRun(x(run), ['q'])).toEqual({ ok: false, stdout: 'partial', error: 'ERROR 1064 (42000): syntax' });
  });

  it('a warning that merely contains the word in lower case is not an error', async () => {
    const run: DbCommandRunner = async () => ({ stdout: '', stderr: 'warning: error handling is off' });
    expect((await tryRun(x(run), ['q'])).ok).toBe(true);
  });

  it('a thrown error is a failure, never a throw, and carries the cleaned message', async () => {
    const run: DbCommandRunner = async () => { throw new DbExecError('mariadb: Using a password on the command line interface can be insecure.\nERROR 1045 (28000): Access denied'); };
    const r = await tryRun(x(run), ['q']);
    expect(r).toEqual({ ok: false, stdout: '', error: 'ERROR 1045 (28000): Access denied' });
  });

  it('a non-Error rejection is stringified', async () => {
    const run: DbCommandRunner = async () => { throw 'boom'; };
    expect((await tryRun(x(run), ['q'])).error).toBe('boom');
  });

  it('sh returns stdout, or throws DbExecError with the client error', async () => {
    const ok: DbCommandRunner = async () => ({ stdout: 'rows', stderr: '' });
    const bad: DbCommandRunner = async () => ({ stdout: '', stderr: 'ERROR 1146: no table' });
    expect(await sh(x(ok), ['q'])).toBe('rows');
    await expect(sh(x(bad), ['q'])).rejects.toThrow(DbExecError);
    await expect(sh(x(bad), ['q'])).rejects.toThrow('ERROR 1146: no table');
  });

  it('works is the boolean of tryRun', async () => {
    expect(await works(x(async () => ({ stdout: '', stderr: '' })), ['q'])).toBe(true);
    expect(await works(x(async () => { throw new Error('x'); }), ['q'])).toBe(false);
  });
});

describe('text helpers', () => {
  it('withoutClientNoise drops the password warning and the prompt only', () => {
    expect(withoutClientNoise('mysql: [Warning] Using a password on the command line interface can be insecure.\nERROR 1: x'))
      .toBe('ERROR 1: x');
    expect(withoutClientNoise('Enter password: \nERROR 2: y')).toBe('ERROR 2: y');
    expect(withoutClientNoise('')).toBe('');
  });

  it('outputLines trims and drops empty lines', () => {
    expect(outputLines(' a \n\n\tb\t\n  \n')).toEqual(['a', 'b']);
    expect(outputLines('')).toEqual([]);
  });
});

describe('mysqlAccount', () => {
  it('quotes user and host as identifiers (no sql_mode changes that)', () => {
    expect(mysqlAccount('app', '%')).toBe('`app`@`%`');
    expect(mysqlAccount("o'brien", 'local`host')).toBe("`o'brien`@`local``host`");
    expect(mysqlAccount('', 'localhost')).toBe('``@`localhost`');
  });
  it('a role has no host', () => expect(mysqlAccount('r1', null)).toBe('`r1`'));
});

describe('hexColumnSql / fromHexColumn', () => {
  it('reads back what it asks for, behind an x sentinel', () => {
    expect(hexColumnSql('User')).toBe("CONCAT('x', HEX(User))");
    expect(fromHexColumn(`x${Buffer.from('app').toString('hex')}`)).toBe('app');
  });
  it('an empty value (the anonymous account) survives', () => {
    expect(fromHexColumn('x')).toBe('');
  });
  it.each([undefined, '', '41', 'zz', 'xzz', 'x4'])('rejects %j', (bad) => {
    expect(() => fromHexColumn(bad)).toThrow(DbExecError);
  });
});
