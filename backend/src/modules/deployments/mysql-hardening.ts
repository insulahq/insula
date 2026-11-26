/**
 * What a tenant could have left on a MariaDB/MySQL instance while it held
 * root — closed before the platform relies on root being its own.
 *
 * An instance the platform has not yet taken over (db-admin-access.ts) gave
 * the tenant the root password, and anything root can do it could have done,
 * including keeping a way back in for after root is the platform's:
 *   - an account with global privileges (CREATE USER, FILE, SUPER, …) or a
 *     grant reaching the system schema — `mysql.*` IS root: rewrite
 *     mysql.global_priv, and the next restart obeys;
 *   - a PROXY grant, or (MySQL, where any account can be granted as a role)
 *     root itself granted as a role, or named in mandatory_roles;
 *   - a routine, trigger, view or event whose DEFINER is root (or one of the
 *     server's own accounts): it runs with root's privileges for whoever may
 *     call it, or write to its table;
 *   - MySQL: settings root persisted (`mandatory_roles` hands a role to every
 *     account, `init_connect` runs SQL in every session) — back at every start.
 * The third is common without any malice: a dump imported as root creates its
 * views and triggers DEFINER=root.
 *
 * narrowAccounts() leaves every other account what it could do in the
 * tenant's own databases and nothing more: the same privileges, granted on
 * each tenant database instead of on `*.*` or on a pattern that also matched
 * `mysql`. adoptRootDefinedObjects() makes the tenant administrator the
 * definer of every such object, which otherwise stays as it was; the tenant
 * cannot name another definer, so that holds.
 */

import { randomBytes } from 'node:crypto';
import { SELF_SERVICE_DB_PREFIX } from './db-account-names.js';
import { DbExecError } from './db-manager.js';
import {
  fromHexColumn, hexColumnSql as hx, mysqlAccount, MYSQL_SYSTEM_SCHEMAS, mysqlIdent, mysqlRoot, mysqlRootScript, mysqlString, outputLines, sh, tryRun, unescapeBatch,
  type Exec,
} from './db-exec.js';

/** The server's own accounts: left as they are, and the definers that run with more than a tenant has. */
export const MYSQL_SYSTEM_USERS: ReadonlySet<string> = new Set(['root', 'mariadb.sys', 'mysql.sys', 'mysql.session', 'mysql.infoschema']);

/** Global privileges an account may keep: they show things, they change nothing. */
const HARMLESS_GLOBAL: ReadonlySet<string> = new Set([
  'USAGE', 'PROCESS', 'SHOW DATABASES', 'REPLICATION CLIENT', 'BINLOG MONITOR', 'REPLICA MONITOR', 'SLAVE MONITOR',
]);

/** Privileges that mean something on one database — what a global grant of them becomes. */
const DATABASE_PRIVILEGES: ReadonlySet<string> = new Set([
  'ALL PRIVILEGES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER',
  'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE',
  'EVENT', 'TRIGGER', 'DELETE HISTORY', 'SHOW CREATE ROUTINE',
]);

/** The GRANT pattern matching exactly this database (`_` and `%` are wildcards there). */
export function grantPattern(db: string): string {
  return db.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
}

/** What every "all databases" account holds — the self-service prefix — and so the mark of one. */
export const PREFIX_PATTERN = `${grantPattern(SELF_SERVICE_DB_PREFIX)}%`;

/** Does a GRANT database pattern (LIKE syntax, `\` escapes) match this name? Case-insensitive: errs towards yes. */
export function patternMatches(pattern: string, name: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      i += 1;
      re += escapeRegex(pattern[i]);
    } else if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += escapeRegex(ch);
  }
  return new RegExp(`^${re}$`, 'is').test(name);
}

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function reachesSystemSchema(pattern: string): boolean {
  return [...MYSQL_SYSTEM_SCHEMAS].some((s) => patternMatches(pattern, s));
}

export async function listTenantDatabases(x: Exec): Promise<string[]> {
  const out = await sh(x, mysqlRoot(x.ctx, `SELECT ${hx('SCHEMA_NAME')} FROM information_schema.SCHEMATA`));
  return outputLines(out).map(fromHexColumn).filter((d) => !MYSQL_SYSTEM_SCHEMAS.has(d.toLowerCase()));
}

/** `'user'@'host'`, or a MariaDB role (no host). */
export function accountSql(user: string, host: string | null): string {
  return mysqlAccount(user, host);
}

