import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFn = vi.fn();
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig { loadFromFile = vi.fn(); loadFromCluster = vi.fn(); }
  class MockExec { exec = mockExecFn; }
  return { KubeConfig: MockKubeConfig, Exec: MockExec };
});

import { importSql, redactDbSecrets, setUserPassword } from './db-manager.js';

type Reply = { stdout?: string; stderr?: string; status?: Record<string, unknown> };

/** Route each exec by its `-e <sql>` argument; record the SQL that ran. */
function routeExec(route: (sql: string) => Reply): string[] {
  const ran: string[] = [];
  mockExecFn.mockImplementation((
    _ns: string, _pod: string, _c: string, command: string[],
    out: NodeJS.WritableStream, err: NodeJS.WritableStream, _in: null, _tty: boolean,
    cb: (s: Record<string, unknown>) => void,
  ) => {
    const sql = command[command.indexOf('-e') + 1] ?? '';
    ran.push(sql);
    const r = route(sql);
    if (r.stdout) out.write(Buffer.from(r.stdout));
    if (r.stderr) err.write(Buffer.from(r.stderr));
    setTimeout(() => cb(r.status ?? { status: 'Success' }), 0);
    return Promise.resolve({});
  });
  return ran;
}

const ctx = {
  kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'mariadb',
  engine: 'mariadb' as const, rootPassword: 'r00tSecret',
};

describe('setUserPassword (MariaDB)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('changes the password under every host the account exists with', async () => {
    const ran = routeExec((sql) => (sql.startsWith('SELECT Host') ? { stdout: '%\nlocalhost\n' } : {}));
    await setUserPassword(ctx, 'app_user', 'N3wPass');
    expect(ran).toEqual([
      "SELECT Host FROM mysql.user WHERE User = 'app_user'",
      "ALTER USER 'app_user'@'%' IDENTIFIED BY 'N3wPass'",
      "ALTER USER 'app_user'@'localhost' IDENTIFIED BY 'N3wPass'",
      'FLUSH PRIVILEGES',
    ]);
  });

  it('answers 404 DB_USER_NOT_FOUND for an account that does not exist', async () => {
    routeExec(() => ({ stdout: '' }));
    await expect(setUserPassword(ctx, 'ghost', 'x')).rejects.toMatchObject({ code: 'DB_USER_NOT_FOUND', status: 404 });
  });

  it('a refused ALTER surfaces the database message as DB_EXEC_ERROR, with no password in it', async () => {
    routeExec((sql) => {
      if (sql.startsWith('SELECT Host')) return { stdout: '%\n' };
      return {
        stderr: "ERROR 1396 (HY000) at line 1: Operation ALTER USER failed for 'app_user'@'%'",
        status: {
          status: 'Failure',
          message: "command terminated: [mariadb -u root -pr00tSecret -e ALTER USER 'app_user'@'%' IDENTIFIED BY 'N3wPass'], exit code 1",
        },
      };
    });
    const err = await setUserPassword(ctx, 'app_user', 'N3wPass').catch((e: unknown) => e) as { code: string; message: string };
    expect(err.code).toBe('DB_EXEC_ERROR');
    expect(err.message).toMatch(/Operation ALTER USER failed/);
    expect(err.message).not.toMatch(/r00tSecret|N3wPass/);
  });

  it('with no stderr, the exec status is used — redacted', async () => {
    routeExec((sql) => (sql.startsWith('SELECT Host') ? { stdout: '%\n' } : {
      status: { status: 'Failure', message: "error executing [mariadb -u root -pr00tSecret -e ALTER USER 'a'@'%' IDENTIFIED BY 'N3wPass']" },
    }));
    const err = await setUserPassword(ctx, 'a', 'N3wPass').catch((e: unknown) => e) as { message: string };
    expect(err.message).toMatch(/-p\*\*\*/);
    expect(err.message).not.toMatch(/r00tSecret|N3wPass/);
  });
});

describe('importSql refuses a full-server dump', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('never runs a dump that switches to the mysql schema', async () => {
    const res = await importSql(ctx, 'app', 'CREATE TABLE t (id int);\nUSE `mysql`;\nDROP TABLE IF EXISTS `global_priv`;\n');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/line 2/);
    expect(mockExecFn).not.toHaveBeenCalled();
  });
});

describe('redactDbSecrets', () => {
  it.each([
    ['mariadb -u root -pS3cret -e x', 'mariadb -u root -p*** -e x'],
    ["sh -c cat f | mariadb -u root -p'S3cret' db", 'sh -c cat f | mariadb -u root -p*** db'],
    ['mongosh --password S3cret', 'mongosh --password ***'],
    ['PGPASSWORD=S3cret psql', 'PGPASSWORD=*** psql'],
    ["ALTER USER 'a'@'%' IDENTIFIED BY 'S3cret'", "ALTER USER 'a'@'%' IDENTIFIED BY '***'"],
    ["CREATE USER `a`@`%` IDENTIFIED BY PASSWORD '*ABC'", "CREATE USER `a`@`%` IDENTIFIED BY PASSWORD '***'"],
    ["IDENTIFIED VIA mysql_native_password USING 'S3cret'", "IDENTIFIED VIA mysql_native_password USING '***'"],
    ["SET PASSWORD = PASSWORD('S3cret')", "SET PASSWORD = PASSWORD('***')"],
    ["ALTER USER \"a\" WITH PASSWORD 'S3cret'", "ALTER USER \"a\" WITH PASSWORD '***'"],
  ])('%s', (input, expected) => {
    expect(redactDbSecrets(input)).toBe(expected);
  });

  it('leaves ordinary text and flags like `mkdir -p /data` alone', () => {
    expect(redactDbSecrets('mkdir -p /data && ERROR 1045 (28000): Access denied')).toBe('mkdir -p /data && ERROR 1045 (28000): Access denied');
  });
});
