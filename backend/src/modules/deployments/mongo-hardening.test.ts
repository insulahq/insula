import { describe, expect, it } from 'vitest';
import { DbExecError, type DbManagerContext } from './db-manager.js';
import type { DbCommandRunner } from './db-exec.js';
import { demotePrivilegedUsers, rootLogsInWith, rotateRoot, unsafeRoles } from './mongo-hardening.js';

const hex = (s: string): string => Buffer.from(s).toString('hex');

function ctx(over: Partial<DbManagerContext> = {}): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine: 'mongodb', rootPassword: 'old-root-pw', rootUsername: 'root', ...over };
}

const user = (u: string, db: string, ...roles: Array<[string, string]>) => ({ user: u, db, roles: roles.map(([role, d]) => ({ role, db: d })) });

describe('unsafeRoles', () => {
  it.each([
    ['root', 'admin'], ['userAdmin', 'admin'], ['userAdminAnyDatabase', 'admin'], ['dbOwner', 'admin'], ['__system', 'admin'], ['backup', 'admin'],
    ['clusterAdmin', 'admin'], ['myCustomRole', 'admin'],
    ['read', 'config'], ['readWrite', 'config'],
    ['readWrite', 'local'], ['dbAdmin', 'local'],
  ])('%s on %s is not kept', (role, db) => {
    expect(unsafeRoles(user('u', 'admin', [role, db]))).toEqual([{ role, db }]);
  });

  it.each([
    ['read', 'admin'], ['readWrite', 'admin'], ['readAnyDatabase', 'admin'], ['readWriteAnyDatabase', 'admin'], ['dbAdminAnyDatabase', 'admin'],
    ['clusterMonitor', 'admin'],
    ['read', 'local'],
    ['root', 'shop'], ['userAdmin', 'shop'], ['dbOwner', 'shop'], ['readWrite', 'shop'],
  ])('%s on %s is kept', (role, db) => {
    expect(unsafeRoles(user('u', 'admin', [role, db]))).toEqual([]);
  });

  it('picks the unsafe ones out of a mixed list, in order', () => {
    const roles = unsafeRoles(user('u', 'shop', ['readWrite', 'shop'], ['root', 'admin'], ['read', 'local'], ['userAdmin', 'admin']));
    expect(roles).toEqual([{ role: 'root', db: 'admin' }, { role: 'userAdmin', db: 'admin' }]);
  });

  it('no roles, nothing to remove', () => {
    expect(unsafeRoles(user('u', 'admin'))).toEqual([]);
  });
});

