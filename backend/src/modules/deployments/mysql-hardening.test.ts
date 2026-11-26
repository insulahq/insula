/**
 * mysql-hardening.ts: the pure grant reading and rewriting against SHOW GRANTS
 * lines as MariaDB and MySQL print them, and the passes that run them against
 * a fake server. What the statements do on the real engines was checked on
 * MariaDB 10.11/12.3 and MySQL 8.0/8.4/9.7 containers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbExecError, type DbManagerContext } from './db-manager.js';
import type { DbCommandRunner } from './db-exec.js';
import {
  accountSql, adoptRootDefinedObjects, allDatabasesGrants, ensureAllDatabasesAccounts, grantPattern, narrowAccounts, narrowingStatements,
  parseGrant, patternMatches, PREFIX_PATTERN, withDefiner,
} from './mysql-hardening.js';

const hex = (s: string): string => Buffer.from(s).toString('hex');
/** A column the platform reads back with the `x` sentinel in front (an empty value would otherwise vanish). */
const X = (s: string): string => `x${hex(s)}`;

describe('grantPattern / PREFIX_PATTERN', () => {
  it.each([
    ['shop', 'shop'],
    ['my_app', 'my\\_app'],
    ['50%', '50\\%'],
    ['a\\b', 'a\\\\b'],
    ['a_b%c\\d', 'a\\_b\\%c\\\\d'],
    ['', ''],
  ])('%j -> %j', (db, expected) => expect(grantPattern(db)).toBe(expected));

  it('the prefix pattern is db\\_%', () => expect(PREFIX_PATTERN).toBe('db\\_%'));

  it('a pattern built for a name matches that name and no lookalike', () => {
    for (const name of ['my_app', 'a%b', 'back\\slash', 'dot.name', 'x_y_z', 'ünï_cödé']) {
      expect(patternMatches(grantPattern(name), name)).toBe(true);
    }
    expect(patternMatches(grantPattern('my_app'), 'myXapp')).toBe(false);
    expect(patternMatches(grantPattern('a%b'), 'aXXb')).toBe(false);
    expect(patternMatches(grantPattern('dot.name'), 'dotXname')).toBe(false);
  });
});

describe('patternMatches', () => {
  it.each([
    ['m%', 'mysql', true],
    ['m%', 'shop', false],
    ['%', 'anything', true],
    ['%', '', true],
    ['_ysql', 'mysql', true],
    ['_ysql', 'ysql', false],
    ['my\\_app', 'my_app', true],
    ['my\\_app', 'myXapp', false],
    ['my_app', 'myXapp', true],
    ['db\\_%', 'db_shop', true],
    ['db\\_%', 'dbshop', false],
    ['50\\%', '50%', true],
    ['50\\%', '500', false],
    ['MySQL', 'mysql', true],
    ['a.b', 'axb', false],
    ['a.b', 'a.b', true],
    ['a*', 'aaa', false],
    ['a\\\\b', 'a\\b', true],
    ['a%', 'a\nb', true],
    ['(x)', '(x)', true],
    ['a/b', 'a/b', true],
    ['trailing\\', 'trailing\\', true],
    ['sys', 'sys', true],
    ['sys', 'sysx', false],
  ])('%j vs %j -> %s', (pattern, name, expected) => {
    expect(patternMatches(pattern, name)).toBe(expected);
  });
});