// ─── Reading SHOW GRANTS ────────────────────────────────────────────────────

const Q = '`(?:[^`]|``)*`';
const PRIV_ITEM = `[A-Z][A-Z_ ]*?(?: \\(${Q}(?:, ${Q})*\\))?`;
const GRANT_RE = new RegExp(`^GRANT (${PRIV_ITEM}(?:, ?${PRIV_ITEM})*) ON (?:(PROCEDURE|FUNCTION|PACKAGE BODY|PACKAGE) )?(\\*|${Q})\\.(\\*|${Q}) TO (.*)$`, 's');
const PROXY_RE = new RegExp(`^GRANT PROXY ON (${Q}@${Q}|'[^']*'@'[^']*') TO `, 's');
const ROLE_RE = new RegExp(`^(?:GRANT ${Q}(?:@${Q})?(?:, ?${Q}(?:@${Q})?)* TO |SET DEFAULT ROLE )`, 's');

export type ParsedGrant =
  | { readonly kind: 'proxy'; readonly line: string; readonly target: string }
  | { readonly kind: 'role'; readonly line: string; readonly roles: string[] }
  | { readonly kind: 'global'; readonly line: string; readonly privileges: string[]; readonly grantOption: boolean }
  | { readonly kind: 'database'; readonly line: string; readonly privileges: string[]; readonly pattern: string; readonly grantOption: boolean }
  | { readonly kind: 'object'; readonly line: string; readonly schema: string; readonly privilegeList: string; readonly target: string; readonly grantOption: boolean }
  | { readonly kind: 'unknown'; readonly line: string };

function unquote(q: string): string {
  return q.slice(1, -1).replace(/``/g, '`');
}

/** `GRANT `r1`@`%`, `r2` TO …` → ['`r1`@`%`', '`r2`'] (SET DEFAULT ROLE lines grant nothing). */
function grantedRoles(line: string): string[] {
  if (!line.startsWith('GRANT ')) return [];
  const list = line.slice('GRANT '.length, line.search(/ TO /));
  return list.match(new RegExp(`${Q}(?:@${Q})?`, 'g')) ?? [];
}

/** A granted role that is one of the server's own accounts (MySQL: `GRANT root@localhost TO x` is root). */
function isSystemRole(role: string): boolean {
  const user = /^`((?:[^`]|``)*)`/.exec(role)?.[1]?.replace(/``/g, '`') ?? '';
  return MYSQL_SYSTEM_USERS.has(user);
}

function splitPrivileges(list: string): string[] {
  return list.split(/,(?![^(]*\))/).map((p) => p.trim().toUpperCase()).filter(Boolean);
}

export function parseGrant(line: string): ParsedGrant {
  const proxy = PROXY_RE.exec(line);
  if (proxy) return { kind: 'proxy', line, target: proxy[1] };
  const m = GRANT_RE.exec(line);
  if (!m) return ROLE_RE.test(line) ? { kind: 'role', line, roles: grantedRoles(line) } : { kind: 'unknown', line };
  const [, privs, routine, schema, object, rest] = m;
  if (schema === '*' && object === '*') {
    return { kind: 'global', line, privileges: splitPrivileges(privs), grantOption: /\bWITH GRANT OPTION\b/.test(rest) };
  }
  if (schema === '*') return { kind: 'unknown', line };
  const grantOption = /\bWITH GRANT OPTION\b/.test(rest);
  if (object === '*' && !routine) return { kind: 'database', line, privileges: splitPrivileges(privs), pattern: unquote(schema), grantOption };
  return { kind: 'object', line, schema: unquote(schema), privilegeList: privs, target: `${routine ? `${routine} ` : ''}${schema}.${object}`, grantOption };
}

/** A grant the account may keep as it is. */
function isSafe(g: ParsedGrant): boolean {
  switch (g.kind) {
    case 'role': return !g.roles.some(isSystemRole);
    case 'global': return !g.grantOption && g.privileges.every((p) => HARMLESS_GLOBAL.has(p));
    case 'database': return !reachesSystemSchema(g.pattern);
    case 'object': return !MYSQL_SYSTEM_SCHEMAS.has(g.schema.toLowerCase());
    default: return false;
  }
}

/**
 * The statements that leave the account its reach into tenant databases and
 * nothing else, or none when it already has no more. Pure.
 *
 * Grants first, revokes after, each revoke only of what is unsafe: a run cut
 * off anywhere (a restart, a dropped exec) leaves the account with MORE than
 * its target, never less — and still unsafe, so the next run finishes it. A
 * leading REVOKE ALL would leave it with nothing, and "safe", for good.
 */
