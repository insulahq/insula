/**
 * The statements the tenant administrator's setup sends, against a fake
 * runner. Behaviour against real servers (what the account can and cannot do)
 * was checked on MariaDB 10.11/12.3, MySQL 8.0/8.4/9.7, PostgreSQL 18 and
 * MongoDB 7 containers.
 */
import { describe, expect, it } from 'vitest';
import { chooseTenantAdminUsername, ensureTenantAdmin, setTenantAdminPassword, asTenantAdminMysql, tenantAdminLogsIn } from './tenant-admin.js';
import type { DbCommandRunner } from './db-exec.js';
import { DbExecError, type DbManagerContext } from './db-manager.js';
import { databaseHardeningSql } from './pg-hardening.js';
import { PREFIX_PATTERN } from './mysql-hardening.js';

const hex = (s: string): string => Buffer.from(s).toString('hex');

function ctx(engine: DbManagerContext['engine'], rootUsername = 'root', rootPassword = 'stored'): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine, rootPassword, rootUsername };
}

interface Call { readonly argv: string[]; readonly stdin?: string; readonly text: string; readonly database?: string }

/** What a command asks: the -e / --eval argument, psql's SQL, a shell line, or the script on stdin. */
function textOf(argv: string[], stdin?: string): string {
  const e = argv.indexOf('-e');
  if (e >= 0) return argv[e + 1]!;
  const ev = argv.indexOf('--eval');
  if (ev >= 0) return argv[ev + 1]!;
  if (argv[4] === 'psql') return argv[argv.length - 1]!;
  if (argv[0] === 'sh') return argv[2]!;
  return stdin ?? argv.join(' ');
}

/** Answers reads by pattern, records every command; `fail` makes a command throw. */
function recorder(answers: Array<[RegExp, string]> = [], fail: (c: Call) => boolean = () => false): { calls: Call[]; texts: string[]; scripts: string[]; run: DbCommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    get texts() { return calls.map((c) => c.text); },
    get scripts() { return calls.filter((c) => c.stdin !== undefined).map((c) => c.stdin!); },
    run: async (_c, argv, stdin) => {
      const call: Call = { argv, stdin, text: textOf(argv, stdin), database: argv[4] === 'psql' ? /^dbname='(.*)'$/.exec(argv[argv.indexOf('-d') + 1]!)?.[1] : undefined };
      calls.push(call);
      if (fail(call)) throw new DbExecError('ERROR 1045 (28000): Access denied');
      const hit = answers.find(([re]) => re.test(call.text));
      // An account in shape answers its login check with its own name at '%'.
      if (!hit && /^SELECT CURRENT_USER\(\)/.test(call.text)) return { stdout: 'dbadmin@%', stderr: '' };
      return { stdout: hit ? hit[1] : '', stderr: '' };
    },
  };
}

/** MariaDB / MySQL columns are read back behind an `x` sentinel. */
const X = (v: string): string => `x${hex(v)}`;
const SCHEMATA = ['information_schema', 'mysql', 'performance_schema', 'sys', 'shop', 'my_app'].map(X).join('\n');