describe('demotePrivilegedUsers', () => {
  const server = (users: ReturnType<typeof user>[], extraLines: string[] = []) => {
    const evals: string[] = [];
    const stdins: Array<string | undefined> = [];
    const run: DbCommandRunner = async (_c, argv, stdin) => {
      const js = argv[argv.indexOf('--eval') + 1]!;
      evals.push(js);
      stdins.push(stdin);
      if (js.includes('system.users')) return { stdout: [...extraLines, ...users.map((u) => hex(JSON.stringify(u)))].join('\n'), stderr: '' };
      return { stdout: 'ok', stderr: '' };
    };
    return { evals, stdins, run };
  };
  const x = (run: DbCommandRunner) => ({ ctx: ctx(), run });

  it('keeps root and the tenant administrator, demotes everyone else holding admin roles', async () => {
    const s = server([
      user('root', 'admin', ['root', 'admin']),
      user('dbadmin', 'admin', ['userAdminAnyDatabase', 'admin']),
      user('evil', 'admin', ['root', 'admin'], ['readWrite', 'shop']),
      user('safe', 'admin', ['readWriteAnyDatabase', 'admin']),
      user('app', 'shop', ['readWrite', 'shop']),
    ]);
    const changed = await demotePrivilegedUsers(x(s.run), new Set(['dbadmin']));
    expect(changed).toEqual(['evil@admin no longer holds root (it keeps read/write on every database)']);
    const write = s.evals.filter((e) => !e.includes('system.users'));
    expect(write).toHaveLength(1);
    expect(write[0]).toBe(
      'const d = db.getSiblingDB("admin"); d.grantRolesToUser("evil", [{"role":"readWriteAnyDatabase","db":"admin"},{"role":"dbAdminAnyDatabase","db":"admin"}]);'
      + ' d.revokeRolesFromUser("evil", [{"role":"root","db":"admin"}]); "ok"',
    );
  });

  it("leaves a fresh backup run's login its backup role, drops one left behind", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = `platform_bk_${now - 60}_abc123`;
    const stale = `platform_bk_${now - 13 * 3600}_abc123`;
    const s = server([user(fresh, 'admin', ['backup', 'admin']), user(stale, 'admin', ['backup', 'admin']), user(fresh, 'shop', ['backup', 'admin'])]);
    const changed = await demotePrivilegedUsers(x(s.run), new Set(['dbadmin']));
    expect(s.evals).toContain(`db.getSiblingDB("admin").dropUser(${JSON.stringify(stale)}); "ok"`);
    expect(changed).toEqual([
      `dropped ${stale}, a backup login left behind`,
      // Not in admin: not one of ours, demoted like any user.
      `${fresh}@shop no longer holds backup (it keeps read/write on every database)`,
    ]);
  });

  it('grants the data roles BEFORE revoking, so a failure in between never leaves the user with less', async () => {
    const s = server([user('evil', 'admin', ['userAdmin', 'admin'])]);
    await demotePrivilegedUsers(x(s.run), new Set());
    const js = s.evals.find((e) => e.includes('grantRolesToUser'))!;
    expect(js.indexOf('grantRolesToUser')).toBeLessThan(js.indexOf('revokeRolesFromUser'));
  });

  it('a user in another database named like root is not root', async () => {
    const s = server([user('root', 'shop', ['root', 'admin'])]);
    const changed = await demotePrivilegedUsers(x(s.run), new Set());
    expect(changed).toEqual(['root@shop no longer holds root (it keeps read/write on every database)']);
    expect(s.evals.at(-1)).toContain('db.getSiblingDB("shop")');
  });

  it('a user in another database named like the kept one is not kept', async () => {
    const s = server([user('dbadmin', 'shop', ['root', 'admin'])]);
    expect(await demotePrivilegedUsers(x(s.run), new Set(['dbadmin']))).toHaveLength(1);
  });

  it('names are quoted as JSON, so a name cannot leave the string', async () => {
    const evil = 'a"); db.dropDatabase(); ("';
    const s = server([user(evil, 'admin', ['root', 'admin'])]);
    await demotePrivilegedUsers(x(s.run), new Set());
    const js = s.evals.at(-1)!;
    expect(js).toContain(`d.grantRolesToUser(${JSON.stringify(evil)},`);
    expect(js).toContain(`d.revokeRolesFromUser(${JSON.stringify(evil)},`);
  });

  it('a second run, once everything is demoted, changes nothing', async () => {
    const s = server([user('root', 'admin', ['root', 'admin']), user('evil', 'admin', ['readWriteAnyDatabase', 'admin'], ['dbAdminAnyDatabase', 'admin'])]);
    expect(await demotePrivilegedUsers(x(s.run), new Set())).toEqual([]);
    expect(s.evals).toHaveLength(1);
  });

  it('lines that are not hex (a warning) are skipped, never parsed', async () => {
    const s = server([user('evil', 'admin', ['root', 'admin'])], ['Warning: deprecated', 'not-hex-zz']);
    expect(await demotePrivilegedUsers(x(s.run), new Set())).toHaveLength(1);
  });

  it('logs in as root with the password on stdin only', async () => {
    const s = server([]);
    await demotePrivilegedUsers(x(s.run), new Set());
    expect(s.stdins).toEqual(['old-root-pw\n']);
  });

  it('a failing demotion is an error', async () => {
    const run: DbCommandRunner = async (_c, argv) => {
      if (argv[argv.indexOf('--eval') + 1]!.includes('system.users')) return { stdout: hex(JSON.stringify(user('evil', 'admin', ['root', 'admin']))), stderr: '' };
      throw new DbExecError('MongoServerError: not authorized');
    };
    await expect(demotePrivilegedUsers(x(run), new Set())).rejects.toThrow('not authorized');
  });
});