export function narrowingStatements(account: string, grants: readonly ParsedGrant[], tenantDatabases: readonly string[]): string[] {
  if (grants.every(isSafe)) return [];
  const add: string[] = [];
  const remove: string[] = [];
  // Global grant options last, once: on MySQL a REVOKE GRANT OPTION ON *.*
  // before the revoke of dynamic privileges (BACKUP_ADMIN, …) leaves those in
  // place for good, and the later revoke takes only their grant option.
  let globalGrantOption = false;
  const grantOn = (privs: readonly string[], patterns: readonly string[]): void => {
    if (privs.length === 0) return;
    for (const p of patterns) add.push(`GRANT ${privs.join(', ')} ON ${mysqlIdent(p)}.* TO ${account}`);
  };
  for (const g of grants) {
    if (isSafe(g)) continue;
    switch (g.kind) {
      case 'proxy':
        remove.push(`REVOKE PROXY ON ${g.target} FROM ${account}`);
        break;
      case 'role':
        remove.push(`REVOKE ${g.roles.filter(isSystemRole).join(', ')} FROM ${account}`);
        break;
      case 'global': {
        // What it could do to data everywhere, it now does in every tenant
        // database — and in the ones created later (the prefix).
        grantOn(g.privileges.filter((p) => DATABASE_PRIVILEGES.has(p)), [PREFIX_PATTERN, ...tenantDatabases.map(grantPattern)]);
        const unsafe = g.privileges.filter((p) => !HARMLESS_GLOBAL.has(p));
        if (unsafe.length > 0) remove.push(`REVOKE ${unsafe.join(', ')} ON *.* FROM ${account}`);
        if (g.grantOption) globalGrantOption = true;
        break;
      }
      case 'database': {
        const matching = tenantDatabases.filter((d) => patternMatches(g.pattern, d)).map(grantPattern);
        if (patternMatches(g.pattern, `${SELF_SERVICE_DB_PREFIX}x`)) matching.unshift(PREFIX_PATTERN);
        grantOn(g.privileges.filter((p) => DATABASE_PRIVILEGES.has(p)), matching);
        if (g.grantOption) remove.push(`REVOKE GRANT OPTION ON ${mysqlIdent(g.pattern)}.* FROM ${account}`);
        remove.push(`REVOKE ALL PRIVILEGES ON ${mysqlIdent(g.pattern)}.* FROM ${account}`);
        break;
      }
      case 'object':
        if (g.grantOption) remove.push(`REVOKE GRANT OPTION ON ${g.target} FROM ${account}`);
        remove.push(`REVOKE ${g.privilegeList} ON ${g.target} FROM ${account}`);
        break;
      case 'unknown':
        // Not readable, so not revocable item by item: everything goes, then
        // the safe grants come back (the old, non-monotone way — rare).
        return [
          `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account}`,
          ...grants.filter((x) => isSafe(x) && x.kind !== 'global').map((x) => x.line),
          ...narrowingStatements(account, grants.filter((x) => x.kind !== 'unknown'), tenantDatabases)
            .filter((st) => st.startsWith('GRANT ')),
        ];
    }
  }
  return [...add, ...remove, ...(globalGrantOption ? [`REVOKE GRANT OPTION ON *.* FROM ${account}`] : [])];
}

interface Account { readonly user: string; readonly host: string | null }

/**
 * Every account the pass looks at. Skipped by exact account, never by name: a
 * `'mysql.sys'@'%'` or a `'dbadmin'@'localhost'` the tenant made is just
 * another account. The server's own live at localhost; `skip` names accounts
 * at '%' (the tenant administrator).
 */
async function listAccounts(x: Exec, skip: ReadonlySet<string>): Promise<Account[]> {
  const isRole = x.ctx.engine === 'mariadb' ? "is_role = 'Y'" : "'N' = 'Y'";
  const out = await sh(x, mysqlRoot(x.ctx, `SELECT ${hx('User')}, ${hx('Host')}, IF(${isRole}, 'R', 'U') FROM mysql.user`));
  const accounts: Account[] = [];
  for (const line of outputLines(out)) {
    const [u, h, kind] = line.split('\t');
    const user = fromHexColumn(u);
    const host = kind === 'R' ? null : fromHexColumn(h);
    if ((MYSQL_SYSTEM_USERS.has(user) && host === 'localhost') || (skip.has(user) && host === '%')) continue;
    accounts.push({ user, host });
  }
  // MariaDB's PUBLIC: what is granted to it, every account holds.
  if (x.ctx.engine === 'mariadb' && (await tryRun(x, mysqlRoot(x.ctx, 'SHOW GRANTS FOR PUBLIC'))).ok) accounts.push({ user: 'PUBLIC', host: null });
  return accounts;
}

