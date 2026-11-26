/**
 * ensureDatabaseAdminAccess against simulated servers. The simulator keeps
 * root's login methods and, after EVERY statement, checks the platform could
 * still log in (by socket, or with the stored password) — a conversion that
 * removed the password before proving the socket path would fail here.
 * The real engines were exercised the same way against MariaDB 10.11/12.3,
 * MySQL 8.0/8.4/9.7, PostgreSQL 18 and MongoDB 7 containers.
 */
import { describe, expect, it } from 'vitest';
import { adminLoginWorks, DbUnreachableError, ensureDatabaseAdminAccess, isLoginRefusal, type DbCommandRunner } from './db-admin-access.js';
import { DbExecError, type DbManagerContext } from './db-manager.js';

interface MysqlState {
  engine: 'mariadb' | 'mysql';
  rootSocket: boolean;
  rootPassword: string | null;
  others: string[];
  /** Does the exec user map to root (it is root in every catalog image)? */
  execIsRoot: boolean;
  pluginActive: boolean;
  probe: boolean;
  lockedOut: boolean;
  statements: string[];
}

function mysqlServer(init: Partial<MysqlState> & { engine: 'mariadb' | 'mysql' }): { state: MysqlState; run: DbCommandRunner } {
  const state: MysqlState = {
    rootSocket: false, rootPassword: 'stored', others: ["'root'@'%'"], execIsRoot: true,
    pluginActive: init.engine === 'mariadb', probe: false, lockedOut: false, statements: [], ...init,
  };
  const deny = (u: string): never => { throw new DbExecError(`ERROR 1045 (28000): Access denied for user '${u}'@'localhost'`); };
  const run: DbCommandRunner = async (_ctx, argv) => {
    const userArg = argv.find((a) => a.startsWith('-u'))!;
    const user = userArg.slice(2);
    const pw = argv.find((a) => a.startsWith('-p'))?.slice(2);
    const sql = argv[argv.indexOf('-e') + 1]!;
    if (user === 'root') {
      const bySocket = state.rootSocket && state.execIsRoot;
      const byPassword = state.rootPassword !== null && pw === state.rootPassword;
      if (!bySocket && !byPassword) deny(user);
    } else if (user === 'insula_socket_probe') {
      if (!(state.probe && state.execIsRoot)) deny(user);
    }
    state.statements.push(sql);
    let out = '';
    if (/^ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR/.test(sql)) state.rootSocket = true;
    else if (/^ALTER USER 'root'@'localhost' IDENTIFIED (VIA unix_socket|WITH auth_socket)$/.test(sql)) {
      state.rootSocket = true; state.rootPassword = null;
    } else if (sql.startsWith("SHOW CREATE USER 'root'@'localhost'")) {
      out = `CREATE USER \`root\`@\`localhost\` IDENTIFIED ${state.rootSocket ? 'VIA unix_socket' : 'BY PASSWORD \'*X\''}${state.rootSocket && state.rootPassword !== null ? " OR mysql_native_password USING '*X'" : ''}`;
    } else if (sql.startsWith('SELECT CONCAT(QUOTE(User)')) out = state.others.join('\n');
    else if (sql.startsWith('DROP USER IF EXISTS')) {
      const acct = sql.slice('DROP USER IF EXISTS '.length);
      if (acct.includes('insula_socket_probe')) state.probe = false;
      state.others = state.others.filter((o) => o !== acct);
    } else if (sql.startsWith('SELECT PLUGIN_STATUS')) out = state.pluginActive ? 'ACTIVE' : '';
    else if (sql.startsWith('INSTALL PLUGIN')) state.pluginActive = true;
    else if (sql.startsWith('SELECT plugin FROM mysql.user')) out = state.rootSocket && state.rootPassword === null ? 'auth_socket' : 'caching_sha2_password';
    else if (sql.startsWith("CREATE USER 'insula_socket_probe'")) state.probe = true;
    else if (sql === 'SELECT 1') out = '1';
    // The invariant: after every statement the platform can still get in.
    if (!(state.rootSocket && state.execIsRoot) && state.rootPassword === null) state.lockedOut = true;
    return { stdout: out, stderr: '' };
  };
  return { state, run };
}

function ctx(engine: DbManagerContext['engine'], rootPassword = 'stored', rootUsername = 'root'): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine, rootPassword, rootUsername };
}