describe('parseGrant', () => {
  it('MariaDB: global privileges with a password hash and GRANT OPTION', () => {
    const line = "GRANT SELECT, INSERT, FILE, CREATE USER ON *.* TO `evil`@`%` IDENTIFIED BY PASSWORD '*9319B9F4E2A1C3C9FA1B1B0C4F1C6C6A3F2B5D7E' WITH GRANT OPTION";
    expect(parseGrant(line)).toEqual({ kind: 'global', line, privileges: ['SELECT', 'INSERT', 'FILE', 'CREATE USER'], grantOption: true });
  });

  it('a USAGE-only global grant has no GRANT OPTION', () => {
    const g = parseGrant("GRANT USAGE ON *.* TO `app`@`%` IDENTIFIED BY PASSWORD '*AA'");
    expect(g).toMatchObject({ kind: 'global', privileges: ['USAGE'], grantOption: false });
  });

  it('a password that happens to read WITH GRANT OPTION is still after the TO', () => {
    expect(parseGrant('GRANT SELECT ON *.* TO `u`@`%` WITH GRANT OPTION')).toMatchObject({ grantOption: true });
  });

  it('MariaDB: a database grant, pattern unquoted', () => {
    expect(parseGrant('GRANT ALL PRIVILEGES ON `m%`.* TO `evil`@`%`')).toMatchObject({ kind: 'database', privileges: ['ALL PRIVILEGES'], pattern: 'm%' });
    expect(parseGrant('GRANT SELECT, INSERT ON `my\\_app`.* TO `u`@`%`')).toMatchObject({ kind: 'database', pattern: 'my\\_app' });
    expect(parseGrant('GRANT SELECT ON `a``b`.* TO `u`@`%`')).toMatchObject({ kind: 'database', pattern: 'a`b' });
  });

  it('a table grant is an object grant in its schema', () => {
    expect(parseGrant('GRANT SELECT ON `mysql`.`user` TO `evil`@`%`')).toMatchObject({ kind: 'object', schema: 'mysql' });
    expect(parseGrant('GRANT SELECT, INSERT ON `shop`.`orders` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'shop' });
  });

  it('column privileges are read as one grant, commas inside the parentheses kept together', () => {
    expect(parseGrant('GRANT SELECT (`a`), UPDATE (`b`) ON `shop`.`t` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'shop' });
    expect(parseGrant('GRANT SELECT (`a`, `b`), UPDATE (`c`) ON `mysql`.`user` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'mysql' });
  });

  it('routine grants are object grants in their schema', () => {
    expect(parseGrant('GRANT EXECUTE ON PROCEDURE `shop`.`p` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'shop' });
    expect(parseGrant('GRANT EXECUTE ON FUNCTION `sys`.`f` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'sys' });
    expect(parseGrant('GRANT EXECUTE ON PACKAGE BODY `shop`.`pk` TO `u`@`%`')).toMatchObject({ kind: 'object', schema: 'shop' });
  });

  it('PROXY grants, MariaDB and MySQL spelling', () => {
    expect(parseGrant('GRANT PROXY ON `root`@`localhost` TO `evil`@`%`')).toEqual({ kind: 'proxy', line: 'GRANT PROXY ON `root`@`localhost` TO `evil`@`%`', target: '`root`@`localhost`' });
    expect(parseGrant("GRANT PROXY ON ''@'' TO 'evil'@'%' WITH GRANT OPTION")).toMatchObject({ kind: 'proxy', target: "''@''" });
  });

  it('MariaDB role grant', () => {
    expect(parseGrant('GRANT `r1` TO `evil`@`%`')).toEqual({ kind: 'role', line: 'GRANT `r1` TO `evil`@`%`', roles: ['`r1`'] });
  });

  it('MySQL: a role is an account, so root can be granted as one', () => {
    expect(parseGrant('GRANT `root`@`localhost` TO `evil`@`%`')).toMatchObject({ kind: 'role', roles: ['`root`@`localhost`'] });
    expect(parseGrant('GRANT `r1`@`%`,`root`@`localhost` TO `evil`@`%`')).toMatchObject({ kind: 'role', roles: ['`r1`@`%`', '`root`@`localhost`'] });
  });

  it('MySQL dynamic privileges are global privileges, one by one', () => {
    expect(parseGrant('GRANT BACKUP_ADMIN,BINLOG_ADMIN ON *.* TO `evil`@`%`')).toMatchObject({ kind: 'global', privileges: ['BACKUP_ADMIN', 'BINLOG_ADMIN'] });
    expect(parseGrant('GRANT SELECT, INSERT, BACKUP_ADMIN ON *.* TO `evil`@`%` WITH GRANT OPTION')).toMatchObject({ privileges: ['SELECT', 'INSERT', 'BACKUP_ADMIN'], grantOption: true });
  });

  it('SET DEFAULT ROLE lines are roles that grant nothing', () => {
    expect(parseGrant('SET DEFAULT ROLE `r1` FOR `u`@`%`')).toMatchObject({ kind: 'role', roles: [] });
    expect(parseGrant('SET DEFAULT ROLE ALL TO `u`@`%`')).toMatchObject({ kind: 'role', roles: [] });
  });

  it.each([
    'GRANT SELECT ON *.`t` TO `u`@`%`',
    'something else entirely',
    '',
    'REVOKE SELECT ON *.* FROM `u`@`%`',
  ])('%j is unknown', (line) => {
    expect(parseGrant(line).kind).toBe('unknown');
  });
});

describe('narrowingStatements', () => {
  const acct = "'evil'@'%'";
  const dbs = ['shop', 'my_app', 'mydb'];
  const narrow = (lines: string[], tenantDbs = dbs): string[] => narrowingStatements(acct, lines.map(parseGrant), tenantDbs);

  it('leaves an account that already holds no more than tenant databases alone', () => {
    expect(narrow([
      "GRANT USAGE ON *.* TO `evil`@`%` IDENTIFIED BY PASSWORD '*AA'",
      'GRANT ALL PRIVILEGES ON `shop`.* TO `evil`@`%`',
      'GRANT SELECT (`a`), UPDATE (`b`) ON `shop`.`t` TO `evil`@`%`',
      'GRANT EXECUTE ON PROCEDURE `shop`.`p` TO `evil`@`%`',
      'GRANT `r1` TO `evil`@`%`',
      'SET DEFAULT ROLE `r1` FOR `evil`@`%`',
    ])).toEqual([]);
  });

  it('keeps the harmless global privileges (they show things, change nothing)', () => {
    expect(narrow(['GRANT PROCESS, SHOW DATABASES, REPLICATION CLIENT ON *.* TO `evil`@`%`'])).toEqual([]);
    expect(narrow(['GRANT BINLOG MONITOR, REPLICA MONITOR ON *.* TO `evil`@`%`'])).toEqual([]);
  });

  it('a global privilege that changes things: its data privileges are granted per tenant database, then it is revoked', () => {
    const out = narrow([
      "GRANT SELECT, INSERT, FILE, CREATE USER ON *.* TO `evil`@`%` IDENTIFIED BY PASSWORD '*9319' WITH GRANT OPTION",
    ]);
    expect(out).toEqual([
      "GRANT SELECT, INSERT ON `db\\_%`.* TO 'evil'@'%'",
      "GRANT SELECT, INSERT ON `shop`.* TO 'evil'@'%'",
      "GRANT SELECT, INSERT ON `my\\_app`.* TO 'evil'@'%'",
      "GRANT SELECT, INSERT ON `mydb`.* TO 'evil'@'%'",
      "REVOKE GRANT OPTION ON *.* FROM 'evil'@'%'",
      "REVOKE SELECT, INSERT, FILE, CREATE USER ON *.* FROM 'evil'@'%'",
    ]);
  });

  it('what the account may keep is never revoked (PROCESS next to SUPER)', () => {
    const out = narrow(['GRANT SELECT, PROCESS, SUPER ON *.* TO `evil`@`%`'], ['shop']);
    expect(out).toEqual([
      "GRANT SELECT ON `db\\_%`.* TO 'evil'@'%'",
      "GRANT SELECT ON `shop`.* TO 'evil'@'%'",
      "REVOKE SELECT, SUPER ON *.* FROM 'evil'@'%'",
    ]);
  });

  it('GRANT OPTION alone is not safe: only the option is revoked', () => {
    expect(narrow(['GRANT USAGE ON *.* TO `evil`@`%` WITH GRANT OPTION'])).toEqual(["REVOKE GRANT OPTION ON *.* FROM 'evil'@'%'"]);
    expect(narrow(['GRANT PROCESS ON *.* TO `evil`@`%` WITH GRANT OPTION'])).toEqual(["REVOKE GRANT OPTION ON *.* FROM 'evil'@'%'"]);
  });

  it('MySQL dynamic privileges are revoked (they are not database privileges), nothing granted in their place', () => {
    expect(narrow(['GRANT BACKUP_ADMIN,BINLOG_ADMIN ON *.* TO `evil`@`%`'])).toEqual(["REVOKE BACKUP_ADMIN, BINLOG_ADMIN ON *.* FROM 'evil'@'%'"]);
  });

  it('ALL PRIVILEGES on *.* becomes ALL on every tenant database, then goes', () => {
    expect(narrow(['GRANT ALL PRIVILEGES ON *.* TO `evil`@`%`'], ['shop'])).toEqual([
      "GRANT ALL PRIVILEGES ON `db\\_%`.* TO 'evil'@'%'",
      "GRANT ALL PRIVILEGES ON `shop`.* TO 'evil'@'%'",
      "REVOKE ALL PRIVILEGES ON *.* FROM 'evil'@'%'",
    ]);
  });

  it('a pattern that also matches `mysql` is granted per tenant database it matches, then revoked as written', () => {
    expect(narrow(['GRANT ALL PRIVILEGES ON `m%`.* TO `evil`@`%`'])).toEqual([
      "GRANT ALL PRIVILEGES ON `my\\_app`.* TO 'evil'@'%'",
      "GRANT ALL PRIVILEGES ON `mydb`.* TO 'evil'@'%'",
      "REVOKE ALL PRIVILEGES ON `m%`.* FROM 'evil'@'%'",
    ]);
  });

  it('a pattern with escapes is revoked exactly as SHOW GRANTS wrote it', () => {
    expect(narrow(['GRANT SELECT ON `m%`.* TO `evil`@`%` WITH GRANT OPTION'], ['mydb'])).toEqual([
      "GRANT SELECT ON `mydb`.* TO 'evil'@'%'",
      "REVOKE GRANT OPTION ON `m%`.* FROM 'evil'@'%'",
      "REVOKE ALL PRIVILEGES ON `m%`.* FROM 'evil'@'%'",
    ]);
  });

  it('a pattern that matches the self-service prefix keeps the prefix', () => {
    const out = narrow(['GRANT SELECT ON `%`.* TO `evil`@`%`'], ['shop']);
    expect(out).toEqual([
      "GRANT SELECT ON `db\\_%`.* TO 'evil'@'%'",
      "GRANT SELECT ON `shop`.* TO 'evil'@'%'",
      "REVOKE ALL PRIVILEGES ON `%`.* FROM 'evil'@'%'",
    ]);
  });

  it('a pattern matching only system schemas leaves nothing to grant', () => {
    expect(narrow(['GRANT ALL PRIVILEGES ON `mysq_`.* TO `evil`@`%`'])).toEqual(["REVOKE ALL PRIVILEGES ON `mysq_`.* FROM 'evil'@'%'"]);
  });

  it('grants reaching the system schema are revoked one by one; every other grant is not touched at all', () => {
    const out = narrow([
      'GRANT SELECT ON `mysql`.`user` TO `evil`@`%`',
      'GRANT SELECT ON `performance_schema`.* TO `evil`@`%`',
      'GRANT SELECT (`a`), UPDATE (`b`) ON `shop`.`t` TO `evil`@`%`',
      'GRANT ALL PRIVILEGES ON `shop`.* TO `evil`@`%`',
    ]);
    expect(out).toEqual([
      "REVOKE SELECT ON `mysql`.`user` FROM 'evil'@'%'",
      "REVOKE ALL PRIVILEGES ON `performance_schema`.* FROM 'evil'@'%'",
    ]);
  });

  it('a column grant on the system schema is revoked with its columns', () => {
    expect(narrow(['GRANT SELECT (`User`), UPDATE (`Host`) ON `mysql`.`user` TO `evil`@`%` WITH GRANT OPTION'])).toEqual([
      "REVOKE GRANT OPTION ON `mysql`.`user` FROM 'evil'@'%'",
      "REVOKE SELECT (`User`), UPDATE (`Host`) ON `mysql`.`user` FROM 'evil'@'%'",
    ]);
  });

  it('a routine grant in the system schema is revoked as a routine', () => {
    expect(narrow(['GRANT EXECUTE ON FUNCTION `sys`.`f` TO `evil`@`%`'])).toEqual(["REVOKE EXECUTE ON FUNCTION `sys`.`f` FROM 'evil'@'%'"]);
  });

  it('a PROXY grant is revoked', () => {
    expect(narrow(['GRANT PROXY ON `root`@`localhost` TO `evil`@`%`'])).toEqual(["REVOKE PROXY ON `root`@`localhost` FROM 'evil'@'%'"]);
  });

  it('MySQL: root granted as a role is revoked; an ordinary role is not touched', () => {
    expect(narrow(['GRANT `root`@`localhost` TO `evil`@`%`'])).toEqual(["REVOKE `root`@`localhost` FROM 'evil'@'%'"]);
    expect(narrow(['GRANT `r1`@`%` TO `evil`@`%`', 'GRANT `mysql.sys`@`localhost` TO `evil`@`%`'])).toEqual([
      "REVOKE `mysql.sys`@`localhost` FROM 'evil'@'%'",
    ]);
    expect(narrow(['GRANT `r1`@`%`,`root`@`localhost` TO `evil`@`%`'])).toEqual(["REVOKE `root`@`localhost` FROM 'evil'@'%'"]);
  });

  it('MariaDB: an ordinary role stays where it is while the global privilege is narrowed', () => {
    expect(narrow(['GRANT `r1` TO `evil`@`%`', 'GRANT SELECT ON *.* TO `evil`@`%`'], ['shop'])).toEqual([
      "GRANT SELECT ON `db\\_%`.* TO 'evil'@'%'",
      "GRANT SELECT ON `shop`.* TO 'evil'@'%'",
      "REVOKE SELECT ON *.* FROM 'evil'@'%'",
    ]);
  });

  it('a run cut off anywhere leaves MORE than the target, never less: every GRANT precedes every REVOKE', () => {
    const out = narrow([
      'GRANT SELECT, INSERT, FILE ON *.* TO `evil`@`%` WITH GRANT OPTION',
      'GRANT SELECT ON `mysql`.`user` TO `evil`@`%`',
      'GRANT ALL PRIVILEGES ON `m%`.* TO `evil`@`%`',
      'GRANT PROXY ON `root`@`localhost` TO `evil`@`%`',
      'GRANT `root`@`localhost` TO `evil`@`%`',
    ]);
    const firstRevoke = out.findIndex((st) => st.startsWith('REVOKE'));
    expect(firstRevoke).toBeGreaterThan(0);
    expect(out.slice(firstRevoke).every((st) => st.startsWith('REVOKE'))).toBe(true);
    expect(out.slice(0, firstRevoke).every((st) => st.startsWith('GRANT '))).toBe(true);
    // and no REVOKE ALL, which would leave the account with nothing — and "safe"
    expect(out.some((st) => /^REVOKE ALL PRIVILEGES, GRANT OPTION/.test(st))).toBe(false);
  });

  it('an account narrowed by a run is safe by the next: a second pass over what is left changes nothing', () => {
    const left = [
      "GRANT PROCESS ON *.* TO `evil`@`%` IDENTIFIED BY PASSWORD '*AA'",
      'GRANT SELECT, INSERT ON `db\\_%`.* TO `evil`@`%`',
      'GRANT SELECT, INSERT ON `shop`.* TO `evil`@`%`',
    ];
    expect(narrow(left)).toEqual([]);
  });

  it('a grant it cannot read: everything is revoked and the readable safe grants come back', () => {
    expect(narrow([
      'GRANT PROCESS ON *.* TO `evil`@`%`',
      'GRANT `r1` TO `evil`@`%`',
      'GRANT ALL PRIVILEGES ON `shop`.* TO `evil`@`%`',
      'GRANT SELECT ON *.`t` TO `evil`@`%`',
      'GRANT FILE ON *.* TO `evil`@`%`',
    ], ['shop'])).toEqual([
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'evil'@'%'",
      'GRANT `r1` TO `evil`@`%`',
      'GRANT ALL PRIVILEGES ON `shop`.* TO `evil`@`%`',
    ]);
  });

  it('with an unreadable grant, the unsafe readable ones are still narrowed to tenant databases', () => {
    expect(narrow(['GRANT SELECT ON *.`t` TO `evil`@`%`', 'GRANT ALL PRIVILEGES ON `m%`.* TO `evil`@`%`'], ['mydb'])).toEqual([
      "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'evil'@'%'",
      "GRANT ALL PRIVILEGES ON `mydb`.* TO 'evil'@'%'",
    ]);
    expect(narrow(['totally unparseable'])).toEqual(["REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'evil'@'%'"]);
  });

  it('a database pattern that cannot reach a system schema stays as it is, even where it matches no database yet', () => {
    expect(narrow(['GRANT ALL PRIVILEGES ON `zzz%`.* TO `evil`@`%`', 'GRANT SUPER ON *.* TO `evil`@`%`'], ['shop'])).toEqual([
      "REVOKE SUPER ON *.* FROM 'evil'@'%'",
    ]);
  });

  it('MariaDB PUBLIC is narrowed under its own name', () => {
    expect(narrowingStatements('PUBLIC', [parseGrant('GRANT SELECT ON `mysql`.* TO PUBLIC')], [])).toEqual(['REVOKE ALL PRIVILEGES ON `mysql`.* FROM PUBLIC']);
  });
});

describe('allDatabasesGrants', () => {
  it('is ALL on the prefix and on each tenant database, matched literally', () => {
    expect(allDatabasesGrants("'u'@'%'", ['shop', 'my_app'])).toEqual([
      "GRANT ALL PRIVILEGES ON `db\\_%`.* TO 'u'@'%'",
      "GRANT ALL PRIVILEGES ON `shop`.* TO 'u'@'%'",
      "GRANT ALL PRIVILEGES ON `my\\_app`.* TO 'u'@'%'",
    ]);
  });
  it('never *.*', () => {
    expect(allDatabasesGrants("'u'@'%'", []).join(';')).not.toContain('*.*');
  });
});

describe('accountSql', () => {
  it('quotes user and host as identifiers (no sql_mode changes that), or a role by name', () => {
    expect(accountSql("o'neil", '%')).toBe("`o'neil`@`%`");
    expect(accountSql('', 'localhost')).toBe('``@`localhost`');
    expect(accountSql('r`1', null)).toBe('`r``1`');
  });
});

describe('withDefiner', () => {
  it('replaces the definer of a procedure', () => {
    expect(withDefiner('CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1', "'dbadmin'@'%'", false))
      .toBe("CREATE DEFINER='dbadmin'@'%' PROCEDURE `p`() SELECT 1");
  });

  it('replaces the definer of a trigger and a function (MariaDB writes OR REPLACE when asked)', () => {
    expect(withDefiner('CREATE DEFINER=`root`@`%` TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.a = 1', "'a'@'%'", false))
      .toBe("CREATE DEFINER='a'@'%' TRIGGER `t` BEFORE INSERT ON `x` FOR EACH ROW SET NEW.a = 1");
    expect(withDefiner('CREATE DEFINER=`root`@`localhost` FUNCTION `f`() RETURNS int RETURN 1', "'a'@'%'", true))
      .toBe("CREATE OR REPLACE DEFINER='a'@'%' FUNCTION `f`() RETURNS int RETURN 1");
  });

  it('keeps the ALGORITHM clause of a view, with and without it', () => {
    expect(withDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1', "'a'@'%'", true))
      .toBe("CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER='a'@'%' SQL SECURITY DEFINER VIEW `v` AS select 1");
    expect(withDefiner('CREATE DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1', "'a'@'%'", true))
      .toBe("CREATE OR REPLACE DEFINER='a'@'%' SQL SECURITY DEFINER VIEW `v` AS select 1");
  });

  it('does not duplicate an OR REPLACE the statement already has', () => {
    expect(withDefiner('CREATE OR REPLACE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1', "'a'@'%'", true))
      .toBe("CREATE OR REPLACE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
    expect(withDefiner('CREATE OR REPLACE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1', "'a'@'%'", false))
      .toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
  });

  it('keeps the original definer when told to (null): the statement is only re-issued', () => {
    expect(withDefiner('CREATE DEFINER=`app`@`%` TRIGGER `t` AFTER INSERT ON `x` FOR EACH ROW SET @a = 1', null, false))
      .toBe('CREATE DEFINER=`app`@`%` TRIGGER `t` AFTER INSERT ON `x` FOR EACH ROW SET @a = 1');
    expect(withDefiner("CREATE DEFINER='a b'@'h' PROCEDURE `p`() SELECT 1", null, true))
      .toBe("CREATE OR REPLACE DEFINER='a b'@'h' PROCEDURE `p`() SELECT 1");
  });

  it('reads a quoted definer holding a backtick, a quote or spaces', () => {
    expect(withDefiner('CREATE DEFINER=`ro``ot`@`local host` PROCEDURE `p`() SELECT 1', "'a'@'%'", false))
      .toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
    expect(withDefiner("CREATE DEFINER='o\\'neil'@'%' PROCEDURE `p`() SELECT 1", "'a'@'%'", false))
      .toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
  });

  it('reads CURRENT_USER and a bare user', () => {
    expect(withDefiner('CREATE DEFINER=CURRENT_USER PROCEDURE `p`() SELECT 1', "'a'@'%'", false)).toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
    expect(withDefiner('CREATE DEFINER = root@localhost PROCEDURE `p`() SELECT 1', "'a'@'%'", false)).toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT 1");
  });

  it('a body that mentions DEFINER later is left alone', () => {
    const create = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT "DEFINER=`x`@`y` ";';
    expect(withDefiner(create, "'a'@'%'", false)).toBe("CREATE DEFINER='a'@'%' PROCEDURE `p`() SELECT \"DEFINER=`x`@`y` \";");
  });

  it('is null for a definition with no DEFINER clause to replace', () => {
    expect(withDefiner('CREATE PROCEDURE `p`() SELECT 1', "'a'@'%'", false)).toBeNull();
    expect(withDefiner('CREATE VIEW `v` AS select 1', null, true)).toBeNull();
    expect(withDefiner('', null, false)).toBeNull();
  });
});

// ─── A fake server ──────────────────────────────────────────────────────────

interface Call { readonly argv: string[]; readonly stdin?: string; readonly text: string }

/** What a statement is: the -e argument, or the script on stdin. */
function textOf(argv: string[], stdin?: string): string {
  const e = argv.indexOf('-e');
  return e >= 0 ? argv[e + 1]! : (stdin ?? argv.join(' '));
}

function fake(answer: (c: Call) => string | Error | undefined): { calls: Call[]; scripts: string[]; run: DbCommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    get scripts() { return calls.filter((c) => c.stdin !== undefined).map((c) => c.text); },
    run: async (_ctx, argv, stdin) => {
      const call = { argv, stdin, text: textOf(argv, stdin) };
      calls.push(call);
      const a = answer(call);
      if (a instanceof Error) throw a;
      return { stdout: a ?? '', stderr: '' };
    },
  };
}

function ctx(engine: 'mariadb' | 'mysql'): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine, rootPassword: '', rootUsername: 'root' };
}

const SCHEMATA = ['information_schema', 'mysql', 'performance_schema', 'sys', 'shop', 'my_app'].map(X).join('\n');

describe('narrowAccounts', () => {
  const server = (engine: 'mariadb' | 'mysql', grants: Record<string, string>, mandatory = '', persisted = 'NULL') => fake(({ text }) => {
    if (text.includes('information_schema.SCHEMATA')) return SCHEMATA;
    if ((text.includes('FROM mysql.user') && text.includes('IF('))) {
      return [['root', 'localhost'], ['mariadb.sys', 'localhost'], ['evil', '%'], ['clean', '%'], ['dbadmin', '%']]
        .map(([u, h]) => `${X(u!)}\t${X(h!)}\tU`).join('\n');
    }
    if (text === 'SHOW GRANTS FOR PUBLIC') return engine === 'mariadb' ? "GRANT USAGE ON *.* TO PUBLIC\n" : new DbExecError("ERROR 1064: syntax error near 'PUBLIC'");
    const m = /^SHOW GRANTS FOR (.*)$/.exec(text);
    if (m) return grants[m[1]!] ?? '';
    if (text.includes('performance_schema.persisted_variables')) return persisted;
    if (text.includes('@@GLOBAL.mandatory_roles')) return mandatory;
    return undefined;
  });

  const grants = {
    '`evil`@`%`': "GRANT SELECT, FILE ON *.* TO `evil`@`%` IDENTIFIED BY PASSWORD '*9319'\nGRANT SELECT ON `mysql`.`user` TO `evil`@`%`\n",
    '`clean`@`%`': "GRANT USAGE ON *.* TO `clean`@`%`\nGRANT ALL PRIVILEGES ON `shop`.* TO `clean`@`%`\n",
  };

  it('narrows only the accounts that need it, never root, a server account or the one skipped', async () => {
    const s = server('mariadb', grants);
    const changed = await narrowAccounts({ ctx: ctx('mariadb'), run: s.run }, new Set(['dbadmin']));
    expect(changed).toEqual(['narrowed evil@% to its tenant databases (it held global or system-schema privileges)']);
    expect(s.scripts).toHaveLength(1);
    expect(s.scripts[0]).toBe([
      "GRANT SELECT ON `db\\_%`.* TO `evil`@`%`",
      "GRANT SELECT ON `shop`.* TO `evil`@`%`",
      "GRANT SELECT ON `my\\_app`.* TO `evil`@`%`",
      "REVOKE SELECT, FILE ON *.* FROM `evil`@`%`",
      "REVOKE SELECT ON `mysql`.`user` FROM `evil`@`%`",
      '',
    ].join(';\n'));
    const asked = s.calls.map((c) => c.text).filter((t) => t.startsWith('SHOW GRANTS'));
    // PUBLIC is probed first (does this server have one?), then read like the others.
    expect(asked).toEqual(['SHOW GRANTS FOR PUBLIC', 'SHOW GRANTS FOR `evil`@`%`', 'SHOW GRANTS FOR `clean`@`%`', 'SHOW GRANTS FOR PUBLIC']);
  });

  it('a second run over a narrowed account changes nothing', async () => {
    const s = server('mariadb', {
      '`evil`@`%`': 'GRANT SELECT ON `shop`.* TO `evil`@`%`\n',
      '`clean`@`%`': 'GRANT USAGE ON *.* TO `clean`@`%`\n',
    });
    expect(await narrowAccounts({ ctx: ctx('mariadb'), run: s.run }, new Set(['dbadmin']))).toEqual([]);
    expect(s.scripts).toEqual([]);
  });

  it('MariaDB: what is granted to PUBLIC every account holds, so PUBLIC is narrowed too', async () => {
    const only = fake(({ text }) => {
      if (text.includes('information_schema.SCHEMATA')) return SCHEMATA;
      if (text.includes('FROM mysql.user')) return '';
      if (text === 'SHOW GRANTS FOR PUBLIC') return 'GRANT SELECT ON `mysql`.`user` TO PUBLIC\n';
      return undefined;
    });
    const changed = await narrowAccounts({ ctx: ctx('mariadb'), run: only.run }, new Set());
    expect(changed).toEqual(['narrowed PUBLIC to its tenant databases (it held global or system-schema privileges)']);
    expect(only.scripts[0]).toBe('REVOKE SELECT ON `mysql`.`user` FROM PUBLIC;\n');
  });

  it('MySQL has no PUBLIC to read', async () => {
    const s = server('mysql', grants);
    await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin']));
    expect(s.calls.some((c) => c.text === 'SHOW GRANTS FOR PUBLIC')).toBe(false);
  });

  it('MySQL: whatever root persisted (it applies again at every start) is reset, by name', async () => {
    const s = server('mysql', {}, '', 'init_connect,mandatory_roles');
    const changed = await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin', 'evil', 'clean']));
    expect(changed).toEqual(['removed the persisted server settings (init_connect,mandatory_roles)']);
    expect(s.calls.some((c) => c.text === 'RESET PERSIST')).toBe(true);
  });

  it('MySQL: nothing persisted, nothing reset', async () => {
    const s = server('mysql', {}, '', 'NULL');
    expect(await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin', 'evil', 'clean']))).toEqual([]);
    expect(s.calls.some((c) => c.text.startsWith('RESET PERSIST'))).toBe(false);
  });

  it('MySQL: only the server accounts leave mandatory_roles, in the running server first (SET GLOBAL), then the persisted ones go', async () => {
    const s = server('mysql', {}, "`root`@`localhost`,`app_role`@`%`,'mysql.sys'@'localhost'", 'mandatory_roles');
    const changed = await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin', 'evil', 'clean']));
    expect(changed).toEqual([
      'removed a server account from mandatory_roles (every account held it)',
      'removed the persisted server settings (mandatory_roles)',
    ]);
    const texts = s.calls.map((c) => c.text);
    expect(texts).toContain("SET GLOBAL mandatory_roles = '`app_role`@`%`'");
    expect(texts.some((t) => t.startsWith('SET PERSIST'))).toBe(false);
    expect(texts.indexOf("SET GLOBAL mandatory_roles = '`app_role`@`%`'")).toBeLessThan(texts.indexOf('RESET PERSIST'));
  });

  it('MySQL: untouched mandatory_roles are left alone', async () => {
    const s = server('mysql', {}, '`app_role`@`%`');
    expect(await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin', 'evil', 'clean']))).toEqual([]);
    expect(s.calls.some((c) => c.text.startsWith('SET GLOBAL'))).toBe(false);
  });

  it('an account whose name holds a quote is addressed with it escaped', async () => {
    const s = fake(({ text }) => {
      if (text.includes('information_schema.SCHEMATA')) return SCHEMATA;
      if (text.includes('FROM mysql.user')) return `${X("o'brien")}\t${X('%')}\tU`;
      if (text.startsWith('SHOW GRANTS FOR ')) return 'GRANT FILE ON *.* TO `o\'brien`@`%`\n';
      return undefined;
    });
    await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set());
    expect(s.calls.map((c) => c.text)).toContain("SHOW GRANTS FOR `o'brien`@`%`");
    expect(s.scripts[0]).toBe("REVOKE FILE ON *.* FROM `o'brien`@`%`;\n");
  });

  describe('which accounts are listed', () => {
    const listing = (rows: Array<[string, string]>) => fake(({ text }) => {
      if (text.includes('information_schema.SCHEMATA')) return SCHEMATA;
      if (text.includes('FROM mysql.user')) return rows.map(([u, h]) => `${X(u)}\t${X(h)}\tU`).join('\n');
      if (text.startsWith('SHOW GRANTS FOR ')) return 'GRANT USAGE ON *.* TO x\n';
      return undefined;
    });
    const asked = (s: ReturnType<typeof listing>): string[] => s.calls.map((c) => c.text).filter((t) => t.startsWith('SHOW GRANTS'));

    it('a server account is skipped only at localhost: root@% is somebody else\'s account', async () => {
      const s = listing([['root', 'localhost'], ['root', '%'], ['mariadb.sys', 'localhost'], ['mariadb.sys', '10.0.0.1']]);
      await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set());
      expect(asked(s)).toEqual(['SHOW GRANTS FOR `root`@`%`', 'SHOW GRANTS FOR `mariadb.sys`@`10.0.0.1`']);
    });

    it('the skipped tenant administrator is skipped only at %', async () => {
      const s = listing([['dbadmin', '%'], ['dbadmin', 'localhost'], ['dbadmin', '127.0.0.1']]);
      await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set(['dbadmin']));
      expect(asked(s)).toEqual(['SHOW GRANTS FOR `dbadmin`@`localhost`', 'SHOW GRANTS FOR `dbadmin`@`127.0.0.1`']);
    });

    it('an anonymous account is dropped, not narrowed (it would stand in for any user name)', async () => {
      const s = listing([['', '127.0.0.1'], ['', 'localhost']]);
      const changed = await narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set());
      expect(changed).toEqual(['dropped the anonymous account @127.0.0.1', 'dropped the anonymous account @localhost']);
      expect(s.calls.map((c) => c.text)).toEqual(expect.arrayContaining(['DROP USER ``@`127.0.0.1`', 'DROP USER ``@`localhost`']));
      expect(asked(s)).toEqual([]);
    });
  });

  it('a failing statement is an error, not a silent skip', async () => {
    const s = fake(({ text, stdin }) => {
      if (text.includes('information_schema.SCHEMATA')) return SCHEMATA;
      if (text.includes('FROM mysql.user')) return `${X('evil')}\t${X('%')}\tU`;
      if (text.startsWith('SHOW GRANTS FOR ')) return 'GRANT FILE ON *.* TO `evil`@`%`\n';
      return stdin ? new DbExecError('ERROR 1045 (28000): Access denied') : undefined;
    });
    await expect(narrowAccounts({ ctx: ctx('mysql'), run: s.run }, new Set())).rejects.toThrow(DbExecError);
  });
});

describe('ensureAllDatabasesAccounts', () => {
  const db = (rows: Array<[string, string, string]>, dbs = SCHEMATA) => fake(({ text }) => {
    if (text.includes('FROM mysql.db')) return rows.map((r) => r.map(X).join('\t')).join('\n');
    if (text.includes('information_schema.SCHEMATA')) return dbs;
    return undefined;
  });

  it('does nothing when no account holds the prefix grant', async () => {
    const s = db([['u', '%', 'shop']]);
    expect(await ensureAllDatabasesAccounts({ ctx: ctx('mariadb'), run: s.run })).toEqual([]);
    expect(s.scripts).toEqual([]);
  });

  it('grants the databases an "all databases" account lacks, and only those', async () => {
    const s = db([['all', '%', PREFIX_PATTERN], ['all', '%', 'shop'], ['other', '%', 'my\\_app']]);
    const changed = await ensureAllDatabasesAccounts({ ctx: ctx('mariadb'), run: s.run });
    expect(changed).toEqual(['granted 1 database(s) to the "all databases" accounts']);
    expect(s.scripts).toEqual(["GRANT ALL PRIVILEGES ON `my\\_app`.* TO `all`@`%`;\n"]);
  });

  it('databases under the db_ prefix are covered by the prefix grant and never granted one by one', async () => {
    const schemas = ['mysql', 'shop', 'db_blog', 'db_x'].map(X).join('\n');
    const s = db([['all', '%', PREFIX_PATTERN], ['all', '%', 'shop']], schemas);
    expect(await ensureAllDatabasesAccounts({ ctx: ctx('mariadb'), run: s.run })).toEqual([]);
    expect(s.scripts).toEqual([]);
    expect(allDatabasesGrants('`u`@`%`', ['shop', 'db_blog', 'DB_up'])).toEqual([
      'GRANT ALL PRIVILEGES ON `db\\_%`.* TO `u`@`%`',
      'GRANT ALL PRIVILEGES ON `shop`.* TO `u`@`%`',
      // grant patterns match case-sensitively: DB_ is not under db_
      'GRANT ALL PRIVILEGES ON `DB\\_up`.* TO `u`@`%`',
    ]);
  });

  it('is idempotent once every database is held', async () => {
    const s = db([['all', '%', PREFIX_PATTERN], ['all', '%', 'shop'], ['all', '%', 'my\\_app']]);
    expect(await ensureAllDatabasesAccounts({ ctx: ctx('mariadb'), run: s.run })).toEqual([]);
  });

  it('counts a grant held under another host as not held', async () => {
    const s = db([['all', '%', PREFIX_PATTERN], ['all', 'localhost', 'shop'], ['all', '%', 'my\\_app']]);
    const changed = await ensureAllDatabasesAccounts({ ctx: ctx('mariadb'), run: s.run });
    expect(changed).toHaveLength(1);
    expect(s.scripts[0]).toBe("GRANT ALL PRIVILEGES ON `shop`.* TO `all`@`%`;\n");
  });
});

describe('adoptRootDefinedObjects', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  const ADMIN = '`dbadmin`@`%`';

  interface Objects {
    objects?: string[];
    systemObjects?: string[];
    triggers?: Array<[schema: string, name: string, table: string, root: boolean]>;
    create?: Record<string, string>;
    grants?: string;
    /** 1-based: which scripts the server refuses. */
    failScripts?: number[];
  }

  function server(o: Objects) {
    let scriptsSeen = 0;
    return fake(({ text, stdin }) => {
      // root's objects in the server's own schemas are asked first
      if (text.includes("FROM information_schema.ROUTINES WHERE SUBSTRING_INDEX(DEFINER, '@', 1) = 'root'")) return (o.systemObjects ?? []).join('\n');
      if (text.includes('FROM information_schema.ROUTINES')) return (o.objects ?? []).join('\n');
      if (text.includes('EVENT_OBJECT_TABLE')) {
        return (o.triggers ?? []).map(([s, n, t, r]) => [X(s), X(n), X(t), 'BEFORE', 'INSERT', r ? '1' : '0'].join('\t')).join('\n');
      }
      if (text.includes('FROM information_schema.TRIGGERS')) {
        return (o.triggers ?? []).filter((t) => t[3]).map(([s, n]) => `${X(s)}\t${X(n)}`).join('\n');
      }
      const sc = /^SHOW CREATE (\w+) `([^`]+)`\.`([^`]+)`$/.exec(text);
      if (sc) return o.create?.[`${sc[1]}:${sc[2]}.${sc[3]}`] ?? '';
      if (text.includes('mysql.procs_priv')) return o.grants ?? '';
      if (stdin !== undefined) {
        scriptsSeen += 1;
        if (o.failScripts?.includes(scriptsSeen)) return new DbExecError('ERROR 1419 (HY000): You do not have the SUPER privilege and binary logging is enabled');
      }
      return undefined;
    });
  }

  const viewCreate = 'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `a`';
  const viewRow = `v\t${viewCreate}\tutf8mb4\tutf8mb4_general_ci`;

  it('a root-defined view is re-created OR REPLACE with the tenant administrator as definer', async () => {
    const s = server({ objects: [`VIEW\t${X('shop')}\t${X('v')}\tx`], create: { 'VIEW:shop.v': viewRow } });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(changed).toEqual(['the view shop.v now runs as the tenant administrator (it ran as root)']);
    const script = s.scripts[0]!;
    expect(script).toContain('SET NAMES utf8mb4;');
    expect(script).toContain("SET collation_connection = 'utf8mb4_general_ci';");
    expect(script).toContain('USE `shop`;');
    // a view carries no sql_mode of its own; the session goes back to the default before any GRANT
    expect(script).not.toMatch(/sql_mode = '(?!')/);
    expect(script).toContain("DELIMITER ;\nSET SESSION sql_mode = '';");
    expect(script).toContain("CREATE OR REPLACE ALGORITHM=UNDEFINED DEFINER=`dbadmin`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1 AS `a`");
    expect(script).not.toContain('root');
  });

  it('the delimiter is at most 15 characters (the client keeps no more), differs per script and does not occur in the body', async () => {
    const s = server({ objects: [`VIEW\t${X('shop')}\t${X('v')}\tx`], create: { 'VIEW:shop.v': viewRow } });
    await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    const tokens = s.scripts.map((sc) => /^DELIMITER (\S+)$/m.exec(sc)![1]!);
    expect(tokens).toHaveLength(2);
    for (const t of tokens) {
      expect(t.length).toBeLessThanOrEqual(15);
      expect(t).toMatch(/^\$\$[0-9a-f]+$/);
    }
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(s.scripts[0]).toMatch(new RegExp(`${tokens[0]!.replace(/\$/g, '\\$')}\\nDELIMITER ;`));
  });

  it('a routine: sql_mode restored, MariaDB replaces in place, the grants on it come back', async () => {
    const create = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\\nBEGIN\\n  SELECT 1;\\nEND';
    const s = server({
      objects: [`PROCEDURE\t${X('shop')}\t${X('p')}\tx`],
      create: { 'PROCEDURE:shop.p': `p\tSTRICT_TRANS_TABLES\t${create}\tutf8mb4\tutf8mb4_general_ci\tutf8mb4_unicode_ci` },
      grants: `${X('app')}\t${X('%')}\tExecute,Alter Routine,Grant`,
    });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(changed).toEqual(['the procedure shop.p now runs as the tenant administrator (it ran as root)']);
    const script = s.scripts[0]!;
    expect(script).toContain("SET SESSION sql_mode = 'STRICT_TRANS_TABLES';");
    // the object's mode may hold NO_BACKSLASH_ESCAPES: the grants after it are quoted for the default
    expect(script.indexOf("SET SESSION sql_mode = '';")).toBeGreaterThan(script.indexOf('DELIMITER ;'));
    expect(script.indexOf("SET SESSION sql_mode = '';")).toBeLessThan(script.indexOf('GRANT EXECUTE'));
    expect(script).toContain("CREATE OR REPLACE DEFINER=`dbadmin`@`%` PROCEDURE `p`()\nBEGIN\n  SELECT 1;\nEND");
    expect(script).not.toContain('DROP PROCEDURE');
    expect(script).toContain("GRANT EXECUTE, ALTER ROUTINE ON PROCEDURE `shop`.`p` TO `app`@`%` WITH GRANT OPTION;");
  });

  it('MySQL drops a routine first (it has no OR REPLACE) and re-issues the grants it dropped with it', async () => {
    const s = server({
      objects: [`FUNCTION\t${X('shop')}\t${X('f')}\tx`],
      create: { 'FUNCTION:shop.f': 'f\t\tCREATE DEFINER=`root`@`localhost` FUNCTION `f`() RETURNS int RETURN 1\tutf8mb4\tutf8mb4_0900_ai_ci\tutf8mb4_0900_ai_ci' },
      grants: `${X('app')}\t${X('%')}\tExecute`,
    });
    await adoptRootDefinedObjects({ ctx: ctx('mysql'), run: s.run }, ADMIN);
    const script = s.scripts[0]!;
    expect(script).toMatch(/DROP FUNCTION IF EXISTS `shop`\.`f`\$\$[0-9a-f]+\n/);
    expect(script).toContain("CREATE DEFINER=`dbadmin`@`%` FUNCTION `f`() RETURNS int RETURN 1");
    expect(script).not.toContain('OR REPLACE');
    expect(script).toContain("GRANT EXECUTE ON FUNCTION `shop`.`f` TO `app`@`%`;");
    expect(script).not.toContain('WITH GRANT OPTION');
  });

  it('MySQL: a view is still replaced in place, not dropped', async () => {
    const s = server({ objects: [`VIEW\t${X('shop')}\t${X('v')}\tx`], create: { 'VIEW:shop.v': viewRow } });
    await adoptRootDefinedObjects({ ctx: ctx('mysql'), run: s.run }, ADMIN);
    expect(s.scripts[0]).toContain('CREATE OR REPLACE');
    expect(s.scripts[0]).not.toContain('DROP VIEW');
  });

  it('MySQL: when the CREATE fails after the DROP, the object is dropped for good and the definition logged', async () => {
    const s = server({
      objects: [`PROCEDURE\t${X('shop')}\t${X('p')}\tx`],
      create: { 'PROCEDURE:shop.p': 'p\t\tCREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1\tutf8mb4\tutf8mb4_0900_ai_ci\tx' },
      failScripts: [1],
    });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mysql'), run: s.run }, ADMIN);
    // fail-closed: an object that cannot leave root is dropped, not put back
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^removed the procedure shop\.p: it ran as root and could not be re-created as the tenant administrator \(.*SUPER privilege.*\)/);
    expect(s.scripts).toHaveLength(1);
    expect(s.scripts[0]).toContain("DEFINER=`dbadmin`@`%`");
    expect(s.calls.map((c) => c.text)).toContain('DROP PROCEDURE IF EXISTS `shop`.`p`');
    expect(s.scripts.join('\n')).not.toContain('CREATE DEFINER=`root`');
    // its definition goes to the platform log, so an operator can hand it back
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() SELECT 1'));
  });

  it('a definition with no DEFINER clause to change is dropped (it cannot be moved off root), and logged', async () => {
    const s = server({ objects: [`VIEW\t${X('shop')}\t${X('v')}\tx`], create: { 'VIEW:shop.v': 'v\tCREATE VIEW `v` AS select 1\tutf8mb4\tutf8mb4_general_ci' } });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(changed).toEqual(['removed the view shop.v: it ran as root and its definition has no DEFINER clause to change (its definition is in the platform log)']);
    expect(s.scripts).toEqual([]);
    expect(s.calls.map((c) => c.text)).toContain('DROP VIEW IF EXISTS `shop`.`v`');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CREATE VIEW `v` AS select 1'));
  });

  it('an event is re-owned with ALTER DEFINER … COMMENT, its own comment re-stated', async () => {
    const s = server({ objects: [`EVENT\t${X('shop')}\t${X('e')}\t${X("nightly 'sweep'")}`] });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(changed).toEqual(['the event shop.e now runs as the tenant administrator (it ran as root)']);
    expect(s.calls.map((c) => c.text)).toContain("ALTER DEFINER = `dbadmin`@`%` EVENT `shop`.`e` COMMENT 'nightly \\'sweep\\''");
  });

  it('an event with no comment restates an empty one', async () => {
    const s = server({ objects: [`EVENT\t${X('shop')}\t${X('e')}\tx`] });
    await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(s.calls.map((c) => c.text)).toContain("ALTER DEFINER = `dbadmin`@`%` EVENT `shop`.`e` COMMENT ''");
  });

  it('a root trigger and every trigger after it in its group are re-created, in order; later ones keep their definer', async () => {
    const trig = (n: string, definer: string) => `${n}\t\tCREATE DEFINER=${definer} TRIGGER \`${n}\` BEFORE INSERT ON \`t\` FOR EACH ROW SET NEW.a = 1\tutf8mb4\tutf8mb4_general_ci`;
    const s = server({
      triggers: [['shop', 't1', 't', false], ['shop', 't2', 't', true], ['shop', 't3', 't', false]],
      create: {
        'TRIGGER:shop.t2': trig('t2', '`root`@`localhost`'),
        'TRIGGER:shop.t3': trig('t3', '`app`@`%`'),
      },
    });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    // t3 is only moved to keep the order: it is not reported as a change off root.
    expect(changed).toEqual(['the trigger shop.t2 now runs as the tenant administrator (it ran as root)']);
    expect(s.scripts).toHaveLength(2);
    expect(s.scripts[0]).toContain("DEFINER=`dbadmin`@`%` TRIGGER `t2`");
    expect(s.scripts[1]).toContain('DEFINER=`app`@`%` TRIGGER `t3`');
    expect(s.calls.map((c) => c.text)).not.toContain('SHOW CREATE TRIGGER `shop`.`t1`');
  });

  it('triggers none of which runs as root are left alone', async () => {
    const s = server({ triggers: [['shop', 't1', 't', false], ['shop', 't3', 't', false]] });
    expect(await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN)).toEqual([]);
    expect(s.scripts).toEqual([]);
  });

  it('nothing defined by root: nothing runs', async () => {
    const s = server({});
    expect(await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN)).toEqual([]);
    expect(s.scripts).toEqual([]);
  });

  it('the listing looks past the server schemas and at every server account as definer', async () => {
    const s = server({});
    await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    const listing = s.calls.find((c) => c.text.includes("ROUTINES WHERE SUBSTRING_INDEX(DEFINER, '@', 1) IN"))!.text;
    expect(listing).toContain("IN ('root', 'mariadb.sys', 'mysql.sys', 'mysql.session', 'mysql.infoschema')");
    expect(listing).toContain("NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')");
  });

  it('root-defined objects in the server\'s own schemas are dropped first: none of them is the server\'s', async () => {
    const s = server({ systemObjects: [`VIEW\t${X('mysql')}\t${X('sneaky')}`, `TRIGGER\t${X('sys')}\t${X('t')}`, `PROCEDURE\t${X('mysql')}\t${X('p')}`] });
    const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
    expect(changed).toEqual([
      "removed the view mysql.sneaky: it ran as root and sat in the server's own schema (its definition is in the platform log)",
      "removed the trigger sys.t: it ran as root and sat in the server's own schema (its definition is in the platform log)",
      "removed the procedure mysql.p: it ran as root and sat in the server's own schema (its definition is in the platform log)",
    ]);
    const texts = s.calls.map((c) => c.text);
    expect(texts).toContain('DROP VIEW IF EXISTS `mysql`.`sneaky`');
    expect(texts).toContain('DROP TRIGGER IF EXISTS `sys`.`t`');
    expect(texts).toContain('DROP PROCEDURE IF EXISTS `mysql`.`p`');
    const query = s.calls.find((c) => c.text.includes("= 'root' AND"))!.text;
    expect(query).toContain("IN ('information_schema', 'mysql', 'performance_schema', 'sys')");
  });

  it('a drop that itself fails is an error (the pass counts as not done and runs again)', async () => {
    const s = fake(({ text }) => (text.includes("= 'root' AND") ? `VIEW\t${X('mysql')}\t${X('v')}` : text.startsWith('DROP ') ? new DbExecError('ERROR 1142: denied') : undefined));
    await expect(adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN)).rejects.toThrow(DbExecError);
  });

  describe('a trigger re-created only to keep the order of its group', () => {
    const trig = (n: string, definer: string) => `${n}\t\tCREATE DEFINER=${definer} TRIGGER \`${n}\` BEFORE INSERT ON \`t\` FOR EACH ROW SET NEW.a = 1\tutf8mb4\tutf8mb4_general_ci`;
    const world = (failScripts: number[]) => server({
      triggers: [['shop', 't2', 't', true], ['shop', 't3', 't', false]],
      create: { 'TRIGGER:shop.t2': trig('t2', '`root`@`localhost`'), 'TRIGGER:shop.t3': trig('t3', '`app`@`%`') },
      failScripts,
    });

    it('that fails is put back as it was, and left in place with the reason', async () => {
      const s = world([2]);
      const changed = await adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN);
      expect(changed).toHaveLength(2);
      expect(changed[0]).toContain('the trigger shop.t2 now runs as the tenant administrator');
      expect(changed[1]).toMatch(/^could not re-create the trigger shop\.t3 to keep its trigger order; left in place: .*SUPER privilege/);
      expect(s.scripts).toHaveLength(3);
      expect(s.scripts[2]).toContain('DEFINER=`app`@`%` TRIGGER `t3`');
    });

    it('whose put-back fails too throws: the trigger is gone', async () => {
      const s = world([2, 3]);
      await expect(adoptRootDefinedObjects({ ctx: ctx('mariadb'), run: s.run }, ADMIN))
        .rejects.toThrow(/trigger shop\.t3 could not be re-created and is gone/);
    });
  });
});