async function showGrants(x: Exec, account: Account): Promise<ParsedGrant[]> {
  const target = account.user === 'PUBLIC' && account.host === null ? 'PUBLIC' : accountSql(account.user, account.host);
  const out = await sh(x, mysqlRoot(x.ctx, `SHOW GRANTS FOR ${target}`));
  return outputLines(out).map(unescapeBatch).map(parseGrant);
}

/**
 * One account keeps only its reach into tenant databases — run on the tenant
 * administrator at every full check: nothing must have widened it (a routine
 * left behind running as root could GRANT it anything). Returns what changed.
 */
export async function narrowAccount(x: Exec, user: string, host: string): Promise<string[]> {
  const statements = narrowingStatements(accountSql(user, host), await showGrants(x, { user, host }), await listTenantDatabases(x));
  if (statements.length === 0) return [];
  await sh(x, mysqlRootScript(x.ctx, `${statements.join(';\n')};\n`));
  return [`narrowed ${user}@${host} back to its tenant databases (it had been granted more)`];
}

/**
 * Every account but the server's own and `skip` (the tenant administrator,
 * which narrowAccount keeps in shape) keeps only its reach into tenant
 * databases. Returns what changed.
 */
export async function narrowAccounts(x: Exec, skip: ReadonlySet<string>): Promise<string[]> {
  const changed: string[] = [];
  const dbs = await listTenantDatabases(x);
  for (const account of await listAccounts(x, skip)) {
    if (account.user === '' && account.host !== null) {
      // An anonymous account matches every user name, and a more specific
      // host wins: ''@'127.0.0.1' would stand in for the tenant administrator.
      await sh(x, mysqlRoot(x.ctx, `DROP USER ${accountSql('', account.host)}`));
      changed.push(`dropped the anonymous account @${account.host}`);
      continue;
    }
    const target = account.user === 'PUBLIC' && account.host === null ? 'PUBLIC' : accountSql(account.user, account.host);
    const statements = narrowingStatements(target, await showGrants(x, account), dbs);
    if (statements.length === 0) continue;
    await sh(x, mysqlRootScript(x.ctx, `${statements.join(';\n')};\n`));
    changed.push(`narrowed ${account.host === null ? account.user : `${account.user}@${account.host}`} to its tenant databases (it held global or system-schema privileges)`);
  }
  if (x.ctx.engine === 'mysql') changed.push(...(await clearSystemMandatoryRoles(x)), ...(await clearPersistedVariables(x)));
  return changed;
}

/** MySQL: mandatory_roles naming a server account gives it to everyone. Only those entries go. */
async function clearSystemMandatoryRoles(x: Exec): Promise<string[]> {
  const current = (await sh(x, mysqlRoot(x.ctx, 'SELECT @@GLOBAL.mandatory_roles'))).trim();
  if (!current) return [];
  const entries = current.split(',').map((e) => e.trim()).filter(Boolean);
  const userOf = (e: string): string => e.replace(/^[`']?/, '').split(/[`']?@/)[0].replace(/[`']$/, '');
  const keep = entries.filter((e) => !MYSQL_SYSTEM_USERS.has(userOf(e)));
  if (keep.length === entries.length) return [];
  // Now, for the running server; clearPersistedVariables drops the persisted one.
  await sh(x, mysqlRoot(x.ctx, `SET GLOBAL mandatory_roles = ${mysqlString(keep.join(','))}`));
  return ['removed a server account from mandatory_roles (every account held it)'];
}

/**
 * MySQL: whatever root persisted (SET PERSIST / PERSIST_ONLY) applies again at
 * every start — `mandatory_roles` hands a role to every account, `init_connect`
 * runs SQL in every session. A tenant cannot persist anything without root, so
 * none of it is the tenant's to keep.
 */