describe.each(['mariadb', 'mysql'] as const)('%s', (engine) => {
  it('converts a password root with root@% to socket-only root, and a rerun changes nothing', async () => {
    const { state, run } = mysqlServer({ engine, others: ["'root'@'%'", "'root'@'127.0.0.1'"] });
    const r = await ensureDatabaseAdminAccess(ctx(engine), { standalone: true }, run);
    expect(r.mode).toBe('socket');
    expect(state).toMatchObject({ rootSocket: true, rootPassword: null, others: [], lockedOut: false, probe: false });
    expect(r.changed.join(';')).toMatch(/socket only/);
    const again = await ensureDatabaseAdminAccess(ctx(engine), { standalone: true }, run);
    expect(again).toEqual({ mode: 'socket', changed: [] });
  });

  it('keeps the password when the socket login cannot be proven in the pod', async () => {
    const { state, run } = mysqlServer({ engine, execIsRoot: false });
    const r = await ensureDatabaseAdminAccess(ctx(engine), { standalone: true }, run);
    expect(r.mode).toBe('password');
    expect(r.detail).toMatch(/socket login does not work/);
    expect(state.rootPassword).toBe('stored');
    expect(state.lockedOut).toBe(false);
    expect(state.probe).toBe(false);
  });

  it('reports locked — and changes nothing — when the stored password drifted before conversion', async () => {
    const { state, run } = mysqlServer({ engine });
    const r = await ensureDatabaseAdminAccess(ctx(engine, 'drifted'), { standalone: true }, run);
    expect(r.mode).toBe('locked');
    expect(r.detail).toMatch(/refuses both/);
    expect(state.statements).toEqual([]);
    expect(state.rootPassword).toBe('stored');
  });

  it('needs no stored password once converted (a drifted copy no longer matters)', async () => {
    const { run } = mysqlServer({ engine, rootSocket: true, rootPassword: null, others: [], pluginActive: true });
    expect(await ensureDatabaseAdminAccess(ctx(engine, 'anything'), { standalone: true }, run)).toEqual({ mode: 'socket', changed: [] });
  });
});

describe('mysql', () => {
  it('installs auth_socket when the server lacks it, then converts', async () => {
    const { state, run } = mysqlServer({ engine: 'mysql', pluginActive: false });
    const r = await ensureDatabaseAdminAccess(ctx('mysql'), { standalone: true }, run);
    expect(r.mode).toBe('socket');
    expect(r.changed).toContain('installed auth_socket');
    expect(state.statements.indexOf("INSTALL PLUGIN auth_socket SONAME 'auth_socket.so'"))
      .toBeLessThan(state.statements.indexOf("ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket"));
  });
});

describe('postgresql', () => {
  const pg = (passwordSet: boolean, failLogin = false): { calls: string[]; run: DbCommandRunner } => {
    const calls: string[] = [];
    let has = passwordSet;
    return {
      calls,
      run: async (_c, argv) => {
        if (failLogin) throw new DbExecError('psql: error: FATAL: role "x" does not exist');
        const sql = argv[argv.length - 1]!;
        calls.push(`${argv[argv.indexOf('-U') + 1]}: ${sql}`);
        if (sql.startsWith('ALTER ROLE CURRENT_USER PASSWORD NULL')) has = false;
        return { stdout: sql.startsWith('SELECT rolpassword IS NULL') ? (has ? 'f' : 't') : '', stderr: '' };
      },
    };
  };

  it('a standalone instance\'s superuser loses its password, by the configured name', async () => {
    const { calls, run } = pg(true);
    const r = await ensureDatabaseAdminAccess(ctx('postgresql', '', 'myapp'), { standalone: true }, run);
    expect(r).toEqual({ mode: 'trust', changed: ['myapp no longer has a password (network login closed)'] });
    expect(calls.every((c) => c.startsWith('myapp: '))).toBe(true);
    expect((await ensureDatabaseAdminAccess(ctx('postgresql', '', 'myapp'), { standalone: true }, run)).changed).toEqual([]);
  });

  it('an app stack keeps its superuser password (the app connects as it)', async () => {
    const { calls, run } = pg(true);
    expect(await ensureDatabaseAdminAccess(ctx('postgresql', '', 'gitea'), { standalone: false }, run)).toEqual({ mode: 'trust', changed: [] });
    expect(calls.some((c) => c.includes('ALTER ROLE'))).toBe(false);
  });

  it('a failing trust login is a lockout', async () => {
    const { run } = pg(true, true);
    expect((await ensureDatabaseAdminAccess(ctx('postgresql', '', 'x'), { standalone: true }, run)).mode).toBe('locked');
  });

  it('runs psql in the pinned session, as the configured superuser, on the postgres database', async () => {
    const seen: string[][] = [];
    const run: DbCommandRunner = async (_c, argv) => { seen.push(argv); return { stdout: 't', stderr: '' }; };
    await ensureDatabaseAdminAccess(ctx('postgresql', '', 'myapp'), { standalone: false }, run);
    expect(seen[0]!.slice(0, 5)).toEqual(['sh', '-c', expect.stringContaining('PGOPTIONS'), 'sh', 'psql']);
    expect(seen[0]).toEqual(expect.arrayContaining(['-X', '-U', 'myapp', '-d', "dbname='postgres'", 'ON_ERROR_STOP=1']));
  });

  it('a server that does not answer is unreachable, not a lockout', async () => {
    const run: DbCommandRunner = async () => { throw new DbExecError('psql: error: connection to server failed: Connection refused'); };
    await expect(ensureDatabaseAdminAccess(ctx('postgresql', '', 'x'), { standalone: true }, run)).rejects.toBeInstanceOf(DbUnreachableError);
  });
});

