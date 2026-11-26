/**
 * The tenant's own administrator account on a standalone database instance.
 *
 * Root is the platform's (db-admin-access.ts). The tenant gets an account that
 * can do everything with its data and nothing to the server's accounts:
 *
 *   MariaDB / MySQL — `dbadmin`@'%' with ALL on every tenant database, and on
 *     every database named `db_…` so the tenant (or an app installer) can
 *     create databases in SQL; PROCESS to see the process list. No grants on
 *     the system schema, no CREATE USER, no GRANT OPTION: it cannot reach root
 *     or create accounts (Database Users in the panel do that). "All
 *     databases" app users hold the same grants, and a database created in the
 *     panel is granted to each of them. Direct grants, not a role: see
 *     mysql-hardening.ts allDatabasesGrants.
 *   PostgreSQL — `dbadmin` LOGIN CREATEDB, not a superuser and no CREATEROLE.
 *     It owns the tenant databases the superuser owned, and what the
 *     superuser owns in any of them; it is a member of the app roles, so it
 *     can change their objects too.
 *   MongoDB — `dbadmin` with readWriteAnyDatabase + dbAdminAnyDatabase: no
 *     user administration, so not even its own password can be changed in a
 *     shell.
 *
 * With `harden`, also what a tenant could have left while it held root
 * (mysql-hardening.ts, pg-hardening.ts, mongo-hardening.ts).
 *
 * The platform keeps the password (tenant-admin-store.ts) and is its source of
 * truth: a tenant who changes it in SQL finds it set back on the next check;
 * the panel rotates it. Every step here is idempotent.
 */

import { randomBytes } from 'node:crypto';
import { DbExecError, execInDbPod, type DbManagerContext } from './db-manager.js';
import {
  fromHex, fromHexColumn, hexColumnSql, MONGO_OK_JS, mongoResult, mongoRoot, mysqlAccount, mysqlRoot, mysqlRootScript, mysqlString, outputLines, pgIdent,
  pgString, pgSuperuser, sh, shellQuote, tryRun, works,
  type Command, type DbCommandRunner, type Exec,
} from './db-exec.js';
import { SELF_SERVICE_DB_PREFIX, TENANT_ADMIN_USERNAMES } from './db-account-names.js';
import {
  adoptRootDefinedObjects, allDatabasesGrants, ensureAllDatabasesAccounts, listTenantDatabases, narrowAccount, narrowAccounts, PREFIX_PATTERN,
} from './mysql-hardening.js';
import { clearTenantTemplates, connectableDatabases, hardenClosedDatabase, hardenPostgresCluster, hardenPostgresDatabase } from './pg-hardening.js';
import { demotePrivilegedUsers } from './mongo-hardening.js';

export { SELF_SERVICE_DB_PREFIX, TENANT_ADMIN_USERNAMES };

export interface TenantAdminAccount {
  readonly username: string;
  readonly password: string;
}

export interface TenantAdminOptions {
  /** Also undo what a tenant could have left while it held root — the first check, then daily (db-admin-reconciler.ts). */
  readonly harden: boolean;
}

export interface TenantAdminResult {
  /** What changed, in words. */
  readonly changes: string[];
  /**
   * Hardening steps that failed. Each runs on its own — one failing does not
   * stop the others, nor the account — and the next pass tries it again.
   */
  readonly problems: string[];
}

