/**
 * A login minted for one backup or restore run (phase 4 of the database backup
 * work). The dump runs in a Job beside the database and connects over the
 * network, while root stays the platform's socket login (db-admin-access.ts).
 * So each run creates its own account with only what a dump (or a restore)
 * needs, through the platform's login, and drops it when the run ends.
 *
 * Names carry their creation time (`platform_bk_<unix seconds>_<hex>`, 29 characters: MySQL allows 32): the
 * hardening pass leaves a fresh one alone and drops one left behind by a run
 * that never finished (mysql-hardening.ts, pg-hardening.ts,
 * mongo-hardening.ts). Passwords travel on stdin, never in a command line.
 */
import { randomBytes } from 'node:crypto';
import type { Exec } from './db-exec.js';
import {
  grantPattern,
  mongoResult,
  mongoRoot,
  mysqlAccount,
  mysqlIdent,
  mysqlRootScript,
  mysqlString,
  pgDbConnInfo,
  pgIdent,
  pgString,
  sh,
  tryRun,
  type Command,
} from './db-exec.js';
import { PG_RECONCILER_SESSION_SH } from './pg-session.js';
import { BACKUP_LOGIN_PREFIX } from './db-account-names.js';

export { BACKUP_LOGIN_PREFIX };

/**
 * A login older than this belongs to a run that never cleaned up: it is
 * minted right before its Job, which stops after 6 hours (database-job.ts
 * JOB_DEADLINE_SECONDS), and dropped right after.
 */
export const BACKUP_LOGIN_MAX_AGE_MS = 7 * 60 * 60 * 1000;

const NAME_RE = /^platform_bk_(\d{9,12})_[0-9a-f]{6}$/;

export interface BackupLogin {
  readonly username: string;
  readonly password: string;
  /** What the server reports (`SELECT VERSION()`, `server_version`, `db.version()`). */
  readonly serverVersion: string;
}

export function newBackupLoginName(now: number = Date.now()): string {
  return `${BACKUP_LOGIN_PREFIX}${Math.floor(now / 1000)}_${randomBytes(3).toString('hex')}`;
}

/** True for a name this module made. */
export function isBackupLoginName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Clock skew tolerated between the API and a database server's view of "now". */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * What the hardening pass does with an account: `fresh` — a run's login,
 * left alone; `stale` — left behind (or dated in the future, which no run
 * mints: a name alone must not keep an account out of the pass), dropped;
 * `other` — not a backup login, hardened like any account.
 */
export function classifyBackupLogin(name: string, now: number = Date.now()): 'fresh' | 'stale' | 'other' {
  const m = NAME_RE.exec(name);
  if (!m) return 'other';
  const age = now - Number(m[1]) * 1000;
  return age > BACKUP_LOGIN_MAX_AGE_MS || age < -FUTURE_SKEW_MS ? 'stale' : 'fresh';
}

/** True for a login of this module's left behind by a run that never finished. */
export function isStaleBackupLogin(name: string, now: number = Date.now()): boolean {
  return classifyBackupLogin(name, now) === 'stale';
}

/** Alphanumeric: safe in a client config file, a YAML line and an env value. */
function newPassword(): string {
  return randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, 'x');
}

/** psql as the superuser, the SQL on stdin (a password never shows in argv). */
function pgSuperuserScript(x: Exec, sql: string, database = 'postgres'): Command {
  return {
    argv: ['sh', '-c', PG_RECONCILER_SESSION_SH, 'sh', 'psql', '-X', '-U', x.ctx.rootUsername, '-d', pgDbConnInfo(database), '-v', 'ON_ERROR_STOP=1', '-qtA'],
    stdin: `${sql}\n`,
  };
}

/** What the server reports as its version (the same query a minted login records). */
export async function readServerVersion(x: Exec): Promise<string> {
  switch (x.ctx.engine) {
    case 'mariadb':
    case 'mysql':
      return (await sh(x, mysqlRootScript(x.ctx, 'SELECT VERSION();'))).trim();
    case 'postgresql':
      return (await sh(x, pgSuperuserScript(x, 'SHOW server_version;'))).trim();
    case 'mongodb':
      return mongoResult(await sh(x, mongoRoot(x.ctx, 'db.version()'))).trim();
  }
}

/** The leading `major.minor` of a version string (PostgreSQL: major only, minors are compatible). */
export function comparableVersion(engine: string, version: string): readonly number[] | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  return engine === 'postgresql' ? [Number(m[1])] : [Number(m[1]), Number(m[2] ?? 0)];
}