describe('mongodb', () => {
  it('restricts root to the pod, once', async () => {
    let restrictions = '[]';
    const evals: string[] = [];
    const run: DbCommandRunner = async (_c, argv) => {
      const js = argv[argv.length - 1]!;
      evals.push(js);
      if (js.includes('updateUser')) restrictions = '[{"clientSource":["127.0.0.1","::1"]}]';
      return { stdout: js.startsWith('JSON.stringify') ? restrictions : 'ok', stderr: '' };
    };
    expect(await ensureDatabaseAdminAccess(ctx('mongodb'), { standalone: true }, run))
      .toEqual({ mode: 'restricted', changed: ['root may log in from inside the pod only'] });
    expect(await ensureDatabaseAdminAccess(ctx('mongodb'), { standalone: true }, run)).toEqual({ mode: 'restricted', changed: [] });
    expect(evals.filter((e) => e.includes('updateUser'))).toHaveLength(1);
  });

  it('without a stored root password there is no way in', async () => {
    const run: DbCommandRunner = async () => ({ stdout: '', stderr: '' });
    expect((await ensureDatabaseAdminAccess(ctx('mongodb', ''), { standalone: true }, run)).mode).toBe('locked');
  });
});

describe('an app stack\'s MariaDB', () => {
  it('is only checked: root keeps its password, and the result says so', async () => {
    const { state, run } = mysqlServer({ engine: 'mariadb' });
    const r = await ensureDatabaseAdminAccess(ctx('mariadb'), { standalone: false }, run);
    expect(r).toMatchObject({ mode: 'password', changed: [] });
    expect(state.statements.every((s) => s === 'SELECT 1')).toBe(true);
    expect(state.rootPassword).toBe('stored');
  });

  it('reports locked when the database refuses both logins', async () => {
    const { run } = mysqlServer({ engine: 'mariadb' });
    expect((await ensureDatabaseAdminAccess(ctx('mariadb', 'drifted'), { standalone: false }, run)).mode).toBe('locked');
  });

  it('reports unreachable (throws) when the database never answered', async () => {
    const run: DbCommandRunner = async () => { throw new DbExecError("ERROR 2002 (HY000): Can't connect to local server through socket"); };
    await expect(ensureDatabaseAdminAccess(ctx('mariadb'), { standalone: false }, run)).rejects.toBeInstanceOf(DbUnreachableError);
  });
});

describe('mariadb standalone, database not answering', () => {
  it('is unreachable, not locked', async () => {
    const run: DbCommandRunner = async () => { throw new DbExecError('ERROR 2002 (HY000): Can\'t connect to local server'); };
    await expect(ensureDatabaseAdminAccess(ctx('mariadb'), { standalone: true }, run)).rejects.toBeInstanceOf(DbUnreachableError);
  });
});

describe('isLoginRefusal', () => {
  it.each([
    'ERROR 1045 (28000): Access denied for user',
    'ERROR 1698 (28000): Access denied',
    'FATAL: password authentication failed for user "x"',
    'FATAL: role "x" does not exist',
    'MongoServerError: Authentication failed.',
    'no pg_hba.conf entry for host',
    'ERROR 3118 (HY000): Access denied for user \'root\'@\'localhost\'. Account is locked.',
    'FATAL: role "x" is not permitted to log in',
    'FATAL: pg_hba.conf rejects connection for host "[local]", user "x", database "postgres"',
  ])('%s is a refusal', (m) => expect(isLoginRefusal(m)).toBe(true));

  it.each([
    "ERROR 2002 (HY000): Can't connect to local server",
    'the database system is starting up',
    'container not found',
    '',
  ])('%j is not', (m) => expect(isLoginRefusal(m)).toBe(false));
});