/** One hardening step: its changes, or its failure noted in `problems`. */
async function step(problems: string[], label: string, fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (err) {
    problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── MariaDB / MySQL ────────────────────────────────────────────────────────

/** As the tenant administrator, over TCP inside the pod — the way a tenant's tool logs in. */
export function asTenantAdminMysql(ctx: DbManagerContext, account: TenantAdminAccount, extra: readonly string[] = []): string[] {
  return [
    ctx.engine === 'mysql' ? 'mysql' : 'mariadb', `-u${account.username}`, `-p${account.password}`, '-h127.0.0.1', '--protocol=TCP',
    ...(ctx.engine === 'mysql' ? ['--get-server-public-key'] : []),
    ...extra,
  ];
}

/** Any account by this name, at any host (choosing a name). */
async function mysqlUserExists(x: Exec, user: string): Promise<boolean> {
  const out = await sh(x, mysqlRoot(x.ctx, `SELECT COUNT(*) FROM mysql.user WHERE User = ${mysqlString(user)}`));
  return out.trim() !== '0';
}

/** The tenant administrator itself: the account at '%' and no other. */
async function mysqlAdminExists(x: Exec, user: string): Promise<boolean> {
  const out = await sh(x, mysqlRoot(x.ctx, `SELECT COUNT(*) FROM mysql.user WHERE User = ${mysqlString(user)} AND Host = '%'`));
  return out.trim() !== '0';
}

/**
 * The tenant administrator logs in with its password AND is the account the
 * platform made: a more specific `'dbadmin'@'127.0.0.1'` (or an anonymous
 * account) would answer the same login with its own privileges.
 */
async function mysqlAdminLogsIn(x: Exec, account: TenantAdminAccount): Promise<boolean> {
  const r = await tryRun(x, asTenantAdminMysql(x.ctx, account, ['--batch', '--skip-column-names', '-e', 'SELECT CURRENT_USER()']));
  return r.ok && r.stdout.trim() === `${account.username}@%`;
}

/** The tenant administrator already holds the prefix grant and PROCESS (the rest ensureAllDatabasesAccounts keeps up). */
async function adminGrantsInPlace(x: Exec, user: string): Promise<boolean> {
  const u = mysqlString(user);
  const out = await sh(x, mysqlRoot(x.ctx,
    `SELECT (SELECT COUNT(*) FROM mysql.db WHERE User = ${u} AND Host = '%' AND Db = ${mysqlString(PREFIX_PATTERN)}), `
    + `(SELECT Process_priv FROM mysql.user WHERE User = ${u} AND Host = '%')`));
  const [n, process] = out.trim().split('\t');
  return n !== '0' && process === 'Y';
}

async function ensureMysqlTenantAdmin(x: Exec, account: TenantAdminAccount, opts: TenantAdminOptions): Promise<TenantAdminResult> {
  const { ctx } = x;
  const changed: string[] = [];
  const problems: string[] = [];
  const acct = `${mysqlString(account.username)}@'%'`;
  // The account first: what follows may fail, and the tenant's own login
  // must not wait on it.
  const others = outputLines(await sh(x, mysqlRoot(ctx,
    `SELECT ${hexColumnSql('Host')} FROM mysql.user WHERE User = ${mysqlString(account.username)} AND Host <> '%'`))).map(fromHexColumn);
  for (const host of others) {
    await sh(x, mysqlRoot(ctx, `DROP USER ${mysqlAccount(account.username, host)}`));
    changed.push(`dropped ${account.username}@${host} (it would answer the tenant administrator's logins)`);
  }
  if (!(await mysqlAdminExists(x, account.username))) {
    await sh(x, mysqlRootScript(ctx, `CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY ${mysqlString(account.password)};\n`));
    changed.push(`created ${account.username}`);
  } else if (!(await mysqlAdminLogsIn(x, account))) {
    await sh(x, mysqlRootScript(ctx, `ALTER USER ${acct} IDENTIFIED BY ${mysqlString(account.password)};\n`));
    changed.push(`set ${account.username}'s password back to the one in the panel`);
  }
  // Nothing it was granted since may stay (narrowed first: PROCESS comes back below).
  changed.push(...(await narrowAccount(x, account.username, '%')));
  if (!(await adminGrantsInPlace(x, account.username))) {
    const grants = [...allDatabasesGrants(acct, await listTenantDatabases(x)), `GRANT PROCESS ON *.* TO ${acct}`];
    await sh(x, mysqlRootScript(ctx, `${grants.join(';\n')};\n`));
  }
  if (opts.harden) {
    changed.push(...(await step(problems, 'narrowing accounts', () => narrowAccounts(x, new Set([account.username])))));
    // After the accounts: the objects' new definer is this account.
    changed.push(...(await step(problems, 'objects that ran as root', () => adoptRootDefinedObjects(x, acct))));
  }
  changed.push(...(await ensureAllDatabasesAccounts(x)));
  return { changes: changed, problems };
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────

/**
 * As the tenant administrator with its password. The image trusts 127.0.0.1,
 * so over the pod's own address, which pg_hba sends to scram. No address, no
 * check: an empty -h would be the socket, which trusts anyone.
 */
function pgTenantAdminLogin(account: TenantAdminAccount): string[] {
  return ['sh', '-c', `h=$(hostname -i | cut -d' ' -f1); [ -n "$h" ] || exit 1; PGPASSWORD=${shellQuote(account.password)} psql -X -h "$h" -U ${shellQuote(account.username)} -d postgres -tAc 'SELECT 1'`];
}

/** The server's own databases: never handed to the tenant. */
const PG_SERVER_DATABASES: ReadonlySet<string> = new Set(['postgres', 'template0', 'template1']);

/** Predefined roles that reach outside the database (pg-hardening.ts). */
const PG_REACHING_ROLES = ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_create_subscription'];

const hex = (expr: string): string => `pg_catalog.encode(pg_catalog.convert_to(${expr}, 'UTF8'), 'hex')`;

async function ensurePostgresTenantAdmin(x: Exec, account: TenantAdminAccount, opts: TenantAdminOptions): Promise<TenantAdminResult> {
  const { ctx } = x;
  const changed: string[] = [];
  const problems: string[] = [];
  const role = pgIdent(account.username);
  const name = pgString(account.username);
  const exists = (await sh(x, pgSuperuser(ctx, `SELECT COUNT(*) FROM pg_catalog.pg_roles WHERE rolname = ${name}`))).trim() !== '0';
  if (!exists) {
    await sh(x, pgSuperuser(ctx, `CREATE ROLE ${role} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pgString(account.password)}`));
    changed.push(`created ${account.username}`);
  } else {
    // The image trusts 127.0.0.1, so test the password where it is checked:
    // the pod's own address, which pg_hba sends to scram.
    if (!(await works(x, pgTenantAdminLogin(account)))) {
      await sh(x, pgSuperuser(ctx, `ALTER ROLE ${role} PASSWORD ${pgString(account.password)}`));
      changed.push(`set ${account.username}'s password back to the one in the panel`);
    }
    const shaped = (await sh(x, pgSuperuser(ctx,
      `SELECT rolcanlogin AND rolcreatedb AND NOT rolsuper AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = ${name}`))).trim();
    if (shaped !== 't') {
      await sh(x, pgSuperuser(ctx, `ALTER ROLE ${role} LOGIN CREATEDB NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS`));
      changed.push(`${account.username} has its attributes back`);
    }
  }
  if (opts.harden) {
    changed.push(...(await step(problems, 'cluster', () => hardenPostgresCluster(x))));
    changed.push(...(await step(problems, 'templates', () => clearTenantTemplates(x))));
  }

  for (const d of await connectableDatabases(x)) {
    // template1 is copied by every CREATE DATABASE, which fails while anyone
    // is connected to it: only in the daily pass. So is a database that
    // refuses connections (template0), opened for the pass only.
    if ((d.name === 'template1' || !d.allowsConnections) && !opts.harden) continue;
    if (!d.allowsConnections) {
      const target = d.owner === ctx.rootUsername ? account.username : d.owner;
      changed.push(...(await step(problems, `database ${d.name}`, () => hardenClosedDatabase(x, d.name, target))));
      continue;
    }
    let owner = d.owner;
    if (d.superuserOwned && !PG_SERVER_DATABASES.has(d.name)) {
      await sh(x, pgSuperuser(ctx, `ALTER DATABASE ${pgIdent(d.name)} OWNER TO ${role}`));
      changed.push(`${account.username} owns the database ${d.name}`);
      owner = account.username;
    }
    // What the superuser owns goes to the database's owner — and in the
    // server's own databases to the tenant administrator: on every check, as a
    // platform restore imports as the superuser.
    const target = owner === ctx.rootUsername ? account.username : owner;
    changed.push(...(await step(problems, `database ${d.name}`, () => hardenPostgresDatabase(x, d.name, target))));
  }

  // Member of the app roles, so it can change what they own — never of one
  // that could SET ROLE to a superuser or reach outside the database, which
  // would lift dbadmin with it.
  const apps = outputLines(await sh(x, pgSuperuser(ctx,
    `SELECT ${hex('r.rolname')} FROM pg_catalog.pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole`
    + ` AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolname <> ${name} AND r.rolname <> current_user AND r.rolname !~ '^pg_'`
    + ` AND NOT pg_catalog.pg_has_role(${name}, r.oid, 'MEMBER') AND NOT pg_catalog.pg_has_role(r.oid, ${name}, 'MEMBER')`
    + ' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles p WHERE (p.rolsuper OR p.rolname IN ('
    + `${PG_REACHING_ROLES.map(pgString).join(', ')})) AND pg_catalog.pg_has_role(r.oid, p.oid, 'MEMBER'))`))).map(fromHex); // allow-array-binding: literals joined into SQL text for psql, not a drizzle bind
  for (const a of apps) {
    await sh(x, pgSuperuser(ctx, `GRANT ${pgIdent(a)} TO ${role}`));
    changed.push(`${account.username} is a member of ${a}`);
  }
  return { changes: changed, problems };
}

// ─── MongoDB ────────────────────────────────────────────────────────────────

const MONGO_TENANT_ADMIN_ROLES = [
  { role: 'readWriteAnyDatabase', db: 'admin' },
  { role: 'dbAdminAnyDatabase', db: 'admin' },
];

async function mongoUserExists(x: Exec, user: string): Promise<boolean> {
  return mongoResult(await sh(x, mongoRoot(x.ctx, `db.getSiblingDB("admin").getUser(${JSON.stringify(user)}) ? "yes" : "no"`))) === 'yes';
}

/** As the tenant administrator, the password on stdin. */
function asTenantAdminMongo(account: TenantAdminAccount): Command {
  return {
    argv: ['mongosh', '--quiet', '--norc', '-u', account.username, '-p', '--authenticationDatabase', 'admin', '--eval', MONGO_OK_JS],
    stdin: `${account.password}\n`,
  };
}

async function ensureMongoTenantAdmin(x: Exec, account: TenantAdminAccount, opts: TenantAdminOptions): Promise<TenantAdminResult> {
  const { ctx } = x;
  const changed: string[] = [];
  const problems: string[] = [];
  const user = JSON.stringify(account.username);
  const roles = JSON.stringify(MONGO_TENANT_ADMIN_ROLES);
  if (!(await mongoUserExists(x, account.username))) {
    await sh(x, mongoRoot(ctx, `db.getSiblingDB("admin").createUser({user: ${user}, pwd: passwordPrompt(), roles: ${roles}}); "ok"`, `${account.password}\n`));
    changed.push(`created ${account.username}`);
  } else {
    if (!(await works(x, asTenantAdminMongo(account)))) {
      await sh(x, mongoRoot(ctx, `db.getSiblingDB("admin").updateUser(${user}, {pwd: passwordPrompt()}); "ok"`, `${account.password}\n`));
      changed.push(`set ${account.username}'s password back to the one in the panel`);
    }
    const current = mongoResult(await sh(x, mongoRoot(ctx,
      `JSON.stringify(db.getSiblingDB("admin").getUser(${user}).roles.map(r => r.role + "@" + r.db).sort())`)));
    if (current !== JSON.stringify(MONGO_TENANT_ADMIN_ROLES.map((r) => `${r.role}@${r.db}`).sort())) {
      await sh(x, mongoRoot(ctx, `db.getSiblingDB("admin").updateUser(${user}, {roles: ${roles}}); "ok"`));
      changed.push(`${account.username} has its roles back`);
    }
  }
  if (opts.harden) changed.push(...(await step(problems, 'privileged users', () => demotePrivilegedUsers(x, new Set([account.username])))));
  return { changes: changed, problems };
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Pick the tenant administrator's name on an instance that has none on record
 * yet: `dbadmin`, unless the tenant already made an account by that name.
 * Never an existing account: tenants held root, so an account they made could
 * carry any privilege — adopting it would hand those to the "tenant
 * administrator". Past the preferred names, a fresh random one.
 */
export async function chooseTenantAdminUsername(ctx: DbManagerContext, run: DbCommandRunner = execInDbPod): Promise<string> {
  const x = { ctx, run };
  const candidates = [...TENANT_ADMIN_USERNAMES, ...Array.from({ length: 5 }, () => `dbadmin_${randomBytes(3).toString('hex')}`)];
  for (const name of candidates) {
    let taken: boolean;
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') taken = await mysqlUserExists(x, name);
    else if (ctx.engine === 'postgresql') {
      taken = (await sh(x, pgSuperuser(ctx, `SELECT COUNT(*) FROM pg_catalog.pg_roles WHERE rolname = ${pgString(name)}`))).trim() !== '0';
    } else taken = await mongoUserExists(x, name);
    if (!taken) return name;
  }
  throw new DbExecError('no free name for the tenant administrator account');
}

/**
 * Bring the tenant administrator to its target shape. Throws DbExecError when
 * the account itself could not be set up; hardening failures come back in
 * `problems`.
 */
export async function ensureTenantAdmin(
  ctx: DbManagerContext,
  account: TenantAdminAccount,
  opts: TenantAdminOptions,
  run: DbCommandRunner = execInDbPod,
): Promise<TenantAdminResult> {
  const x = { ctx, run };
  switch (ctx.engine) {
    case 'mariadb':
    case 'mysql': return ensureMysqlTenantAdmin(x, account, opts);
    case 'postgresql': return ensurePostgresTenantAdmin(x, account, opts);
    case 'mongodb': return ensureMongoTenantAdmin(x, account, opts);
  }
}

/** Does the tenant administrator log in with its password? What a tick between two full checks runs. */
export async function tenantAdminLogsIn(ctx: DbManagerContext, account: TenantAdminAccount, run: DbCommandRunner = execInDbPod): Promise<boolean> {
  const x = { ctx, run };
  switch (ctx.engine) {
    case 'mariadb':
    case 'mysql': return mysqlAdminLogsIn(x, account);
    case 'postgresql': return works(x, pgTenantAdminLogin(account));
    case 'mongodb': return works(x, asTenantAdminMongo(account));
  }
}

/** Set a new password (the panel's rotate). Throws DbExecError. */
export async function setTenantAdminPassword(
  ctx: DbManagerContext,
  account: TenantAdminAccount,
  run: DbCommandRunner = execInDbPod,
): Promise<void> {
  const x = { ctx, run };
  switch (ctx.engine) {
    case 'mariadb':
    case 'mysql':
      await sh(x, mysqlRootScript(ctx, `ALTER USER ${mysqlString(account.username)}@'%' IDENTIFIED BY ${mysqlString(account.password)};\n`));
      return;
    case 'postgresql':
      await sh(x, pgSuperuser(ctx, `ALTER ROLE ${pgIdent(account.username)} PASSWORD ${pgString(account.password)}`));
      return;
    case 'mongodb':
      await sh(x, mongoRoot(ctx, `db.getSiblingDB("admin").updateUser(${JSON.stringify(account.username)}, {pwd: passwordPrompt()}); "ok"`, `${account.password}\n`));
  }
}