async function clearPersistedVariables(x: Exec): Promise<string[]> {
  const out = await sh(x, mysqlRoot(x.ctx, 'SELECT GROUP_CONCAT(VARIABLE_NAME) FROM performance_schema.persisted_variables'));
  const names = out.trim();
  if (!names || names === 'NULL') return [];
  await sh(x, mysqlRoot(x.ctx, 'RESET PERSIST'));
  return [`removed the persisted server settings (${names})`];
}

// ─── "All databases" accounts ───────────────────────────────────────────────

/**
 * Direct grants, not a role: MariaDB and MySQL 8.0 do not apply a definer's
 * default roles inside its routines, triggers, events and views, so a view
 * the tenant administrator created would fail for want of privileges it
 * holds only through a role.
 */
export function allDatabasesGrants(account: string, tenantDatabases: readonly string[]): string[] {
  return [PREFIX_PATTERN, ...tenantDatabases.filter(notUnderPrefix).map(grantPattern)]
    .map((p) => `GRANT ALL PRIVILEGES ON ${mysqlIdent(p)}.* TO ${account}`);
}

/** A database the prefix grant does not already cover (grant patterns match case-sensitively). */
function notUnderPrefix(db: string): boolean {
  return !db.startsWith(SELF_SERVICE_DB_PREFIX);
}

/** Every "all databases" account (holding the prefix grant) also reaches every tenant database. Returns what changed. */
export async function ensureAllDatabasesAccounts(x: Exec): Promise<string[]> {
  const rows = outputLines(await sh(x, mysqlRoot(x.ctx, `SELECT ${hx('User')}, ${hx('Host')}, ${hx('Db')} FROM mysql.db`)))
    .map((l) => l.split('\t').map(fromHexColumn));
  const members = rows.filter(([, , db]) => db === PREFIX_PATTERN).map(([user, host]) => ({ user, host }));
  if (members.length === 0) return [];
  const held = new Set(rows.map(([user, host, db]) => `${user}\u0000${host}\u0000${db}`));
  const dbs = (await listTenantDatabases(x)).filter(notUnderPrefix);
  const missing: string[] = [];
  for (const m of members) {
    for (const d of dbs) {
      if (!held.has(`${m.user}\u0000${m.host}\u0000${grantPattern(d)}`)) {
        missing.push(`GRANT ALL PRIVILEGES ON ${mysqlIdent(grantPattern(d))}.* TO ${accountSql(m.user, m.host === '' ? null : m.host)}`);
      }
    }
  }
  if (missing.length === 0) return [];
  await sh(x, mysqlRootScript(x.ctx, `${missing.join(';\n')};\n`));
  return [`granted ${missing.length} database(s) to the "all databases" accounts`];
}

// ─── Objects that run as root ───────────────────────────────────────────────

type ObjectKind = 'PROCEDURE' | 'FUNCTION' | 'TRIGGER' | 'VIEW' | 'EVENT' | 'PACKAGE' | 'PACKAGE BODY';

interface DefinedObject {
  readonly kind: ObjectKind;
  readonly schema: string;
  readonly name: string;
  /** EVENT: its comment, re-stated (an ALTER EVENT needs a clause besides DEFINER). */
  readonly comment?: string;
}

const PRIVILEGED_DEFINER = `SUBSTRING_INDEX(DEFINER, '@', 1) IN (${[...MYSQL_SYSTEM_USERS].map(mysqlString).join(', ')})`; // allow-array-binding: literals joined into SQL text for the mysql client, not a drizzle bind
const NOT_SYSTEM = (col: string): string => `${col} NOT IN (${[...MYSQL_SYSTEM_SCHEMAS].map(mysqlString).join(', ')})`; // allow-array-binding: literals joined into SQL text for the mysql client, not a drizzle bind

async function rootDefinedObjects(x: Exec): Promise<DefinedObject[]> {
  const sql = [
    `SELECT ROUTINE_TYPE, ${hx('ROUTINE_SCHEMA')}, ${hx('ROUTINE_NAME')}, 'x' FROM information_schema.ROUTINES WHERE ${PRIVILEGED_DEFINER} AND ${NOT_SYSTEM('ROUTINE_SCHEMA')} AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')`,
    `SELECT 'VIEW', ${hx('TABLE_SCHEMA')}, ${hx('TABLE_NAME')}, 'x' FROM information_schema.VIEWS WHERE ${PRIVILEGED_DEFINER} AND ${NOT_SYSTEM('TABLE_SCHEMA')}`,
    `SELECT 'EVENT', ${hx('EVENT_SCHEMA')}, ${hx('EVENT_NAME')}, ${hx("COALESCE(EVENT_COMMENT, '')")} FROM information_schema.EVENTS WHERE ${PRIVILEGED_DEFINER} AND ${NOT_SYSTEM('EVENT_SCHEMA')}`,
  ].join(' UNION ALL ');
  return outputLines(await sh(x, mysqlRoot(x.ctx, sql))).map((l) => {
    const [kind, s, n, c] = l.split('\t');
    return { kind: kind as ObjectKind, schema: fromHexColumn(s), name: fromHexColumn(n), comment: fromHexColumn(c) };
  });
}

