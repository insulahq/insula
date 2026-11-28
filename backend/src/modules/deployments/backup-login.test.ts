import { describe, expect, it } from 'vitest';
import type { DbManagerContext, Engine } from './db-manager.js';
import type { DbCommandRunner } from './db-exec.js';
import {
  BACKUP_LOGIN_MAX_AGE_MS,
  classifyBackupLogin,
  comparableVersion,
  dropBackupLogin,
  dumpIsNewerThanServer,
  isBackupLoginName,
  mintBackupLogin,
  newBackupLoginName,
} from './backup-login.js';

function ctx(engine: Engine): DbManagerContext {
  return {
    kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine,
    rootPassword: 'root-pw', rootUsername: engine === 'postgresql' ? 'postgres' : 'root',
  };
}

interface Call { readonly argv: readonly string[]; readonly stdin: string }

function fake(answer: (text: string) => string = () => ''): { calls: Call[]; run: DbCommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (_c, argv, stdin) => {
      calls.push({ argv, stdin: stdin ?? '' });
      return { stdout: answer(`${argv.join(' ')}\n${stdin ?? ''}`), stderr: '' };
    },
  };
}

describe('backup login names', () => {
  it('fit MySQL\'s 32 characters and carry their creation time', () => {
    const at = Date.UTC(2026, 10, 26, 12, 0, 0);
    const name = newBackupLoginName(at);
    expect(name).toMatch(/^platform_bk_\d+_[0-9a-f]{6}$/);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toContain(String(Math.floor(at / 1000)));
    expect(isBackupLoginName(name)).toBe(true);
  });

  it('classifies fresh, left behind, future-dated and foreign names', () => {
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const at = (ms: number) => `platform_bk_${Math.floor(ms / 1000)}_abcdef`;
    expect(classifyBackupLogin(at(now - 60_000), now)).toBe('fresh');
    expect(classifyBackupLogin(at(now + 60_000), now)).toBe('fresh');
    expect(classifyBackupLogin(at(now - BACKUP_LOGIN_MAX_AGE_MS - 1000), now)).toBe('stale');
    // No run mints a name dated in the future: a name alone must not keep an account out of hardening.
    expect(classifyBackupLogin(at(now + 60 * 60_000), now)).toBe('stale');
    expect(classifyBackupLogin('platform_bk_evil', now)).toBe('other');
    expect(classifyBackupLogin('dbadmin', now)).toBe('other');
  });
});

describe('dumpIsNewerThanServer', () => {
  it.each([
    ['mariadb', '11.4.3-MariaDB', '10.11.9-MariaDB', true],
    ['mariadb', '10.11.19-MariaDB-ubu2204', '10.11.6-MariaDB', false],
    ['mysql', '8.4.2', '8.0.40', true],
    ['mysql', '8.0.40', '8.4.2', false],
    ['postgresql', '18.1 (Debian 18.1-1.pgdg13+2)', '17.6', true],
    ['postgresql', '17.6 (Debian 17.6-1)', '17.2', false],
    ['mongodb', '7.0.12', '6.0.3', true],
    ['mongodb', 'unknown', '6.0.3', false],
  ])('%s %s into %s → %s', (engine, from, to, expected) => {
    expect(dumpIsNewerThanServer(engine, from, to)).toBe(expected);
  });

  it('compares PostgreSQL by major only', () => {
    expect(comparableVersion('postgresql', '16.4')).toEqual([16]);
    expect(comparableVersion('mariadb', '10.11.9')).toEqual([10, 11]);
    expect(comparableVersion('mysql', 'garbage')).toBeNull();
  });
});

