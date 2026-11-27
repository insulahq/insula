/**
 * The platform's own way into a tenant database — one that cannot drift.
 *
 * WHY
 * ---
 * The platform managed every catalog database as root with the root password
 * it generated at create time. The database reads that password only on first
 * start, and the tenant held it too (it was in the panel), as did anything
 * granted `ALL ON *.*`. Any `ALTER USER root …` — or a restore of an older data
 * directory — silently left the platform's copy wrong, and the SQL Manager,
 * the nightly dumps and restores failed from then on. A second, dedicated
 * account would only move the problem: it would need root to be created and
 * repaired.
 *
 * So the administrator login stops being a password at all:
 *   - MariaDB: root@localhost IDENTIFIED VIA unix_socket — the OS user of a
 *     process inside the database pod. Only `kubectl exec` (the platform)
 *     runs one; no stored secret exists to go stale.
 *   - MySQL: the same with auth_socket.
 *   - Both: every other root account (root@'%', root@127.0.0.1, …) is dropped,
 *     so root cannot be reached over the network with any password.
 *   - PostgreSQL: the platform already uses the image's local trust; a
 *     standalone instance's superuser loses its password, so it cannot be
 *     reached over the network either. (Inside an app stack the app connects
 *     as that superuser, so its password stays.)
 *   - MongoDB has no socket login: root keeps its password, which only the
 *     platform knows, and may only log in from inside the pod
 *     (authenticationRestrictions).
 * A socket-authenticated root ignores whatever password a client sends, so
 * every existing `-u root -p<stored>` command works before and after.
 *
 * NEVER BLIND
 * -----------
 * Removing root's password before the socket login is proven would lock the
 * platform out with no way back short of a restart into the reset container.
 * MariaDB adds the socket login NEXT TO the password and logs in through it
 * before removing the password; MySQL proves auth_socket with a throwaway
 * account first. If the socket path does not work in a pod, the password stays
 * and the result says why.
 */

import { DbExecError, execInDbPod, type DbManagerContext } from './db-manager.js';
import { MONGO_OK_JS, mongoResult, mongoRoot, mysqlString, pgSuperuser, sh as mustRun, tryRun, type DbCommandRunner, type Exec, type RunResult } from './db-exec.js';

export type { DbCommandRunner } from './db-exec.js';

/** How the platform reaches the instance's administrator account. */
export type AdminAccessMode =
  /** MariaDB/MySQL: root by OS user over the socket, no password, no network root. */
  | 'socket'
  /** PostgreSQL: the superuser by the image's local trust. */
  | 'trust'
  /** MongoDB: root by a platform-only password, from inside the pod only. */
  | 'restricted'
  /** Still a password (the socket login could not be proven here); see detail. */
  | 'password'
  /** The platform cannot log in as administrator at all. */
  | 'locked';

export interface AdminAccessResult {
  readonly mode: AdminAccessMode;
  /** What this run changed, in words, for the log and the audit trail. */
  readonly changed: readonly string[];
  /** Why the mode is `password` or `locked`. */
  readonly detail?: string;
  /** A step failed part-way: the mode is where it stopped, not where this instance settles. */
  readonly partial?: boolean;
}

export interface AdminAccessOptions {
  /**
   * A standalone database instance (catalog type `database`), not a component
   * of an app stack. Only a standalone instance's administrator login is
   * converted: an app stack's own app may connect as root (or as the
   * PostgreSQL superuser), so a stack keeps its password login and is only
   * checked.
   */
  readonly standalone: boolean;
}

/**
 * The database did not answer (still starting, restarting, crash recovery, the
 * exec could not reach it) — not a refused login. The caller reports the
 * instance as not checked, never as locked: a lockout alert for a database
 * that is only restarting invites a repair restart of a healthy one.
 */
export class DbUnreachableError extends Error {}

/** A login the database itself refused (as opposed to one it never got to judge). */
export function isLoginRefusal(error: string): boolean {
  return /ERROR (1045|1698|3118) \(|Access denied for user|Authentication failed|password authentication failed|role "[^"]*" does not exist|is not permitted to log in|no pg_hba\.conf entry|pg_hba\.conf rejects connection/i.test(error);
}