/**
 * Root-defined triggers, with every trigger after them on the same table,
 * timing and event: re-creating one moves it to the end of its group, so the
 * rest of the group is re-created after it, in order, keeping their definers.
 */
async function triggersToRecreate(x: Exec): Promise<DefinedObject[]> {
  const out = await sh(x, mysqlRoot(x.ctx,
    `SELECT ${hx('TRIGGER_SCHEMA')}, ${hx('TRIGGER_NAME')}, ${hx('EVENT_OBJECT_TABLE')}, ACTION_TIMING, EVENT_MANIPULATION, ${PRIVILEGED_DEFINER} `
    + `FROM information_schema.TRIGGERS WHERE ${NOT_SYSTEM('TRIGGER_SCHEMA')} ORDER BY TRIGGER_SCHEMA, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER`));
  const groups = new Map<string, Array<{ schema: string; name: string; root: boolean }>>();
  for (const l of outputLines(out)) {
    const [s, n, t, timing, ev, root] = l.split('\t');
    const key = `${s}.${t}.${timing}.${ev}`;
    const group = groups.get(key) ?? [];
    group.push({ schema: fromHexColumn(s), name: fromHexColumn(n), root: root === '1' });
    groups.set(key, group);
  }
  const out2: DefinedObject[] = [];
  for (const group of groups.values()) {
    const first = group.findIndex((g) => g.root);
    if (first >= 0) out2.push(...group.slice(first).map((g) => ({ kind: 'TRIGGER' as const, schema: g.schema, name: g.name })));
  }
  return out2;
}