describe('MariaDB / MySQL', () => {
  const account = { username: 'dbadmin', password: "pw-1'x" };

  it('a new instance: creates the account, grants the prefix and every tenant database (never *.*), then PROCESS', async () => {
    const r = recorder([
      [/^SELECT COUNT\(\*\) FROM mysql\.user WHERE User = 'dbadmin'/, '0'],
      [/^SELECT \(SELECT COUNT/, '0\tN'],
      [/information_schema\.SCHEMATA/, SCHEMATA],
    ]);
    const changed = await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ['created dbadmin'], problems: [] });
    expect(r.scripts[0]).toBe("CREATE USER IF NOT EXISTS 'dbadmin'@'%' IDENTIFIED BY 'pw-1\\'x';\n");
    expect(r.scripts[1]!.split(';\n').filter(Boolean)).toEqual([
      "GRANT ALL PRIVILEGES ON `db\\_%`.* TO 'dbadmin'@'%'",
      "GRANT ALL PRIVILEGES ON `shop`.* TO 'dbadmin'@'%'",
      "GRANT ALL PRIVILEGES ON `my\\_app`.* TO 'dbadmin'@'%'",
      "GRANT PROCESS ON *.* TO 'dbadmin'@'%'",
    ]);
    // The only global privilege is PROCESS: no *.* ALL, no CREATE USER, no GRANT OPTION.
    expect(r.scripts.join('\n').match(/ON \*\.\*/g)).toHaveLength(1);
    expect(r.scripts[1]).not.toMatch(/GRANT OPTION|CREATE USER|SUPER|FILE/);
  });

  it('the password reaches the server on stdin (a script), never in a -e argument', async () => {
    const r = recorder([[/^SELECT COUNT\(\*\) FROM mysql\.user/, '0'], [/^SELECT \(SELECT COUNT/, '0\tN'], [/SCHEMATA/, SCHEMATA]]);
    await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    for (const c of r.calls.filter((x) => x.stdin?.includes('pw-1'))) expect(c.argv).not.toContain('-e');
  });

  it('an account already in shape: nothing is created or granted', async () => {
    const r = recorder([
      [/^SELECT COUNT\(\*\) FROM mysql\.user WHERE User = 'dbadmin'/, '1'],
      [/^SELECT \(SELECT COUNT/, '1\tY'],
      [/FROM mysql\.db/, ''],
    ]);
    expect(await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run)).toEqual({ changes: [], problems: [] });
    expect(r.scripts).toEqual([]);
  });

  it('missing PROCESS (or the prefix grant) is re-granted, without reporting a change', async () => {
    const r = recorder([[/^SELECT COUNT\(\*\) FROM mysql\.user/, '1'], [/^SELECT \(SELECT COUNT/, '1\tN'], [/SCHEMATA/, SCHEMATA]]);
    await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(r.scripts).toHaveLength(1);
    expect(r.scripts[0]).toContain("GRANT PROCESS ON *.* TO 'dbadmin'@'%'");
  });

  it('sets the password back when the tenant changed it in SQL (the login over TCP is refused)', async () => {
    const r = recorder(
      [[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']],
      (c) => c.argv.includes('-udbadmin'),
    );
    const changed = await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ["set dbadmin's password back to the one in the panel"], problems: [] });
    expect(r.scripts).toEqual(["ALTER USER 'dbadmin'@'%' IDENTIFIED BY 'pw-1\\'x';\n"]);
  });

  it('checks the login the way a tenant\'s tool logs in: TCP to 127.0.0.1, as the account', async () => {
    const r = recorder([[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']]);
    await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    const login = r.calls.find((c) => c.argv.includes('-udbadmin'))!;
    expect(login.argv.slice(0, 5)).toEqual(['mariadb', '-udbadmin', "-ppw-1'x", '-h127.0.0.1', '--protocol=TCP']);
    // and it must be the account the platform made, not a more specific lookalike
    expect(login.argv.slice(-4)).toEqual(['--batch', '--skip-column-names', '-e', 'SELECT CURRENT_USER()']);
  });

  it('on MySQL the client is mysql and asks for the server\'s RSA key', async () => {
    expect(asTenantAdminMysql(ctx('mysql'), account, ['-e', 'x'])).toEqual(['mysql', '-udbadmin', "-ppw-1'x", '-h127.0.0.1', '--protocol=TCP', '--get-server-public-key', '-e', 'x']);
    expect(asTenantAdminMysql(ctx('mariadb'), account)).not.toContain('--get-server-public-key');
  });

  it('a database created before the first check reaches an "all databases" account that lacks it', async () => {
    const r = recorder([
      [/^SELECT COUNT/, '1'],
      [/^SELECT \(SELECT COUNT/, '1\tY'],
      [/FROM mysql\.db$/, [['allusr', '%', PREFIX_PATTERN], ['allusr', '%', 'shop']].map((row) => row.map(X).join('\t')).join('\n')],
      [/SCHEMATA/, SCHEMATA],
    ]);
    const changed = await ensureTenantAdmin(ctx('mysql'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ['granted 1 database(s) to the "all databases" accounts'], problems: [] });
    expect(r.scripts).toEqual(["GRANT ALL PRIVILEGES ON `my\\_app`.* TO `allusr`@`%`;\n"]);
  });

  it('without harden the other accounts and the root-defined objects are left alone', async () => {
    const r = recorder([[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']]);
    await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(r.texts.some((t) => t.startsWith('SHOW GRANTS') || t.includes('information_schema.ROUTINES'))).toBe(false);
  });

  it('with harden the account comes first (its own login never waits on hardening), then other accounts are narrowed, then root-defined objects adopted', async () => {
    const r = recorder([[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']]);
    await ensureTenantAdmin(ctx('mariadb'), account, { harden: true }, r.run);
    const t = r.texts;
    const exists = t.findIndex((x) => x.startsWith("SELECT COUNT(*) FROM mysql.user WHERE User = 'dbadmin'"));
    const narrowed = t.findIndex((x) => x.includes('FROM mysql.user') && x.includes('IF('));
    const adopt = t.findIndex((x) => x.includes('information_schema.ROUTINES'));
    expect(exists).toBeGreaterThanOrEqual(0);
    expect(narrowed).toBeGreaterThan(exists);
    expect(adopt).toBeGreaterThan(narrowed);
  });

  it('the tenant administrator itself is never narrowed', async () => {
    const r = recorder([
      [/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY'],
      [/IF\(.*FROM mysql\.user/, [['dbadmin', '%'], ['other', '%']].map(([u, h]) => `${X(u!)}\t${X(h!)}\tU`).join('\n')],
    ]);
    await ensureTenantAdmin(ctx('mysql'), account, { harden: true }, r.run);
    const asked = r.texts.filter((t) => t.startsWith('SHOW GRANTS'));
    expect(asked).toEqual(['SHOW GRANTS FOR `other`@`%`']);
  });

  it('a failing hardening step is a problem, not a failure: the account is up, the other steps still run', async () => {
    const r = recorder(
      [[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']],
      (c) => c.text.includes('FROM mysql.user') && c.text.includes('IF('),
    );
    const result = await ensureTenantAdmin(ctx('mariadb'), account, { harden: true }, r.run);
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual(['narrowing accounts: ERROR 1045 (28000): Access denied']);
    // the next step (root-defined objects) still ran
    expect(r.texts.some((t) => t.includes('information_schema.ROUTINES'))).toBe(true);
  });

  it('a failing object adoption is a problem too, and the "all databases" accounts are still kept up', async () => {
    const r = recorder([[/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY']], (c) => c.text.includes('information_schema.ROUTINES'));
    const result = await ensureTenantAdmin(ctx('mariadb'), account, { harden: true }, r.run);
    expect(result.problems).toEqual(['objects that ran as root: ERROR 1045 (28000): Access denied']);
    expect(r.texts.some((t) => t.includes('FROM mysql.db'))).toBe(true);
  });

  it('other hosts of the administrator\'s name are dropped on every check, before anything else', async () => {
    const r = recorder([
      [/AND Host <> '%'$/, ['127.0.0.1', 'localhost'].map(X).join('\n')],
      [/^SELECT COUNT/, '1'], [/^SELECT \(SELECT COUNT/, '1\tY'],
    ]);
    const result = await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(result.changes).toEqual([
      "dropped dbadmin@127.0.0.1 (it would answer the tenant administrator's logins)",
      "dropped dbadmin@localhost (it would answer the tenant administrator's logins)",
    ]);
    expect(r.texts.slice(0, 3)).toEqual([expect.stringContaining("AND Host <> '%'"), 'DROP USER `dbadmin`@`127.0.0.1`', 'DROP USER `dbadmin`@`localhost`']);
  });

  it('only the account at exactly % counts as existing', async () => {
    const r = recorder([[/AND Host = '%'$/, '0'], [/^SELECT \(SELECT COUNT/, '1\tY']]);
    const result = await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(result.changes).toEqual(['created dbadmin']);
  });

  it('a login that answers as another account (a lookalike) is not the account: the password is set again', async () => {
    const r = recorder([[/^SELECT COUNT/, '1'], [/^SELECT CURRENT_USER/, 'dbadmin@127.0.0.1'], [/^SELECT \(SELECT COUNT/, '1\tY']]);
    const result = await ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run);
    expect(result.changes).toEqual(["set dbadmin's password back to the one in the panel"]);
  });

  it('an account that cannot be created is still a failure', async () => {
    const r = recorder([[/^SELECT COUNT/, '0']], (c) => (c.stdin ?? '').startsWith('CREATE USER'));
    await expect(ensureTenantAdmin(ctx('mariadb'), account, { harden: true }, r.run)).rejects.toThrow(DbExecError);
  });

  it('a server error surfaces as DbExecError', async () => {
    const r = recorder([], () => true);
    await expect(ensureTenantAdmin(ctx('mariadb'), account, { harden: false }, r.run)).rejects.toThrow(DbExecError);
  });
});

describe('PostgreSQL', () => {
  const account = { username: 'dbadmin', password: 'pw-2' };
  const dbRows = (rows: Array<[string, string, boolean]>): string => rows.map(([n, o, su]) => `${hex(n)},${hex(o)},${su}`).join('\n');
  const world = (opts: { exists?: boolean; dbs: Array<[string, string, boolean]>; apps?: string[] }): Array<[RegExp, string]> => [
    [/^SELECT COUNT\(\*\) FROM pg_catalog\.pg_roles WHERE rolname = 'dbadmin'/, opts.exists ? '1' : '0'],
    [/FROM pg_catalog\.pg_database d JOIN/, dbRows(opts.dbs)],
    [/r\.rolcanlogin/, (opts.apps ?? []).map(hex).join('\n')],
  ];

  it('creates a non-superuser, takes over superuser-owned tenant databases, and hardens every database it may connect to', async () => {
    const r = recorder(world({
      dbs: [['postgres', 'myapp', true], ['shop', 'myapp', true], ['owned', 'tenantrole', false]],
      apps: ['appuser'],
    }));
    const changed = await ensureTenantAdmin(ctx('postgresql', 'myapp'), account, { harden: false }, r.run);
    expect(r.texts).toContain(`CREATE ROLE "dbadmin" LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'pw-2'`);
    expect(r.texts).toContain('ALTER DATABASE "shop" OWNER TO "dbadmin"');
    // the server's own database is hardened but never handed over
    expect(r.texts.filter((t) => t.startsWith('ALTER DATABASE'))).toEqual(['ALTER DATABASE "shop" OWNER TO "dbadmin"']);
    expect(r.texts).toContain('GRANT "appuser" TO "dbadmin"');
    expect(changed).toEqual({ changes: ['created dbadmin', 'dbadmin owns the database shop', 'dbadmin is a member of appuser'], problems: [] });

    const hardened = r.calls.filter((c) => c.text.startsWith('DO $insula_'));
    // What the superuser owns goes to dbadmin; what a tenant role owns stays its.
    const T = (sql: string): string => sql.replace(/\$insula_[0-9a-f]{12}\$/g, '$T$');
    expect(hardened.map((c) => [c.database, T(c.text)])).toEqual([
      ['postgres', databaseHardeningSql('dbadmin', '$T$')],
      ['shop', databaseHardeningSql('dbadmin', '$T$')],
      ['owned', databaseHardeningSql('tenantrole', '$T$')],
    ]);
  });

  it('every command goes in as the configured superuser, in the pinned session', async () => {
    const r = recorder(world({ dbs: [['shop', 'myapp', true]] }));
    await ensureTenantAdmin(ctx('postgresql', 'myapp'), account, { harden: false }, r.run);
    const psql = r.calls.filter((c) => c.argv[4] === 'psql');
    expect(psql.length).toBeGreaterThan(3);
    for (const c of psql) {
      expect(c.argv[c.argv.indexOf('-U') + 1]).toBe('myapp');
      expect(c.argv.slice(0, 3)[1]).toBe('-c');
    }
  });

  it('template1 is left out of the frequent check and included in the hardening pass', async () => {
    const dbs: Array<[string, string, boolean]> = [['postgres', 'postgres', true], ['template1', 'postgres', true], ['shop', 'postgres', true]];
    const frequent = recorder(world({ dbs }));
    await ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, frequent.run);
    const daily = recorder(world({ dbs }));
    await ensureTenantAdmin(ctx('postgresql'), account, { harden: true }, daily.run);
    const hardenedIn = (r: ReturnType<typeof recorder>): Array<string | undefined> => r.calls.filter((c) => c.text.startsWith('DO $insula_')).map((c) => c.database);
    expect(hardenedIn(frequent)).toEqual(['postgres', 'shop']);
    expect(hardenedIn(daily)).toEqual(['postgres', 'template1', 'shop']);
    // never handed to the tenant, even in the pass
    expect(daily.texts.filter((t) => t.startsWith('ALTER DATABASE'))).toEqual(['ALTER DATABASE "shop" OWNER TO "dbadmin"']);
  });

  it('the cluster-wide pass runs before any database is touched, and only when asked', async () => {
    const dbs: Array<[string, string, boolean]> = [['shop', 'postgres', true]];
    const daily = recorder(world({ dbs }));
    await ensureTenantAdmin(ctx('postgresql'), account, { harden: true }, daily.run);
    const cluster = daily.texts.findIndex((t) => t === 'SHOW server_version_num');
    const firstDb = daily.texts.findIndex((t) => t.startsWith('ALTER DATABASE'));
    expect(cluster).toBeGreaterThanOrEqual(0);
    expect(cluster).toBeLessThan(firstDb);
    const frequent = recorder(world({ dbs }));
    await ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, frequent.run);
    expect(frequent.texts).not.toContain('SHOW server_version_num');
  });

  it('an existing account whose password the tenant changed is set back, and its attributes re-asserted', async () => {
    const r = recorder([...world({ exists: true, dbs: [] }), [/^SELECT rolcanlogin AND/, 't']], (c) => c.text.includes('PGPASSWORD='));
    const changed = await ensureTenantAdmin(ctx('postgresql'), { username: 'dbadmin', password: "p'w" }, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ["set dbadmin's password back to the one in the panel"], problems: [] });
    expect(r.texts).toContain(`ALTER ROLE "dbadmin" PASSWORD 'p''w'`);
    // the check goes where the password is checked: the pod's own address, not the trusted loopback
    const check = r.calls.find((c) => c.text.includes('PGPASSWORD='))!;
    expect(check.text).toContain(`PGPASSWORD='p'\\''w'`);
    expect(check.text).toContain('hostname -i');
    expect(check.text).not.toContain('127.0.0.1');
    // no address, no check: an empty -h would be the socket, which trusts anyone
    expect(check.text).toContain('[ -n "$h" ] || exit 1');
  });

  it('an account whose attributes were changed (SUPERUSER, CREATEROLE, …) has them put back', async () => {
    const r = recorder([...world({ exists: true, dbs: [] }), [/^SELECT rolcanlogin AND/, 'f']]);
    const changed = await ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ['dbadmin has its attributes back'], problems: [] });
    expect(r.texts).toContain('ALTER ROLE "dbadmin" LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    const shape = r.texts.find((t) => t.startsWith('SELECT rolcanlogin AND'))!;
    for (const part of ['rolcreatedb', 'NOT rolsuper', 'NOT rolcreaterole', 'NOT rolreplication', 'NOT rolbypassrls', "rolname = 'dbadmin'"]) expect(shape).toContain(part);
  });

  it('an existing account in shape with a good password changes nothing and writes nothing', async () => {
    const r = recorder([...world({ exists: true, dbs: [] }), [/^SELECT rolcanlogin AND/, 't']]);
    expect(await ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, r.run)).toEqual({ changes: [], problems: [] });
    expect(r.texts.some((t) => /^(ALTER|CREATE|GRANT)/.test(t))).toBe(false);
  });

  it('a failing step of the cluster pass or of one database is a problem; the other databases and the account carry on', async () => {
    const dbs: Array<[string, string, boolean]> = [['shop', 'postgres', true], ['blog', 'postgres', true]];
    const r = recorder(world({ dbs }), (c) => c.text === 'SHOW server_version_num' || (c.text.startsWith('DO $insula_') && c.database === 'shop'));
    const result = await ensureTenantAdmin(ctx('postgresql'), account, { harden: true }, r.run);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/^cluster: /);
    expect(result.problems[1]).toMatch(/^database shop: /);
    expect(result.changes).toEqual(['created dbadmin', 'dbadmin owns the database shop', 'dbadmin owns the database blog']);
    expect(r.calls.some((c) => c.text.startsWith('DO $insula_') && c.database === 'blog')).toBe(true);
  });

  it('app roles: logins that are not superusers, not role administrators, not already members, not members of a role reaching outside', async () => {
    const r = recorder(world({ dbs: [], apps: ['app\nuser', 'we"ird'] }));
    const changed = await ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, r.run);
    const q = r.calls.find((c) => c.text.includes('r.rolcanlogin'))!.text;
    for (const part of ['NOT r.rolsuper', 'NOT r.rolcreaterole', 'NOT r.rolreplication', 'NOT r.rolbypassrls', "r.rolname <> 'dbadmin'", "r.rolname !~ '^pg_'"]) expect(q).toContain(part);
    for (const role of ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_create_subscription']) expect(q).toContain(`'${role}'`);
    expect(q).toContain("pg_has_role('dbadmin', r.oid, 'MEMBER')");
    expect(r.texts).toContain('GRANT "app\nuser" TO "dbadmin"');
    expect(r.texts).toContain('GRANT "we""ird" TO "dbadmin"');
    expect(changed).toEqual({ changes: ['created dbadmin', 'dbadmin is a member of app\nuser', 'dbadmin is a member of we"ird'], problems: [] });
  });

  it('a hostile name from the server is refused, not run', async () => {
    const r = recorder([...world({ dbs: [] }).slice(0, 2), [/r\.rolcanlogin/, 'not hex; DROP ROLE x']]);
    await expect(ensureTenantAdmin(ctx('postgresql'), account, { harden: false }, r.run)).rejects.toThrow(/unexpected output/);
    expect(r.texts.some((t) => t.startsWith('GRANT') || t.includes('DROP ROLE'))).toBe(false);
  });
});

describe('MongoDB', () => {
  const account = { username: 'dbadmin', password: 'pw-3' };
  const ROLES = '[{"role":"readWriteAnyDatabase","db":"admin"},{"role":"dbAdminAnyDatabase","db":"admin"}]';
  const GOOD_ROLES = '["dbAdminAnyDatabase@admin","readWriteAnyDatabase@admin"]';
  const EXISTS: [RegExp, string] = [/getUser\("dbadmin"\) \? "yes" : "no"/, 'yes'];
  const ROLES_NOW = (roles: string): [RegExp, string] => [/^JSON\.stringify\(db\.getSiblingDB\("admin"\)\.getUser\("dbadmin"\)\.roles/, roles];

  it('creates the administrator without user-administration roles; the password is on stdin, after root\'s', async () => {
    const r = recorder([[/getUser\("dbadmin"\) \? "yes" : "no"/, 'no']]);
    const changed = await ensureTenantAdmin(ctx('mongodb'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ['created dbadmin'], problems: [] });
    const create = r.calls.find((c) => c.text.includes('createUser'))!;
    expect(create.text).toBe(`db.getSiblingDB("admin").createUser({user: "dbadmin", pwd: passwordPrompt(), roles: ${ROLES}}); "ok"`);
    expect(create.stdin).toBe('stored\npw-3\n');
    expect(create.text).not.toMatch(/userAdmin|"root"|pw-3/);
    for (const c of r.calls) expect(c.argv.join('\u0000')).not.toContain('pw-3');
  });

  it('an account in shape with a good login changes nothing and writes nothing', async () => {
    const r = recorder([EXISTS, ROLES_NOW(GOOD_ROLES)]);
    expect(await ensureTenantAdmin(ctx('mongodb'), account, { harden: false }, r.run)).toEqual({ changes: [], problems: [] });
    expect(r.texts.some((t) => t.includes('updateUser') || t.includes('createUser'))).toBe(false);
  });

  it('roles that were changed (userAdmin added, one dropped) are put back, and reported', async () => {
    const r = recorder([EXISTS, ROLES_NOW('["readWriteAnyDatabase@admin","userAdminAnyDatabase@admin"]')]);
    const changed = await ensureTenantAdmin(ctx('mongodb'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ['dbadmin has its roles back'], problems: [] });
    expect(r.texts.at(-1)).toBe(`db.getSiblingDB("admin").updateUser("dbadmin", {roles: ${ROLES}}); "ok"`);
  });

  it('a login the database refuses gets its password set back, on stdin', async () => {
    const r = recorder([EXISTS, ROLES_NOW(GOOD_ROLES)], (c) => c.argv.includes('dbadmin'));
    const changed = await ensureTenantAdmin(ctx('mongodb'), account, { harden: false }, r.run);
    expect(changed).toEqual({ changes: ["set dbadmin's password back to the one in the panel"], problems: [] });
    const set = r.calls.find((c) => c.text.includes('passwordPrompt'))!;
    expect(set.stdin).toBe('stored\npw-3\n');
    expect(set.text).toBe('db.getSiblingDB("admin").updateUser("dbadmin", {pwd: passwordPrompt()}); "ok"');
  });

  it('checks the account\'s login with its own password on stdin', async () => {
    const r = recorder([EXISTS, ROLES_NOW(GOOD_ROLES)]);
    await ensureTenantAdmin(ctx('mongodb'), account, { harden: false }, r.run);
    const login = r.calls.find((c) => c.argv.includes('dbadmin'))!;
    expect(login.stdin).toBe('pw-3\n');
    expect(login.text).toBe('String("ok")');
  });

  it('with harden, other users holding admin roles are demoted AFTER the account is in shape', async () => {
    const users = [
      { user: 'root', db: 'admin', roles: [{ role: 'root', db: 'admin' }] },
      { user: 'evil', db: 'admin', roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }] },
    ];
    const r = recorder([[/system\.users/, users.map((u) => hex(JSON.stringify(u))).join('\n')], EXISTS, ROLES_NOW(GOOD_ROLES)]);
    const changed = await ensureTenantAdmin(ctx('mongodb'), account, { harden: true }, r.run);
    expect(changed).toEqual({ changes: ['evil@admin no longer holds userAdminAnyDatabase (it keeps read/write on every database)'], problems: [] });
    const demote = r.texts.findIndex((t) => t.includes('revokeRolesFromUser'));
    const exists = r.texts.findIndex((t) => t.includes('getUser("dbadmin") ? "yes"'));
    expect(exists).toBeGreaterThanOrEqual(0);
    expect(demote).toBeGreaterThan(exists);
  });

  it('a failing demotion is a problem, not a failure of the account', async () => {
    const r = recorder([EXISTS, ROLES_NOW(GOOD_ROLES)], (c) => c.text.includes('system.users'));
    const result = await ensureTenantAdmin(ctx('mongodb'), account, { harden: true }, r.run);
    expect(result.changes).toEqual([]);
    expect(result.problems).toEqual(['privileged users: ERROR 1045 (28000): Access denied']);
  });
});

describe('tenantAdminLogsIn', () => {
  const account = { username: 'dbadmin', password: 'pw' };

  it('MariaDB / MySQL: the account answers as itself at % over TCP', async () => {
    const r = recorder();
    expect(await tenantAdminLogsIn(ctx('mariadb'), account, r.run)).toBe(true);
    // a more specific lookalike (dbadmin@127.0.0.1, an anonymous account) is not the account
    expect(await tenantAdminLogsIn(ctx('mariadb'), account, recorder([[/^SELECT CURRENT_USER/, 'dbadmin@127.0.0.1']]).run)).toBe(false);
    expect(r.calls[0]!.argv).toEqual(asTenantAdminMysql(ctx('mariadb'), account, ['--batch', '--skip-column-names', '-e', 'SELECT CURRENT_USER()']));
  });

  it('PostgreSQL: through the pod address, where the password is checked', async () => {
    const r = recorder();
    expect(await tenantAdminLogsIn(ctx('postgresql'), account, r.run)).toBe(true);
    expect(r.calls[0]!.text).toContain('PGPASSWORD=');
  });

  it('MongoDB: its password on stdin', async () => {
    const r = recorder();
    expect(await tenantAdminLogsIn(ctx('mongodb'), account, r.run)).toBe(true);
    expect(r.calls[0]!.stdin).toBe('pw\n');
  });

  it.each(['mariadb', 'mysql', 'postgresql', 'mongodb'] as const)('is false when %s refuses the login, and never throws', async (engine) => {
    const r = recorder([], () => true);
    expect(await tenantAdminLogsIn(ctx(engine), account, r.run)).toBe(false);
  });
});

describe('chooseTenantAdminUsername', () => {
  it('prefers dbadmin', async () => {
    const r = recorder([[/COUNT\(\*\) FROM mysql\.user/, '0']]);
    expect(await chooseTenantAdminUsername(ctx('mariadb'), r.run)).toBe('dbadmin');
  });

  it('never adopts an account the tenant made under the preferred name', async () => {
    const r = recorder([[/User = 'dbadmin'$/, '1'], [/User = 'dbadmin_insula'$/, '0']]);
    expect(await chooseTenantAdminUsername(ctx('mysql'), r.run)).toBe('dbadmin_insula');
  });

  it('then falls back to a fresh random name', async () => {
    const r = recorder([[/User = 'dbadmin(_insula)?'$/, '1'], [/User = 'dbadmin_[0-9a-f]{6}'$/, '0']]);
    expect(await chooseTenantAdminUsername(ctx('mariadb'), r.run)).toMatch(/^dbadmin_[0-9a-f]{6}$/);
  });

  it('gives up when every name is taken', async () => {
    const r = recorder([[/COUNT/, '1']]);
    await expect(chooseTenantAdminUsername(ctx('mariadb'), r.run)).rejects.toThrow('no free name');
  });

  it('PostgreSQL asks pg_roles as the superuser', async () => {
    const r = recorder([[/rolname = 'dbadmin'$/, '1'], [/rolname = 'dbadmin_insula'$/, '0']]);
    expect(await chooseTenantAdminUsername(ctx('postgresql', 'myapp'), r.run)).toBe('dbadmin_insula');
    expect(r.calls[0]!.argv[r.calls[0]!.argv.indexOf('-U') + 1]).toBe('myapp');
  });

  it('MongoDB asks for the user in admin', async () => {
    const r = recorder([[/getUser\("dbadmin"\)/, 'yes'], [/getUser\("dbadmin_insula"\)/, 'no']]);
    expect(await chooseTenantAdminUsername(ctx('mongodb'), r.run)).toBe('dbadmin_insula');
  });
});

describe('setTenantAdminPassword', () => {
  const account = { username: 'dbadmin', password: "n'ew" };

  it('MariaDB / MySQL: an ALTER USER script on stdin', async () => {
    const r = recorder();
    await setTenantAdminPassword(ctx('mariadb'), account, r.run);
    expect(r.scripts).toEqual(["ALTER USER 'dbadmin'@'%' IDENTIFIED BY 'n\\'ew';\n"]);
    expect(r.calls[0]!.argv.join(' ')).not.toContain("n'ew");
  });

  it('PostgreSQL: ALTER ROLE with the literal escaped', async () => {
    const r = recorder();
    await setTenantAdminPassword(ctx('postgresql'), account, r.run);
    expect(r.texts).toEqual([`ALTER ROLE "dbadmin" PASSWORD 'n''ew'`]);
  });

  it('MongoDB: the password is the second stdin line, not in the script', async () => {
    const r = recorder();
    await setTenantAdminPassword(ctx('mongodb'), account, r.run);
    expect(r.calls[0]!.stdin).toBe("stored\nn'ew\n");
    expect(r.calls[0]!.text).toBe('db.getSiblingDB("admin").updateUser("dbadmin", {pwd: passwordPrompt()}); "ok"');
  });

  it('a refused change throws', async () => {
    const r = recorder([], () => true);
    await expect(setTenantAdminPassword(ctx('postgresql'), account, r.run)).rejects.toThrow(DbExecError);
  });
});