describe('a step that fails part-way', () => {
  it.each(['mariadb', 'mysql'] as const)('%s: reports the password login — never the target — with what was changed so far', async (engine) => {
    const { state, run: inner } = mysqlServer({ engine });
    const run: DbCommandRunner = async (c, argv, stdin) => {
      const sql = argv[argv.indexOf('-e') + 1] ?? '';
      if (sql.startsWith('DROP USER IF EXISTS') && !sql.includes('insula_socket_probe')) throw new DbExecError('ERROR 1105 (HY000): Unknown error');
      return inner(c, argv, stdin);
    };
    const r = await ensureDatabaseAdminAccess(ctx(engine), { standalone: true }, run);
    expect(r.mode).toBe('password');
    expect(r.changed).toEqual(expect.arrayContaining([expect.stringMatching(/socket only/)]));
    expect(r.detail).toMatch(/^a step failed, the next check tries again: .*Unknown error/);
    // the part-way result says so: the tenant administrator is not shown as ready on it
    expect(r.partial).toBe(true);
    // root@'%' is still there: the hardening pass must not take root for the platform's alone
    expect(state.others).toContain("'root'@'%'");
    expect(state.lockedOut).toBe(false);
  });
});

describe('adminLoginWorks — one command per mode', () => {
  const ok: DbCommandRunner = async () => ({ stdout: 'ok', stderr: '' });
  const refused: DbCommandRunner = async () => { throw new DbExecError('Access denied'); };

  it('socket: root over the socket, no password', async () => {
    const seen: string[][] = [];
    expect(await adminLoginWorks(ctx('mariadb'), 'socket', async (_c, argv) => { seen.push(argv); return { stdout: '1', stderr: '' }; })).toBe(true);
    expect(seen[0]!.some((a) => /^-p/.test(a))).toBe(false);
    expect(seen[0]).toContain('--protocol=socket');
    expect(await adminLoginWorks(ctx('mariadb'), 'socket', refused)).toBe(false);
  });

  it('password: root with the stored password', async () => {
    const seen: string[][] = [];
    expect(await adminLoginWorks(ctx('mysql'), 'password', async (_c, argv) => { seen.push(argv); return { stdout: '1', stderr: '' }; })).toBe(true);
    expect(seen[0]).toContain('-pstored');
    expect(await adminLoginWorks(ctx('mysql'), 'password', refused)).toBe(false);
  });

  it('trust and password (PostgreSQL): the superuser through psql', async () => {
    const seen: string[][] = [];
    const run: DbCommandRunner = async (_c, argv) => { seen.push(argv); return { stdout: '1', stderr: '' }; };
    expect(await adminLoginWorks(ctx('postgresql', '', 'myapp'), 'trust', run)).toBe(true);
    expect(await adminLoginWorks(ctx('postgresql', '', 'myapp'), 'password', run)).toBe(true);
    for (const argv of seen) expect(argv[argv.indexOf('-U') + 1]).toBe('myapp');
    expect(await adminLoginWorks(ctx('postgresql'), 'trust', refused)).toBe(false);
  });

  it('restricted and password (MongoDB): root answers ok, password on stdin', async () => {
    let stdin: string | undefined;
    expect(await adminLoginWorks(ctx('mongodb'), 'restricted', async (_c, _a, s) => { stdin = s; return { stdout: 'ok', stderr: '' }; })).toBe(true);
    expect(stdin).toBe('stored\n');
    expect(await adminLoginWorks(ctx('mongodb'), 'password', ok)).toBe(true);
    expect(await adminLoginWorks(ctx('mongodb'), 'restricted', async () => ({ stdout: 'hello', stderr: '' }))).toBe(false);
    expect(await adminLoginWorks(ctx('mongodb'), 'restricted', refused)).toBe(false);
  });

  it.each(['locked', 'open', 'unreachable'] as const)('%s is never a working login', async (mode) => {
    expect(await adminLoginWorks(ctx('mariadb'), mode as never, ok)).toBe(false);
  });
});