/** The CREATE statement of one object with its DEFINER clause replaced; null if it has no DEFINER clause to replace. Pure. */
export function withDefiner(create: string, definer: string | null, orReplace: boolean): string | null {
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?((?:ALGORITHM\s*=\s*\w+\s+)?)DEFINER\s*=\s*((?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|[^\s@]+)(?:\s*@\s*(?:`(?:[^`]|``)*`|'(?:[^'\\]|\\.)*'|\S+))?)\s+/i.exec(create);
  if (!m) return null;
  return `CREATE ${orReplace ? 'OR REPLACE ' : ''}${m[1]}DEFINER=${definer ?? m[2]} ${create.slice(m[0].length)}`;
}

interface ShowCreate { readonly create: string; readonly sqlMode: string | null; readonly collation: string }

async function showCreate(x: Exec, o: DefinedObject): Promise<ShowCreate> {
  const out = await sh(x, mysqlRoot(x.ctx, `SHOW CREATE ${o.kind} ${mysqlIdent(o.schema)}.${mysqlIdent(o.name)}`));
  const cols = out.replace(/\n$/, '').split('\t').map(unescapeBatch);
  // VIEW: name, create, charset, collation. Routines and triggers: name, sql_mode, create, charset, collation, …
  if (o.kind === 'VIEW') return { create: cols[1], sqlMode: null, collation: cols[3] };
  return { create: cols[2], sqlMode: cols[1], collation: cols[4] };
}

/** EXECUTE / ALTER ROUTINE grants on a routine, to put back once it is re-created (MySQL drops them with it). */
async function routineGrants(x: Exec, o: DefinedObject): Promise<string[]> {
  const out = await sh(x, mysqlRoot(x.ctx,
    `SELECT ${hx('User')}, ${hx('Host')}, Proc_priv FROM mysql.procs_priv WHERE Db = ${mysqlString(o.schema)} AND Routine_name = ${mysqlString(o.name)} AND Routine_type = ${mysqlString(o.kind)}`));
  return outputLines(out).flatMap((l) => {
    const [u, h, privs] = l.split('\t');
    const list = (privs ?? '').split(',').map((p) => p.trim().toUpperCase()).filter((p) => p === 'EXECUTE' || p === 'ALTER ROUTINE');
    if (list.length === 0) return [];
    const grantOption = /\bGrant\b/i.test(privs ?? '') ? ' WITH GRANT OPTION' : '';
    return [`GRANT ${list.join(', ')} ON ${o.kind} ${mysqlIdent(o.schema)}.${mysqlIdent(o.name)} TO ${accountSql(fromHexColumn(u), fromHexColumn(h))}${grantOption}`];
  });
}

function recreateScript(x: Exec, o: DefinedObject, sc: ShowCreate, create: string, grants: readonly string[]): string {
  // The client keeps at most 15 characters of a delimiter.
  let tok = '';
  do tok = `$$${randomBytes(5).toString('hex')}`; while (create.includes(tok));
  const dropFirst = x.ctx.engine === 'mysql' && o.kind !== 'VIEW';
  return [
    'SET NAMES utf8mb4;',
    `SET collation_connection = ${mysqlString(sc.collation)};`,
    ...(sc.sqlMode !== null ? [`SET SESSION sql_mode = ${mysqlString(sc.sqlMode)};`] : []),
    `USE ${mysqlIdent(o.schema)};`,
    `DELIMITER ${tok}`,
    ...(dropFirst ? [`DROP ${o.kind} IF EXISTS ${mysqlIdent(o.schema)}.${mysqlIdent(o.name)}${tok}`] : []),
    `${create}${tok}`,
    'DELIMITER ;',
    // The object's sql_mode may hold NO_BACKSLASH_ESCAPES; the grants are quoted for the default.
    "SET SESSION sql_mode = '';",
    ...grants.map((g) => `${g};`),
    '',
  ].join('\n');
}

/**
 * Drop an object that ran as root and could not be moved off it. Fail-closed:
 * an object that keeps running as root is a way back to root, which matters
 * more than the object. Its definition goes to the platform log, so an
 * operator can hand it back. Throws when even the DROP fails — the pass then
 * counts as not done and runs again.
 */
async function dropObject(x: Exec, o: DefinedObject, why: string, definition?: string): Promise<string> {
  const label = `${o.kind.toLowerCase()} ${o.schema}.${o.name}`;
  await sh(x, mysqlRoot(x.ctx, `DROP ${o.kind} IF EXISTS ${mysqlIdent(o.schema)}.${mysqlIdent(o.name)}`));
  console.warn(`[database-admin] dropped the ${label} (${why})${definition ? `; it was: ${definition}` : ''}`);
  return `removed the ${label}: it ran as root and ${why} (its definition is in the platform log)`;
}

async function recreate(x: Exec, o: DefinedObject, definer: string | null): Promise<string> {
  const sc = await showCreate(x, o);
  // MariaDB replaces in place; MySQL has OR REPLACE only for views.
  const orReplace = x.ctx.engine === 'mariadb' || o.kind === 'VIEW';
  const create = withDefiner(sc.create, definer, orReplace);
  const label = `${o.kind.toLowerCase()} ${o.schema}.${o.name}`;
  if (!create) return dropObject(x, o, 'its definition has no DEFINER clause to change', sc.create);
  const grants = o.kind === 'PROCEDURE' || o.kind === 'FUNCTION' ? await routineGrants(x, o) : [];
  const r = await tryRun(x, mysqlRootScript(x.ctx, recreateScript(x, o, sc, create, grants)));
  if (r.ok) return definer === null ? `re-created the ${label} to keep its trigger order` : `the ${label} now runs as the tenant administrator (it ran as root)`;
  if (definer === null) {
    // A trigger re-created only to keep the order, with its own definer: put it back.
    const back = await tryRun(x, mysqlRootScript(x.ctx, recreateScript(x, o, sc, withDefiner(sc.create, null, orReplace) ?? sc.create, grants)));
    if (back.ok) return `could not re-create the ${label} to keep its trigger order; left in place: ${r.error}`;
    throw new DbExecError(`the ${label} could not be re-created and is gone (its definition is in the platform log): ${back.error}`);
  }
  return dropObject(x, o, `could not be re-created as the tenant administrator (${r.error})`, sc.create);
}

/** Objects in the server's own schemas defined by root: none is the server's (its own use mariadb.sys / mysql.sys). */
async function rootObjectsInSystemSchemas(x: Exec): Promise<DefinedObject[]> {
  const inSystem = (col: string): string => `${col} IN (${[...MYSQL_SYSTEM_SCHEMAS].map(mysqlString).join(', ')})`; // allow-array-binding: literals joined into SQL text for the mysql client, not a drizzle bind
  const byRoot = "SUBSTRING_INDEX(DEFINER, '@', 1) = 'root'";
  const sql = [
    `SELECT ROUTINE_TYPE, ${hx('ROUTINE_SCHEMA')}, ${hx('ROUTINE_NAME')} FROM information_schema.ROUTINES WHERE ${byRoot} AND ${inSystem('ROUTINE_SCHEMA')} AND ROUTINE_TYPE IN ('PROCEDURE', 'FUNCTION')`,
    `SELECT 'VIEW', ${hx('TABLE_SCHEMA')}, ${hx('TABLE_NAME')} FROM information_schema.VIEWS WHERE ${byRoot} AND ${inSystem('TABLE_SCHEMA')}`,
    `SELECT 'EVENT', ${hx('EVENT_SCHEMA')}, ${hx('EVENT_NAME')} FROM information_schema.EVENTS WHERE ${byRoot} AND ${inSystem('EVENT_SCHEMA')}`,
    `SELECT 'TRIGGER', ${hx('TRIGGER_SCHEMA')}, ${hx('TRIGGER_NAME')} FROM information_schema.TRIGGERS WHERE ${byRoot} AND ${inSystem('TRIGGER_SCHEMA')}`,
  ].join(' UNION ALL ');
  return outputLines(await sh(x, mysqlRoot(x.ctx, sql))).map((l) => {
    const [kind, sc, n] = l.split('\t');
    return { kind: kind as ObjectKind, schema: fromHexColumn(sc), name: fromHexColumn(n) };
  });
}

/** MariaDB (Oracle mode) packages defined by a server account: not re-created, dropped — bodies first. */
async function rootDefinedPackages(x: Exec): Promise<DefinedObject[]> {
  if (x.ctx.engine !== 'mariadb') return [];
  const out = await sh(x, mysqlRoot(x.ctx,
    `SELECT ROUTINE_TYPE, ${hx('ROUTINE_SCHEMA')}, ${hx('ROUTINE_NAME')} FROM information_schema.ROUTINES`
    + ` WHERE ${PRIVILEGED_DEFINER} AND ROUTINE_TYPE IN ('PACKAGE', 'PACKAGE BODY') ORDER BY ROUTINE_TYPE = 'PACKAGE'`));
  return outputLines(out).map((l) => {
    const [kind, sc, n] = l.split('\t');
    return { kind: kind as ObjectKind, schema: fromHexColumn(sc), name: fromHexColumn(n) };
  });
}

/** Every object running as root (or a server account) runs as `admin` instead. Returns what changed. */
export async function adoptRootDefinedObjects(x: Exec, admin: string): Promise<string[]> {
  const changed: string[] = [];
  for (const o of await rootObjectsInSystemSchemas(x)) {
    changed.push(await dropObject(x, o, 'sat in the server\'s own schema'));
  }
  for (const o of await rootDefinedPackages(x)) {
    changed.push(await dropObject(x, o, 'is a package, which the platform does not re-create'));
  }
  for (const o of await rootDefinedObjects(x)) {
    if (o.kind === 'EVENT') {
      await sh(x, mysqlRoot(x.ctx, `ALTER DEFINER = ${admin} EVENT ${mysqlIdent(o.schema)}.${mysqlIdent(o.name)} COMMENT ${mysqlString(o.comment ?? '')}`));
      changed.push(`the event ${o.schema}.${o.name} now runs as the tenant administrator (it ran as root)`);
    } else {
      changed.push(await recreate(x, o, admin));
    }
  }
  const triggers = await triggersToRecreate(x);
  const rootOnes = new Set<string>();
  if (triggers.length > 0) {
    const out = await sh(x, mysqlRoot(x.ctx, `SELECT ${hx('TRIGGER_SCHEMA')}, ${hx('TRIGGER_NAME')} FROM information_schema.TRIGGERS WHERE ${PRIVILEGED_DEFINER}`));
    for (const l of outputLines(out)) {
      const [sc, n] = l.split('\t');
      rootOnes.add(`${fromHexColumn(sc)}\u0000${fromHexColumn(n)}`);
    }
  }
  for (const t of triggers) {
    const root = rootOnes.has(`${t.schema}\u0000${t.name}`);
    const result = await recreate(x, t, root ? admin : null);
    if (root || !result.startsWith('re-created')) changed.push(result);
  }
  return changed;
}