function clientFor(ctx: DbManagerContext): string {
  return ctx.engine === 'mysql' ? 'mysql' : 'mariadb';
}

/** root over the socket WITHOUT a password — the login this module establishes. */
function socketRoot(ctx: DbManagerContext, sql: string, user = 'root'): string[] {
  return [clientFor(ctx), `-u${user}`, '--protocol=socket', '--batch', '--skip-column-names', '-e', sql];
}

/** root with the stored password — the login it replaces. */
function passwordRoot(ctx: DbManagerContext, sql: string): string[] {
  return [clientFor(ctx), '-uroot', `-p${ctx.rootPassword}`, '--protocol=socket', '--batch', '--skip-column-names', '-e', sql];
}

/** Every root account other than root@localhost, as `'root'@'host'` strings ready for DROP USER. */
async function otherRootAccounts(x: Exec): Promise<string[]> {
  const { ctx } = x;
  const table = ctx.engine === 'mysql' ? 'mysql.user' : 'mysql.global_priv';
  const out = await mustRun(x, socketRoot(ctx,
    `SELECT CONCAT(QUOTE(User), '@', QUOTE(Host)) FROM ${table} WHERE User = 'root' AND Host <> 'localhost'`));
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function closeOtherRootAccounts(x: Exec, changed: string[]): Promise<void> {
  const { ctx } = x;
  for (const account of await otherRootAccounts(x)) {
    await mustRun(x, socketRoot(ctx, `DROP USER IF EXISTS ${account}`));
    changed.push(`dropped ${account.replace(/'/g, '')}`);
  }
}

/** An Exec that also collects what this call changed — kept when a later step fails. */
interface AccessExec extends Exec { readonly changed: string[] }

/** Neither login worked: refused (locked) or never judged (unreachable — throws). */
function lockedOrUnreachable(...failures: RunResult[]): AdminAccessResult {
  const errors = failures.map((f) => f.error);
  if (!errors.some(isLoginRefusal)) throw new DbUnreachableError(errors.filter(Boolean).join('; ') || 'the database did not answer');
  return { mode: 'locked', changed: [], detail: `root refuses both the socket login and the stored password: ${errors[errors.length - 1]}` };
}

/** An app stack's MariaDB/MySQL: root keeps its password; only check that the platform still gets in. */
async function checkStackRoot(x: Exec): Promise<AdminAccessResult> {
  const { ctx } = x;
  const socket = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
  if (socket.ok) return { mode: 'socket', changed: [] };
  const viaPassword = ctx.rootPassword ? await tryRun(x, passwordRoot(ctx, 'SELECT 1')) : { ok: false, stdout: '', error: 'no stored password' };
  if (viaPassword.ok) return { mode: 'password', changed: [], detail: 'an app stack: root keeps its password login (its app may use it)' };
  return lockedOrUnreachable(socket, viaPassword);
}

async function ensureMariadbSocketRoot(x: AccessExec): Promise<AdminAccessResult> {
  const { ctx } = x;
  const { changed } = x;
  const socketFirst = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
  if (!socketFirst.ok) {
    if (!ctx.rootPassword) return lockedOrUnreachable(socketFirst, { ok: false, stdout: '', error: 'Access denied: no stored password' });
    const viaPassword = await tryRun(x, passwordRoot(ctx, 'SELECT 1'));
    if (!viaPassword.ok) return lockedOrUnreachable(socketFirst, viaPassword);
    // Socket login NEXT TO the password, proven before the password goes.
    await mustRun(x, passwordRoot(ctx,
      `ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD(${mysqlString(ctx.rootPassword)})`));
    changed.push('added the socket login to root@localhost');
    const proof = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
    if (!proof.ok) return { mode: 'password', changed, detail: `the socket login does not work in this pod: ${proof.error}` };
  }
  const create = await mustRun(x, socketRoot(ctx, "SHOW CREATE USER 'root'@'localhost'"));
  if (!/IDENTIFIED VIA unix_socket/i.test(create) || /\bOR\b/i.test(create.replace(/^CREATE USER\s+\S+\s*/i, ''))) {
    await mustRun(x, socketRoot(ctx, "ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket"));
    changed.push('root@localhost now logs in by socket only');
  }
  await closeOtherRootAccounts(x, changed);
  const final = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
  if (!final.ok) return { mode: 'locked', changed, detail: `the socket login failed after the change: ${final.error}` };
  return { mode: 'socket', changed };
}

const MYSQL_PROBE = 'insula_socket_probe';

async function ensureMysqlSocketRoot(x: AccessExec): Promise<AdminAccessResult> {
  const { ctx } = x;
  const { changed } = x;
  const socketFirst = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
  const socketWorks = socketFirst.ok;
  const run = (sql: string): string[] => (socketWorks ? socketRoot(ctx, sql) : passwordRoot(ctx, sql));
  if (!socketWorks) {
    if (!ctx.rootPassword) return lockedOrUnreachable(socketFirst, { ok: false, stdout: '', error: 'Access denied: no stored password' });
    const viaPassword = await tryRun(x, passwordRoot(ctx, 'SELECT 1'));
    if (!viaPassword.ok) return lockedOrUnreachable(socketFirst, viaPassword);
  }
  const status = (await mustRun(x, run("SELECT PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_NAME = 'auth_socket'"))).trim();
  if (status !== 'ACTIVE') {
    const installed = await tryRun(x, run("INSTALL PLUGIN auth_socket SONAME 'auth_socket.so'"));
    if (!installed.ok) return { mode: socketWorks ? 'socket' : 'password', changed, detail: `auth_socket could not be installed: ${installed.error}` };
    changed.push('installed auth_socket');
  }
  const plugin = (await mustRun(x, run("SELECT plugin FROM mysql.user WHERE User = 'root' AND Host = 'localhost'"))).trim();
  if (plugin !== 'auth_socket') {
    // Prove auth_socket maps this pod's exec user to root before root depends on it.
    await mustRun(x, run(`DROP USER IF EXISTS '${MYSQL_PROBE}'@'localhost'`));
    await mustRun(x, run(`CREATE USER '${MYSQL_PROBE}'@'localhost' IDENTIFIED WITH auth_socket AS 'root'`));
    const proof = await tryRun(x, socketRoot(ctx, 'SELECT 1', MYSQL_PROBE));
    await mustRun(x, run(`DROP USER IF EXISTS '${MYSQL_PROBE}'@'localhost'`));
    if (!proof.ok) return { mode: 'password', changed, detail: `the socket login does not work in this pod: ${proof.error}` };
    await mustRun(x, run("ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket"));
    changed.push('root@localhost now logs in by socket only');
  }
  await closeOtherRootAccounts(x, changed);
  const final = await tryRun(x, socketRoot(ctx, 'SELECT 1'));
  if (!final.ok) return { mode: 'locked', changed, detail: `the socket login failed after the change: ${final.error}` };
  return { mode: 'socket', changed };
}

async function ensurePostgresTrust(x: AccessExec, opts: AdminAccessOptions): Promise<AdminAccessResult> {
  const { ctx, changed } = x;
  const su = ctx.rootUsername;
  const psql = (sql: string): string[] => pgSuperuser(ctx, sql);
  const probe = await tryRun(x, psql('SELECT rolpassword IS NULL FROM pg_authid WHERE rolname = current_user'));
  if (!probe.ok) {
    if (!isLoginRefusal(probe.error)) throw new DbUnreachableError(probe.error);
    return { mode: 'locked', changed, detail: `the local trust login as ${su} failed: ${probe.error}` };
  }
  if (opts.standalone && probe.stdout.trim() !== 't') {
    await mustRun(x, psql('ALTER ROLE CURRENT_USER PASSWORD NULL'));
    changed.push(`${su} no longer has a password (network login closed)`);
  }
  return { mode: 'trust', changed };
}

/** Root may log in from inside the pod only. */
const MONGO_LOCAL_ONLY = [{ clientSource: ['127.0.0.1', '::1'] }];

async function ensureMongoRestricted(x: AccessExec, opts: AdminAccessOptions): Promise<AdminAccessResult> {
  const { ctx, changed } = x;
  if (!ctx.rootPassword) return { mode: 'locked', changed, detail: 'no stored root password' };
  const user = JSON.stringify(ctx.rootUsername);
  const probe = await tryRun(x, mongoRoot(ctx,
    `JSON.stringify((db.getSiblingDB("admin").getUser(${user}, {showAuthenticationRestrictions: true}) || {}).authenticationRestrictions || [])`));
  if (!probe.ok) {
    if (!isLoginRefusal(probe.error)) throw new DbUnreachableError(probe.error);
    return { mode: 'locked', changed, detail: `the root login failed: ${probe.error}` };
  }
  const current = mongoResult(probe.stdout);
  // An app stack's app may connect as root over the network: checked, not restricted.
  if (!opts.standalone) return { mode: 'password', changed, detail: 'an app stack: root keeps its network login (its app may use it)' };
  if (current !== JSON.stringify(MONGO_LOCAL_ONLY)) {
    await mustRun(x, mongoRoot(ctx,
      `db.getSiblingDB("admin").updateUser(${user}, {authenticationRestrictions: ${JSON.stringify(MONGO_LOCAL_ONLY)}}); "ok"`));
    changed.push(`${ctx.rootUsername} may log in from inside the pod only`);
  }
  return { mode: 'restricted', changed };
}

/**
 * Bring one instance's administrator login to its target shape and report it.
 * Idempotent; never throws for a database that answers — a failure part-way is
 * reported as the mode reached so far. Throws only for an exec that could not
 * reach the pod at all, which the caller treats as "not checked".
 */
export async function ensureDatabaseAdminAccess(
  ctx: DbManagerContext,
  opts: AdminAccessOptions,
  run: DbCommandRunner = execInDbPod,
): Promise<AdminAccessResult> {
  const x: AccessExec = { ctx, run, changed: [] };
  try {
    switch (ctx.engine) {
      case 'mariadb': return await (opts.standalone ? ensureMariadbSocketRoot(x) : checkStackRoot(x));
      case 'mysql': return await (opts.standalone ? ensureMysqlSocketRoot(x) : checkStackRoot(x));
      case 'postgresql': return await ensurePostgresTrust(x, opts);
      case 'mongodb': return await ensureMongoRestricted(x, opts);
    }
  } catch (err) {
    if (!(err instanceof DbExecError) || err instanceof DbUnreachableError) throw err;
    // A step failed part-way. Report the login as it stands — never as the
    // target, which would let the hardening pass assume what is not done yet
    // (a password root@'%' may still be there) — and keep what did change.
    const changed = [...x.changed];
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      if ((await tryRun(x, socketRoot(ctx, 'SELECT 1'))).ok
        || (ctx.rootPassword && (await tryRun(x, passwordRoot(ctx, 'SELECT 1'))).ok)) {
        return { mode: 'password', changed, detail: `a step failed, the next check tries again: ${err.message}`, partial: true };
      }
    }
    if (!isLoginRefusal(err.message)) throw new DbUnreachableError(err.message);
    return { mode: 'locked', changed, detail: err.message };
  }
}

/**
 * Does the platform still log in, the way `mode` says it does? One command:
 * what a tick between two full checks runs (db-admin-reconciler.ts).
 */
export async function adminLoginWorks(ctx: DbManagerContext, mode: AdminAccessMode, run: DbCommandRunner = execInDbPod): Promise<boolean> {
  const x: Exec = { ctx, run };
  switch (mode) {
    case 'socket': return (await tryRun(x, socketRoot(ctx, 'SELECT 1'))).ok;
    case 'password':
      if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') return (await tryRun(x, passwordRoot(ctx, 'SELECT 1'))).ok;
      if (ctx.engine === 'postgresql') return (await tryRun(x, pgSuperuser(ctx, 'SELECT 1'))).ok;
      return mongoResult((await tryRun(x, mongoRoot(ctx, MONGO_OK_JS))).stdout) === 'ok';
    case 'trust': return (await tryRun(x, pgSuperuser(ctx, 'SELECT 1'))).ok;
    case 'restricted': return mongoResult((await tryRun(x, mongoRoot(ctx, MONGO_OK_JS))).stdout) === 'ok';
    default: return false;
  }
}