describe('mintBackupLogin', () => {
  it('MariaDB: read grants per database, routines through mysql.proc, password on stdin only', async () => {
    const s = fake((t) => (t.includes('SELECT VERSION()') ? '10.11.9-MariaDB\n' : ''));
    const login = await mintBackupLogin({ ctx: ctx('mariadb'), run: s.run }, ['shop', 'we`ird']);
    expect(login.serverVersion).toBe('10.11.9-MariaDB');
    const script = s.calls[1]!.stdin;
    expect(script).toContain(`CREATE USER \`${login.username}\`@\`%\` IDENTIFIED BY '${login.password}'`);
    expect(script).toContain(`GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON \`shop\`.* TO \`${login.username}\`@\`%\``);
    expect(script).toContain('ON `we``ird`.*');
    expect(script).toContain(`GRANT SELECT ON mysql.proc TO \`${login.username}\`@\`%\``);
    expect(script).not.toContain('SHOW_ROUTINE');
    expect(s.calls.every((c) => !c.argv.join(' ').includes(login.password))).toBe(true);
  });

  it('MySQL: routines through SHOW_ROUTINE', async () => {
    const s = fake((t) => (t.includes('SELECT VERSION()') ? '8.4.2\n' : ''));
    const login = await mintBackupLogin({ ctx: ctx('mysql'), run: s.run }, ['shop']);
    expect(s.calls[1]!.stdin).toContain(`GRANT SHOW_ROUTINE ON *.* TO \`${login.username}\`@\`%\``);
  });

  it('PostgreSQL 14+: reads everything through pg_read_all_data, past row-level security, until tomorrow', async () => {
    const s = fake((t) => (t.includes('server_version_num') ? '160004\n' : t.includes('SHOW server_version') ? '16.4\n' : ''));
    const login = await mintBackupLogin({ ctx: ctx('postgresql'), run: s.run }, ['shop']);
    const create = s.calls.find((c) => c.stdin.startsWith('CREATE ROLE'))!.stdin;
    expect(create).toContain(`CREATE ROLE "${login.username}" LOGIN PASSWORD '${login.password}' VALID UNTIL '`);
    expect(create).toContain('BYPASSRLS IN ROLE pg_read_all_data');
    expect(create).not.toContain('SUPERUSER');
    expect(s.calls.every((c) => !c.argv.join(' ').includes(login.password))).toBe(true);
  });

  it('PostgreSQL 13: refused — only a superuser reads everything there', async () => {
    const s = fake((t) => (t.includes('server_version_num') ? '130016\n' : t.includes('SHOW server_version') ? '13.16\n' : ''));
    await expect(mintBackupLogin({ ctx: ctx('postgresql'), run: s.run }, ['shop'])).rejects.toThrow(/too old/);
    expect(s.calls.some((c) => c.stdin.startsWith('CREATE ROLE'))).toBe(false);
  });

  it('MariaDB: a database named like a wildcard is granted alone', async () => {
    const s = fake((t) => (t.includes('SELECT VERSION()') ? '10.11.9-MariaDB\n' : ''));
    await mintBackupLogin({ ctx: ctx('mariadb'), run: s.run }, ['_ysql', 'a%b']);
    expect(s.calls[1]!.stdin).toContain('ON `\\_ysql`.*');
    expect(s.calls[1]!.stdin).toContain('ON `a\\%b`.*');
  });

  it('MongoDB: the backup role, the password through passwordPrompt() (its mask echoes before the result)', async () => {
    const s = fake((t) => (t.includes('db.version()') ? '7.0.12\n' : t.includes('createUser') ? '********************************ok\n' : ''));
    const login = await mintBackupLogin({ ctx: ctx('mongodb'), run: s.run }, ['shop']);
    const create = s.calls.find((c) => c.argv.join(' ').includes('createUser'))!;
    expect(create.argv.join(' ')).toContain('roles: [{role: "backup", db: "admin"}]');
    expect(create.stdin).toBe(`root-pw\n${login.password}\n`);
    expect(login.serverVersion).toBe('7.0.12');
  });

  it('MongoDB: a failed createUser throws', async () => {
    const s = fake((t) => (t.includes('createUser') ? 'MongoServerError: not authorized\n' : '7.0.12\n'));
    await expect(mintBackupLogin({ ctx: ctx('mongodb'), run: s.run }, ['shop'])).rejects.toThrow(/could not be created/);
  });
});

describe('dropBackupLogin', () => {
  it('drops only a name of its own', async () => {
    const s = fake();
    expect((await dropBackupLogin({ ctx: ctx('mariadb'), run: s.run }, 'dbadmin')).dropped).toBe(false);
    expect(s.calls).toHaveLength(0);
    const name = newBackupLoginName();
    expect(await dropBackupLogin({ ctx: ctx('mariadb'), run: s.run }, name)).toEqual({ dropped: true });
    expect(s.calls[0]!.stdin).toBe(`DROP USER IF EXISTS \`${name}\`@\`%\`;`);
  });

  it('never throws, and says why', async () => {
    const run: DbCommandRunner = async () => { throw new Error('pod gone'); };
    expect(await dropBackupLogin({ ctx: ctx('postgresql'), run }, newBackupLoginName())).toEqual({ dropped: false, error: expect.stringContaining('pod gone') });
  });

  it('MongoDB: a refused dropUser is not a drop, though mongosh prints no ERROR', async () => {
    const s = fake(() => 'MongoServerError: not authorized on admin to execute command\n');
    expect(await dropBackupLogin({ ctx: ctx('mongodb'), run: s.run }, newBackupLoginName()))
      .toEqual({ dropped: false, error: expect.stringContaining('not authorized') });
    const ok = fake(() => 'ok\n');
    expect(await dropBackupLogin({ ctx: ctx('mongodb'), run: ok.run }, newBackupLoginName())).toEqual({ dropped: true });
  });
});