describe('rotateRoot', () => {
  it('sets the new password through the second stdin line, then proves it logs in', async () => {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const run: DbCommandRunner = async (_c, argv, stdin) => {
      calls.push({ argv, stdin });
      return { stdout: calls.length === 1 ? 'rotated' : 'ok', stderr: '' };
    };
    expect(await rotateRoot({ ctx: ctx(), run }, 'new-pw')).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.stdin).toBe('old-root-pw\nnew-pw\n');
    expect(calls[0]!.argv[calls[0]!.argv.indexOf('--eval') + 1]).toBe('db.getSiblingDB("admin").updateUser("root", {pwd: passwordPrompt()}); "rotated"');
    // the proof logs in with the NEW password
    expect(calls[1]!.stdin).toBe('new-pw\n');
    for (const c of calls) expect(c.argv.join('\u0000')).not.toMatch(/old-root-pw|new-pw/);
  });

  it('is false when the new password does not log in', async () => {
    let n = 0;
    const run: DbCommandRunner = async () => { n += 1; if (n === 1) return { stdout: 'rotated', stderr: '' }; throw new DbExecError('Authentication failed'); };
    expect(await rotateRoot({ ctx: ctx(), run }, 'new-pw')).toBe(false);
  });

  it('is false when the proof prints something else', async () => {
    let n = 0;
    const run: DbCommandRunner = async () => ({ stdout: n++ === 0 ? 'rotated' : 'nope', stderr: '' });
    expect(await rotateRoot({ ctx: ctx(), run }, 'new-pw')).toBe(false);
  });

  it('a failed update is an error and no proof is attempted', async () => {
    let n = 0;
    const run: DbCommandRunner = async () => { n += 1; throw new DbExecError('MongoServerError: not authorized'); };
    await expect(rotateRoot({ ctx: ctx(), run }, 'new-pw')).rejects.toThrow('not authorized');
    expect(n).toBe(1);
  });

  it('uses the configured root user name', async () => {
    const seen: string[] = [];
    const run: DbCommandRunner = async (_c, argv) => { seen.push(argv[argv.indexOf('-u') + 1]!, argv[argv.indexOf('--eval') + 1]!); return { stdout: 'ok', stderr: '' }; };
    await rotateRoot({ ctx: ctx({ rootUsername: 'boss' }), run }, 'p');
    expect(seen[0]).toBe('boss');
    expect(seen[1]).toContain('updateUser("boss"');
  });
});

describe('rootLogsInWith', () => {
  it('is true when root logs in with that password (sent on stdin)', async () => {
    let stdin: string | undefined;
    const run: DbCommandRunner = async (_c, _a, s) => { stdin = s; return { stdout: 'ok\n', stderr: '' }; };
    expect(await rootLogsInWith({ ctx: ctx(), run }, 'candidate')).toBe(true);
    expect(stdin).toBe('candidate\n');
  });

  it('is false for a refusal and for output that is not ok', async () => {
    expect(await rootLogsInWith({ ctx: ctx(), run: async () => { throw new DbExecError('Authentication failed'); } }, 'x')).toBe(false);
    expect(await rootLogsInWith({ ctx: ctx(), run: async () => ({ stdout: 'hello', stderr: '' }) }, 'x')).toBe(false);
    expect(await rootLogsInWith({ ctx: ctx(), run: async () => ({ stdout: '', stderr: 'MongoServerError: ERROR auth' }) }, 'x')).toBe(false);
  });
});