/**
 * True when a dump from `from` may not load into a server at `to`: a newer
 * release's dump uses what an older one lacks (MariaDB's newer collations,
 * pg_dump's archive format). Unknown versions do not block.
 */
export function dumpIsNewerThanServer(engine: string, from: string, to: string): boolean {
  const a = comparableVersion(engine, from);
  const b = comparableVersion(engine, to);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Creates the run's login with read access to `databases` and returns it with
 * the server's version. (A restore logs in as the tenant's administrator, not
 * as anything minted: the dump's code must not run with more than the tenant
 * holds.)
 */
export async function mintBackupLogin(x: Exec, databases: readonly string[]): Promise<BackupLogin> {
  const username = newBackupLoginName();
  const password = newPassword();
  switch (x.ctx.engine) {
    case 'mariadb':
    case 'mysql': {
      const serverVersion = (await sh(x, mysqlRootScript(x.ctx, 'SELECT VERSION();'))).trim();
      const account = mysqlAccount(username, '%');
      // A name is a pattern in a GRANT: `_` and `%` are escaped, so a database
      // named like a wildcard grants that database alone.
      const grants = databases.map((d) => `GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON ${mysqlIdent(grantPattern(d))}.* TO ${account};`).join('\n');
      // Routine bodies: MySQL reads them with SHOW_ROUTINE; MariaDB from
      // mysql.proc (it has no such privilege before 11.3).
      const routines = x.ctx.engine === 'mysql'
        ? `GRANT SHOW_ROUTINE ON *.* TO ${account};`
        : `GRANT SELECT ON mysql.proc TO ${account};`;
      await sh(x, mysqlRootScript(x.ctx, [
        `CREATE USER ${account} IDENTIFIED BY ${mysqlString(password)};`,
        grants,
        routines,
      ].join('\n')));
      return { username, password, serverVersion };
    }
    case 'postgresql': {
      const num = Number((await sh(x, pgSuperuserScript(x, 'SHOW server_version_num;'))).trim()) || 0;
      const serverVersion = (await sh(x, pgSuperuserScript(x, 'SHOW server_version;'))).trim();
      // pg_read_all_data (14+) reads every table, sequence and schema;
      // BYPASSRLS lets pg_dump read a table with row-level security. Before
      // 14 only a superuser reads everything, and a superuser dumping what
      // the tenant wrote is one pg_dump bug away from running it: refused.
      if (num < 140000) throw new Error(`PostgreSQL ${serverVersion || 'before 14'} is too old to be backed up one database at a time: update the instance`);
      const until = new Date(Date.now() + BACKUP_LOGIN_MAX_AGE_MS).toISOString();
      await sh(x, pgSuperuserScript(x, `CREATE ROLE ${pgIdent(username)} LOGIN PASSWORD ${pgString(password)} VALID UNTIL ${pgString(until)} BYPASSRLS IN ROLE pg_read_all_data;`));
      return { username, password, serverVersion };
    }
    case 'mongodb': {
      const serverVersion = mongoResult(await sh(x, mongoRoot(x.ctx, 'db.version()'))).trim();
      const js = `db.getSiblingDB("admin").createUser({user: ${JSON.stringify(username)}, pwd: passwordPrompt(), roles: [{role: "backup", db: "admin"}]}); String("ok")`;
      // passwordPrompt() echoes a mask onto the same line as the result.
      const out = mongoResult(await sh(x, mongoRoot(x.ctx, js, `${password}\n`)));
      if (!/(^|\*)ok$/.test(out)) throw new Error(`the backup login could not be created: ${out.replace(/^\*+/, '').slice(0, 200)}`);
      return { username, password, serverVersion };
    }
  }
}

/** Drops the run's login. Never throws: a login left behind is dropped by the hardening pass. */
export async function dropBackupLogin(x: Exec, username: string): Promise<boolean> {
  if (!isBackupLoginName(username)) return false;
  switch (x.ctx.engine) {
    case 'mariadb':
    case 'mysql':
      return (await tryRun(x, mysqlRootScript(x.ctx, `DROP USER IF EXISTS ${mysqlAccount(username, '%')};`))).ok;
    case 'postgresql':
      return (await tryRun(x, pgSuperuserScript(x, `DROP ROLE IF EXISTS ${pgIdent(username)};`))).ok;
    case 'mongodb':
      return (await tryRun(x, mongoRoot(x.ctx, `db.getSiblingDB("admin").dropUser(${JSON.stringify(username)}); String("ok")`))).ok;
  }
}
