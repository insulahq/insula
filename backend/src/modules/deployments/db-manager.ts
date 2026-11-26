/**
 * Database management via K8s pod exec.
 *
 * Executes SQL commands inside running database pods (MariaDB, MySQL, PostgreSQL)
 * to manage databases and users on deployed instances.
 *
 * Also provides generic query execution, table browsing, structure inspection,
 * and import/export for database manager UI.
 */

import { randomBytes } from 'node:crypto';
import { Exec, KubeConfig } from '@kubernetes/client-node';
import { Readable, Writable } from 'node:stream';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isOomTermination, isReplacedPodRecord, messageIndicatesOom } from '../../lib/container-termination.js';
import {
  findSystemStatement, GREP_FAILED, grepScanCommand, parseGrepHit, systemImportPattern, systemImportRefusal,
} from './import-system-guard.js';
import {
  pgConnInfoDbName, quoteAnsiIdentifier, quoteMysqlIdentifier, quotePgStringLiteral, unescapeMysqlBatchField,
  validateExistingName,
} from '../../shared/sql-identifiers.js';
import { dbEngineApiError } from './db-errors.js';
import { RESERVED_ACCOUNT_NAMES, SELF_SERVICE_DB_PREFIX } from './db-account-names.js';
import { PG_SAFE_ENV_SH, PG_SAFE_SESSION_SH } from './pg-session.js';
import { MYSQL_TENANT_IMPORT_SED, rewriteMysqlDumpForTenant } from './import-rewrite.js';
import {
  affectedRowsField,
  affectedRowsMarker,
  psqlRowCountCommand,
  splitRowCount,
  withMysqlRowCount,
} from './affected-rows.js';

// ─── Binary Not Found Detection ────────────────────────────────────────────

/**
 * Check whether an exec error indicates that the binary was not found in the
 * container.  K8s exec returns various messages depending on the runtime
 * (containerd, CRI-O, Docker) so we match broadly.
 */
function isBinaryNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('executable not found') ||
    lower.includes('not found') ||
    lower.includes('no such file') ||
    lower.includes('command not found') ||
    lower.includes('oci runtime exec failed')
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

const NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function validateIdentifier(value: string, label: string): void {
  if (!NAME_REGEX.test(value)) {
    throw new ApiError(
      'INVALID_IDENTIFIER',
      `Invalid ${label}: must start with a letter or underscore, contain only alphanumerics/underscores, and be 1-64 characters`,
      400,
      { field: label, value },
    );
  }
}

/**
 * The engines' own databases. Creating one in the panel is either a no-op or
 * worse: the new database is granted to the "all databases" role, and ALL on
 * `mysql` is root (rewrite mysql.proc or mysql.global_priv, and the next flush
 * or call runs as anyone).
 */
const RESERVED_DATABASES: Readonly<Record<string, readonly string[]>> = {
  mariadb: ['mysql', 'sys', 'performance_schema', 'information_schema'],
  mysql: ['mysql', 'sys', 'performance_schema', 'information_schema'],
  postgresql: ['postgres', 'template0', 'template1'],
  mongodb: ['admin', 'local', 'config'],
};

/**
 * Accounts Database Users never creates, re-passwords or drops: root (by any
 * other name: the PostgreSQL superuser, MongoDB's root user), the server's
 * own, and the tenant administrator — whose password the platform keeps.
 * Setting root's password from the panel would hand root back to the tenant;
 * dropping it, lock the platform out.
 */
export function refuseReservedAccount(ctx: Pick<DbManagerContext, 'rootUsername'>, username: string): void {
  const n = username.toLowerCase();
  const reserved = ['root', 'postgres', 'healthcheck', ctx.rootUsername.toLowerCase(), ...RESERVED_ACCOUNT_NAMES.map((r) => r.toLowerCase())];
  if (reserved.includes(n) || /^dbadmin(_|$)/.test(n)) {
    throw new ApiError('RESERVED_ACCOUNT_NAME', `"${username}" is an account the platform manages and cannot be changed here`, 409, { username });
  }
}

/**
 * The engines' own databases a tenant may not export either (they hold the
 * server's accounts). PostgreSQL's `postgres` is a plain database and may
 * hold tenant data, so it exports.
 */
export function refuseSystemDatabaseExport(engine: string, name: string): void {
  if (engine === 'postgresql' && name.toLowerCase() === 'postgres') return;
  refuseReservedDatabaseName(engine, name);
}

export function refuseReservedDatabaseName(engine: string, name: string): void {
  if ((RESERVED_DATABASES[engine] ?? []).includes(name.toLowerCase())) {
    throw new ApiError('RESERVED_DATABASE_NAME', `"${name}" is the database server's own database and cannot be created or granted`, 400, { name });
  }
}

// ─── Shell / Mongo Escaping ──────────────────────────────────────────────────

/** Escape a string for safe interpolation inside single-quoted shell arguments. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** The PostgreSQL superuser, as the shell inside the database container names it. */
const PG_SUPERUSER_SH = '"${POSTGRES_USER:-postgres}"';

/**
 * psql / pg_dump / pg_restore as the instance's superuser over the local
 * socket (the image's trust). The superuser is whatever the image was
 * initialised with — POSTGRES_USER, which an app stack sets to its own user
 * and a tenant may have chosen — read from the container's own environment,
 * so it cannot disagree with the instance. `-U postgres` failed on both.
 */
function pgSuperuserCommand(bin: 'psql' | 'pg_dump' | 'pg_restore', args: readonly string[]): string[] {
  // The pinned session (pg-session.ts) wraps the same exec.
  return ['sh', '-c', PG_SAFE_SESSION_SH, 'sh', 'sh', '-c', `exec ${bin} -U ${PG_SUPERUSER_SH} "$@"`, bin, ...args];
}

/**
 * Escape a string for safe interpolation inside double-quoted JavaScript/mongosh
 * strings. JSON's escaping is a valid JS string body for every character —
 * quotes, backslashes AND control characters (a newline in a name or password
 * used to end the string literal).
 */
function mongoEscapeString(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

// ─── K8s Pod Exec ─────────────────────────────────────────────────────────────

function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return kc;
}

/**
 * One shell word, the way `sh -c` reads it: single-quoted runs (which can hold
 * spaces), double-quoted runs, backslash escapes and plain characters, back to
 * back. Matching only `\S+` left the tail of a quoted password that holds a
 * space or an escaped quote (`-p'a b'`, `-p'a'\''b'`) in the text.
 */
const SHELL_WORD = String.raw`(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+`;

/**
 * Strip credentials from text that came from (or echoes) an exec command line.
 * The k8s exec status message embeds the full argv — `-p<root password>` and,
 * for ALTER USER / CREATE USER, the new password — so it must never reach an
 * error response or a log unredacted.
 */
export function redactDbSecrets(text: string): string {
  return text
    .replace(new RegExp(`(^|\\s)-p(?=\\S)${SHELL_WORD}`, 'g'), '$1-p***')
    // mongosh / mongodump / mongorestore take the password as its own word
    // (`-p '<pw>'`); the exec status echoes it like any other argument. Only
    // after a Mongo tool's name, so `mkdir -p /data` keeps its path.
    .replace(new RegExp(`(\\bmongo(?:sh|dump|restore)?\\b[^\\n]*?\\s)-p\\s+${SHELL_WORD}`, 'g'), '$1-p ***')
    .replace(new RegExp(`--password(=|\\s+)${SHELL_WORD}`, 'gi'), '--password$1***')
    .replace(new RegExp(`\\b(PGPASSWORD|MYSQL_PWD)=${SHELL_WORD}`, 'g'), '$1=***')
    .replace(/(IDENTIFIED\s+(?:VIA\s+\S+\s+USING|BY)\s+(?:PASSWORD\s*)?\(?\s*)'(?:[^'\\]|\\.)*'/gi, "$1'***'")
    .replace(/(PASSWORD\s*\(?\s*)'(?:[^'\\]|\\.)*'/gi, "$1'***'");
}

/**
 * A command that failed inside the database pod. Deliberately NOT an ApiError:
 * the query/import paths rethrow ApiErrors (validation) but report exec
 * failures inline as a query result. User management converts it with
 * `asDbApiError` so the panel gets the database's message instead of a 500.
 */
export class DbExecError extends Error {}

/** The error a failed exec rejects with: the database's own message, redacted. */
function execFailure(status: Record<string, unknown>, stderr: string): DbExecError {
  const statusMessage = typeof status.message === 'string' ? status.message : '';
  const message = redactDbSecrets(stderr.trim() || statusMessage || 'Command execution failed in the database pod');
  console.error(`[db-manager] Exec failed: ${message}`);
  return new DbExecError(message);
}

function asDbApiError(err: unknown): unknown {
  return err instanceof DbExecError ? dbEngineApiError(err.message) : err;
}

async function execInPod(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const kc = loadKubeConfig(kubeconfigPath);
  const exec = new Exec(kc);

  let stdout = '';
  let stderr = '';

  const stdoutStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdout += chunk.toString();
      cb();
    },
  });
  const stderrStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stderr += chunk.toString();
      cb();
    },
  });

  // Wait for both the exec status callback AND the streams to finish.
  // The status callback can fire before all data is flushed to stdout/stderr,
  // causing empty results for large outputs (e.g., database exports).
  // A failed status is turned into an error only once stderr has flushed, so
  // the database's own message (not the exec status) is what the operator sees.
  let failedStatus: Record<string, unknown> | null = null;

  await new Promise<void>((resolve, reject) => {
    let statusDone = false;
    let stdoutDone = false;
    let stderrDone = false;

    const tryResolve = () => {
      if (statusDone && stdoutDone && stderrDone) {
        if (failedStatus) reject(execFailure(failedStatus, stderr));
        else resolve();
      }
    };

    stdoutStream.on('finish', () => { stdoutDone = true; tryResolve(); });
    stderrStream.on('finish', () => { stderrDone = true; tryResolve(); });

    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          const s = status as Record<string, unknown>;
          if (!s || s.status === 'Success' || s.status === undefined) {
            // Success — end the writable streams so 'finish' fires
            stdoutStream.end();
            stderrStream.end();
          } else {
            failedStatus = s;
            stdoutStream.end();
            stderrStream.end();
          }
          statusDone = true;
          tryResolve();
        },
      )
      .catch((err) => {
        // ErrorEvent (from @kubernetes/client-node's WebSocket implementation)
        // serializes to `{}` — .message still carries the real text. Unwrap it
        // so the route handler + query-result surfaces a useful error.
        const msg = err?.message ?? (typeof err === 'string' ? err : 'exec.exec() failed');
        reject(err instanceof Error ? err : new Error(msg));
      });
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function execInPodWithStdin(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdinData: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const kc = loadKubeConfig(kubeconfigPath);
  const exec = new Exec(kc);

  let stdout = '';
  let stderr = '';

  const stdoutStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdout += chunk.toString();
      cb();
    },
  });
  const stderrStream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stderr += chunk.toString();
      cb();
    },
  });

  const stdinStream = new Readable({
    read() {
      this.push(Buffer.from(stdinData));
      this.push(null);
    },
  });

  await new Promise<void>((resolve, reject) => {
    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        stdinStream,
        false,
        (status) => {
          const s = status as Record<string, unknown>;
          if (!s || s.status === 'Success' || s.status === undefined) {
            resolve();
          } else {
            // Same rule as execInPod: the status embeds the argv (-p<root password>).
            reject(execFailure(s, stderr));
          }
        },
      )
      .catch((err: unknown) => reject(new DbExecError(redactDbSecrets(err instanceof Error ? err.message : String(err)))));
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Find Pod ─────────────────────────────────────────────────────────────────

/**
 * Run one command in a database pod and return its output, for modules that
 * manage the database's own accounts (db-admin-access.ts, tenant-admin.ts).
 * A failed command rejects with a DbExecError carrying the redacted message.
 */
export async function execInDbPod(
  ctx: Pick<DbManagerContext, 'kubeconfigPath' | 'namespace' | 'podName' | 'containerName'>,
  command: string[],
  /** Written to the command's stdin, then closed — where a password goes instead of argv. */
  stdin?: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return stdin === undefined
    ? execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, command)
    : execInPodWithStdin(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, command, stdin);
}

async function findPodName(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  componentName?: string,
): Promise<string> {
  // The deployer labels pods with `app=<deploymentName>` and, for
  // multi-component apps, also `component=<componentName>`. Single-component
  // apps have the component label equal to the entry code — but for selection
  // purposes the app label alone is enough; for multi-component we must pin
  // to the DB component or we'll match the wordpress pod instead.
  const selector = componentName
    ? `app=${deploymentName},component=${componentName}`
    : `app=${deploymentName}`;
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: selector });
  const podList =
    (pods as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> })
      .items ?? [];
  const running = podList.find((p) => p.status?.phase === 'Running');
  if (!running?.metadata?.name) {
    throw new ApiError(
      'POD_NOT_FOUND',
      'No running pod found for this deployment',
      503,
      { deployment: deploymentName, namespace, component: componentName },
      'Ensure the database deployment is running before managing databases',
    );
  }
  return running.metadata.name;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbDatabase {
  readonly name: string;
}

export interface DbUser {
  readonly username: string;
  readonly host: string;
  readonly databases: readonly string[];
}

export type Engine = 'mariadb' | 'mysql' | 'postgresql' | 'mongodb';

/** Central engine configuration — derived from the catalog "database" field */
export const ENGINE_CONFIG: Record<Engine, {
  readonly rootPasswordEnv: string;
  readonly rootUsernameEnv?: string;
  readonly dataRoot: string;
  readonly port: number;
}> = {
  mariadb: { rootPasswordEnv: 'MARIADB_ROOT_PASSWORD', dataRoot: '/var/lib/mysql', port: 3306 },
  mysql: { rootPasswordEnv: 'MYSQL_ROOT_PASSWORD', dataRoot: '/var/lib/mysql', port: 3306 },
  postgresql: { rootPasswordEnv: 'POSTGRES_PASSWORD', dataRoot: '/var/lib/postgresql', port: 5432 },
  mongodb: { rootPasswordEnv: 'MONGO_INITDB_ROOT_PASSWORD', rootUsernameEnv: 'MONGO_INITDB_ROOT_USERNAME', dataRoot: '/data/db', port: 27017 },
};

/** An account other than root to run a command as: the tenant's administrator (tenant-admin.ts). */
export interface DbLogin {
  readonly username: string;
  readonly password: string;
}

/**
 * A tenant's SQL runs in a client inside the database pod, and the clients
 * have commands of their own: `system`/`\\!` (MariaDB/MySQL), `\\!` and
 * `\\copy … program` (psql), `require('child_process')` (mongosh). A shell
 * there is the container's OS root — the platform's administrator login
 * (db-admin-access.ts). So a tenant-run client starts as `nobody` with an
 * empty environment (no root password in env, /proc/1/environ unreadable),
 * and each engine's client commands are switched off besides.
 */
const UNPRIVILEGED = ['env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/tmp', 'gosu', 'nobody'];

/** The prefix for a client run on a tenant's behalf (`login` set), none for the platform's own. */
function asTenant(login?: DbLogin): string[] {
  return login ? UNPRIVILEGED : [];
}

/**
 * A tenant's plain-SQL file for psql. psql runs every backslash line it reads
 * (`\\! sh`, `\\copy … program`, `\\o |cmd`), and the pod's shell — even as
 * `nobody` — reaches the superuser by the image's local trust. psql's
 * restricted mode refuses all of them until `\\unrestrict <key>`, and the
 * key is fresh for each import, so a file cannot carry it. COPY data is not
 * read as commands either way. A dump's own `\\restrict` pair (pg_dump ≥
 * 17.6/16.10) is dropped: it would only be refused inside ours.
 */
export const PSQL_RESTRICT_LINE_SED = '/^\\\\(un)?restrict[[:space:]]+[[:alnum:]]+[[:space:]]*$/d';
const PSQL_RESTRICT_LINE = /^\\(?:un)?restrict[ \t]+[A-Za-z0-9]+[ \t\r]*$/gm;
/** stderr marker: this pod's psql predates restricted mode (before 18.0, 17.6, 16.10, 15.14, 14.19, 13.22). */
export const PSQL_TOO_OLD = 'INSULA_PSQL_WITHOUT_RESTRICT';
export const PSQL_TOO_OLD_MESSAGE =
  'This PostgreSQL server\'s psql is too old to import a plain SQL file safely (it cannot refuse the file\'s backslash commands). Update the instance to the latest minor release, or import a custom-format dump (pg_dump -Fc).';

export function newPsqlRestrictKey(): string {
  return randomBytes(16).toString('hex');
}

export function restrictedPsqlInput(sql: string, key: string): string {
  return `\\restrict ${key}\n${sql.replace(PSQL_RESTRICT_LINE, '')}`;
}

/** `sh -c` lines: refuse (exit 3, stderr PSQL_TOO_OLD) unless psql knows `\\restrict`. `$1` user, `$2` database. */
const PSQL_RESTRICT_PROBE =
  `psql -X -U "$1" -d "$2" -c '\\restrict probe' </dev/null >/dev/null 2>&1 || { echo '${PSQL_TOO_OLD}' >&2; exit 3; }`;
const UNPRIVILEGED_SH = UNPRIVILEGED.map(shellEscape).join(' ');

/** MariaDB/MySQL client login: `login` over TCP inside the pod, or root over the socket. */
function mysqlAuthArgs(bin: string, rootPassword: string, login?: DbLogin): string[] {
  return login
    // --binary-mode: no client commands (system, \\!, source, pager, tee) —
    // only SQL, DELIMITER and charset reach the server.
    ? [`-u${login.username}`, `-p${login.password}`, '-h127.0.0.1', '--protocol=TCP', '--binary-mode', '--local-infile=0', ...(bin === 'mysql' ? ['--get-server-public-key'] : [])]
    : ['-u', 'root', `-p${rootPassword}`];
}

export interface DbManagerContext {
  readonly kubeconfigPath: string | undefined;
  readonly namespace: string;
  readonly podName: string;
  readonly containerName: string;
  readonly engine: Engine;
  readonly rootPassword: string;
  readonly rootUsername: string;
  readonly k8s?: K8sClients;
}

// ─── Query Execution Types ──────────────────────────────────────────────────

export interface QueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  /**
   * Rows the statement wrote, when it returned no result set (affected-rows.ts).
   * MariaDB/MySQL count only rows whose value changed; PostgreSQL and SQLite
   * count every row the statement matched. Absent when the engine reported none.
   */
  readonly affectedRows?: number;
  readonly executionTimeMs: number;
  readonly error?: string;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly key: string; // PRI, UNI, MUL, or empty
}

export interface ImportResult {
  readonly success: boolean;
  readonly error?: string;
}

/** Max query length in bytes (1 MB). */
const MAX_QUERY_LENGTH = 1_048_576;

/** Max SQL import payload in bytes (50 MB — matches Fastify body limit). */
const MAX_IMPORT_LENGTH = 52_428_800;

/** Query execution timeout in seconds. */
const QUERY_TIMEOUT_SECONDS = 30;

// ─── Engine Detection ─────────────────────────────────────────────────────────

function detectEngine(catalogEntry: { runtime?: string | null }): Engine {
  const runtime = catalogEntry.runtime?.toLowerCase();
  if (runtime === 'mariadb') return 'mariadb';
  if (runtime === 'mysql') return 'mysql';
  if (runtime === 'postgresql' || runtime === 'postgres') return 'postgresql';
  if (runtime === 'mongodb') return 'mongodb';
  throw new ApiError(
    'UNSUPPORTED_ENGINE',
    `Database engine '${catalogEntry.runtime ?? 'unknown'}' is not supported for management`,
    400,
    { runtime: catalogEntry.runtime },
  );
}

// ─── MariaDB / MySQL ──────────────────────────────────────────────────────────

async function mysqlExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  sql: string,
): Promise<string> {
  // MariaDB 11+ uses 'mariadb' binary; older MariaDB and MySQL use 'mysql'
  // Try 'mariadb' first, fall back to 'mysql' only when the binary is missing.
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mariadb', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch', '--skip-column-names'],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      ['mysql', '-u', 'root', `-p${rootPassword}`, '-e', sql, '--batch', '--skip-column-names'],
    );
  }
  const { stdout, stderr } = result;
  if (stderr && stderr.includes('ERROR')) {
    throw dbEngineApiError(redactDbSecrets(stderr));
  }
  return stdout;
}

async function mysqlListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
): Promise<readonly DbDatabase[]> {
  const systemDbs = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', '']);
  const out = await mysqlExec(kp, ns, pod, cn, pw, 'SHOW DATABASES');
  // Names are --batch data cells: unescape so `a\b` is not listed as `a\\b`.
  return out
    .split('\n')
    .map(unescapeMysqlBatchField)
    .filter((name) => !systemDbs.has(name))
    .map((name) => ({ name }));
}

/**
 * The collation new MySQL/MariaDB databases are created with.
 *
 * A bare `CREATE DATABASE` inherits the server default, and on MariaDB 11.4+
 * that is `utf8mb4_uca1400_ai_ci` — a UCA-1400 collation that
 * `SHOW COLLATION WHERE Collation='utf8mb4_uca1400_ai_ci' AND Charset='utf8mb4'`
 * does NOT return. Applications that verify their database is Unicode by
 * running exactly that query therefore conclude it is not: Moodle's installer
 * aborts with "unicode must be installed and enabled" on a database the
 * platform just created for it. Reproduced on DEV against mariadb:12.3 while
 * installing Moodle 5.0.10.
 *
 * `utf8mb4_unicode_ci` is the collation those applications are written against,
 * is present in every MySQL and MariaDB version the catalog offers, and is what
 * a tenant importing a dump from cPanel/Plesk will be carrying anyway.
 */
export const APP_COMPATIBLE_MYSQL_COLLATION = 'utf8mb4_unicode_ci';

export function mysqlCreateDatabaseSql(dbName: string): string {
  return `CREATE DATABASE IF NOT EXISTS \`${dbName}\` `
    + `CHARACTER SET utf8mb4 COLLATE ${APP_COMPATIBLE_MYSQL_COLLATION}`;
}

/** A database name in a GRANT, where `_` and `%` are wildcards: matched literally. */
function mysqlGrantDbName(dbName: string): string {
  return quoteMysqlIdentifier(dbName.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%'));
}

/** The GRANT pattern every "all databases" account holds (mysql-hardening.ts PREFIX_PATTERN). */
const MYSQL_PREFIX_PATTERN = `${SELF_SERVICE_DB_PREFIX.replace(/_/g, '\\_')}%`;

/** The "all databases" accounts: those holding the prefix grant. `'user'@'host'` ready for a GRANT. */
async function mysqlAllDatabasesAccounts(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
): Promise<string[]> {
  const out = await mysqlExec(kp, ns, pod, cn, pw,
    `SELECT HEX(User), HEX(Host) FROM mysql.db WHERE Db = '${MYSQL_PREFIX_PATTERN.replace(/\\/g, '\\\\')}'`);
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [u, h] = l.split('\t').map((c) => Buffer.from(c, 'hex').toString('utf8'));
    return h === '' ? quoteMysqlIdentifier(u) : `${mysqlLiteral(u)}@${mysqlLiteral(h)}`;
  });
}

/** A MariaDB/MySQL string literal. */
function mysqlLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * ALL on the self-service prefix and on each given database — what an "all
 * databases" account holds. Direct grants, not a role (mysql-hardening.ts
 * allDatabasesGrants says why).
 */
function mysqlAllDatabasesGrantSql(account: string, dbNames: readonly string[]): string {
  return [
    `GRANT ALL PRIVILEGES ON ${quoteMysqlIdentifier(MYSQL_PREFIX_PATTERN)}.* TO ${account}`,
    ...dbNames.map((d) => `GRANT ALL PRIVILEGES ON ${mysqlGrantDbName(d)}.* TO ${account}`),
  ].join('; ');
}

async function mysqlCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string,
): Promise<void> {
  await mysqlExec(kp, ns, pod, cn, pw, mysqlCreateDatabaseSql(dbName));
  // Every "all databases" account (and the tenant's administrator) reaches it.
  const accounts = await mysqlAllDatabasesAccounts(kp, ns, pod, cn, pw);
  if (accounts.length > 0) {
    await mysqlExec(kp, ns, pod, cn, pw, accounts.map((a) => `GRANT ALL PRIVILEGES ON ${mysqlGrantDbName(dbName)}.* TO ${a}`).join('; '));
  }
}

async function mysqlDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string,
): Promise<void> {
  await mysqlExec(kp, ns, pod, cn, pw, `DROP DATABASE IF EXISTS ${quoteMysqlIdentifier(dbName)}`);
}

async function mysqlListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
): Promise<readonly DbUser[]> {
  const systemUsers = new Set([
    'root', 'mariadb.sys', 'mysql.sys', 'mysql.infoschema', 'mysql.session', 'healthcheck',
    ...RESERVED_ACCOUNT_NAMES,
  ]);
  const out = await mysqlExec(
    kp, ns, pod, cn, pw,
    'SELECT User, Host FROM mysql.user',
  );
  const users = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [username, host] = line.split('\t');
      return { username, host: host ?? '%' };
    })
    .filter((u) => !systemUsers.has(u.username));

  // Query per-user database grants from mysql.db
  const dbGrantsOut = await mysqlExec(
    kp, ns, pod, cn, pw,
    'SELECT User, Db FROM mysql.db',
  );
  const grantsByUser = new Map<string, string[]>();
  for (const line of dbGrantsOut.split('\n').filter(Boolean)) {
    const [user, rawDb] = line.split('\t');
    if (!user || !rawDb) continue;
    const db = unescapeMysqlBatchField(rawDb);
    const existing = grantsByUser.get(user) ?? [];
    if (!existing.includes(db)) existing.push(db);
    grantsByUser.set(user, existing);
  }

  return users.map((u) => ({
    ...u,
    databases: grantsByUser.get(u.username) ?? [],
  }));
}

async function mysqlCreateUser(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  pw: string,
  username: string,
  password: string,
  dbName?: string,
): Promise<void> {
  await mysqlExec(
    kp, ns, pod, cn, pw,
    `CREATE USER IF NOT EXISTS '${username}'@'%' IDENTIFIED BY '${password}'`,
  );
  // ALWAYS set the password, never rely on CREATE to do it.
  //
  // `CREATE USER IF NOT EXISTS … IDENTIFIED BY` is a NO-OP when the user
  // already exists — the stored hash is untouched — but the caller has already
  // generated a fresh password and returns it to the panel, which displays it
  // as the credential. The operator then configures their application with a
  // password that was never applied and gets "Access denied".
  //
  // Reproduced on DEV: create user → retry the same username → the
  // hash is byte-identical, the newly displayed password fails, and the
  // ORIGINAL one still works. `CREATE OR REPLACE USER` would fix the password
  // but DROPS the user first, silently discarding every existing grant, so it
  // is the wrong tool here.
  await mysqlExec(
    kp, ns, pod, cn, pw,
    `ALTER USER '${username}'@'%' IDENTIFIED BY '${password}'`,
  );
  if (dbName) {
    await mysqlExec(
      kp, ns, pod, cn, pw,
      // Matched literally: as a pattern, `shop_db` would also grant `shopXdb`.
      `GRANT ALL PRIVILEGES ON ${mysqlGrantDbName(dbName)}.* TO '${username}'@'%'`,
    );
  } else {
    // No database chosen = the panel's "All databases" option: ALL on every
    // tenant database and on new `db_…` ones, kept in step by the platform
    // (mysql-hardening.ts ensureAllDatabasesAccounts). Not `ALL ON *.*`: that
    // includes CREATE USER and write access to the system schema, so such a
    // user could change root itself.
    const dbs = (await mysqlExec(kp, ns, pod, cn, pw, 'SELECT HEX(SCHEMA_NAME) FROM information_schema.SCHEMATA'))
      .split('\n').map((l) => Buffer.from(l.trim(), 'hex').toString('utf8'))
      .filter((d) => d && !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(d.toLowerCase()));
    await mysqlExec(kp, ns, pod, cn, pw, mysqlAllDatabasesGrantSql(`'${username}'@'%'`, dbs));
  }
  await mysqlExec(kp, ns, pod, cn, pw, 'FLUSH PRIVILEGES');
}

async function mysqlDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, username: string,
): Promise<void> {
  // Drop the account under every host it exists with — `'%'` alone silently
  // no-op'd for 'name'@'localhost' while the route answered 204.
  const hostsOut = await mysqlExec(kp, ns, pod, cn, pw, `SELECT Host FROM mysql.user WHERE User = '${username}'`);
  const hosts = hostsOut.split('\n').map((h) => h.trim()).filter(Boolean);
  for (const host of hosts) {
    await mysqlExec(kp, ns, pod, cn, pw, `DROP USER IF EXISTS '${username}'@'${host.replace(/'/g, "''")}'`);
  }
}

async function mysqlSetPassword(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  pw: string,
  username: string,
  newPassword: string,
): Promise<void> {
  // Change the account under every host it exists with. Hard-coding '%' made
  // the change fail for a user created as 'name'@'localhost' (or any other host).
  const hostsOut = await mysqlExec(
    kp, ns, pod, cn, pw,
    `SELECT Host FROM mysql.user WHERE User = '${username}'`,
  );
  const hosts = hostsOut.split('\n').map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    throw new ApiError('DB_USER_NOT_FOUND', `Database user "${username}" does not exist`, 404, { username });
  }
  for (const host of hosts) {
    await mysqlExec(
      kp, ns, pod, cn, pw,
      `ALTER USER '${username}'@'${host.replace(/'/g, "''")}' IDENTIFIED BY '${newPassword}'`,
    );
  }
  await mysqlExec(kp, ns, pod, cn, pw, 'FLUSH PRIVILEGES');
}

// ─── MariaDB/MySQL Query Execution ──────────────────────────────────────────

/**
 * Execute a query with --batch (tab-separated, with header row) for result parsing.
 * Unlike mysqlExec which uses --skip-column-names, this preserves column headers.
 */
async function mysqlExecWithHeaders(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  sql: string,
  login?: DbLogin,
): Promise<string> {
  // As root over the socket, or as `login` over TCP inside the pod — the way
  // the tenant's own tools reach it, with that account's privileges only.
  const auth = (bin: string): string[] => mysqlAuthArgs(bin, rootPassword, login);
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      [...asTenant(login), 'mariadb', ...auth('mariadb'), '-e', sql, '--batch'],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
    result = await execInPod(
      kubeconfigPath, namespace, podName, containerName,
      [...asTenant(login), 'mysql', ...auth('mysql'), '-e', sql, '--batch'],
    );
  }
  const { stdout, stderr } = result;
  if (stderr && stderr.includes('ERROR')) {
    throw dbEngineApiError(redactDbSecrets(stderr));
  }
  return stdout;
}

/**
 * Parse MySQL --batch output (tab-separated with header row) into columns and rows.
 *
 * --batch escapes DATA cells (`\\`, `\t`, `\n`, `\0`) so tabs and newlines
 * inside a value cannot break the grid; they are unescaped here, so the panel
 * shows — and a row edit writes back — the value the database holds, not
 * `C:\\path`. The header row is printed raw. Only the trailing newline is
 * dropped: an empty line is a real row whose only cell is ''.
 */
function parseMysqlBatchOutput(output: string): { columns: string[]; rows: string[][] } {
  const lines = output.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return { columns: [], rows: [] };

  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => line.split('\t').map(unescapeMysqlBatchField));
  return { columns, rows };
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

async function pgExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  sql: string,
): Promise<string> {
  // PostgreSQL uses trust/peer auth inside the container
  const { stdout, stderr } = await execInPod(
    kubeconfigPath,
    namespace,
    podName,
    containerName,
    pgSuperuserCommand('psql', ['-t', '-A', '-c', sql]),
  );
  if (stderr && stderr.includes('ERROR')) {
    throw dbEngineApiError(redactDbSecrets(stderr));
  }
  return stdout;
}

async function pgListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string,
): Promise<readonly DbDatabase[]> {
  const out = await pgExec(
    kp, ns, pod, cn,
    "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT IN ('postgres')",
  );
  return out.split('\n').filter(Boolean).map((name) => ({ name }));
}

async function pgCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, dbName: string,
): Promise<void> {
  const existing = await pgExec(
    kp, ns, pod, cn,
    `SELECT 1 FROM pg_database WHERE datname = '${dbName}'`,
  );
  if (!existing.trim()) {
    await pgExec(kp, ns, pod, cn, `CREATE DATABASE "${dbName}"`);
  }
}

async function pgDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, dbName: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `DROP DATABASE IF EXISTS ${quoteAnsiIdentifier(dbName)}`);
}

async function pgListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string,
): Promise<readonly DbUser[]> {
  const out = await pgExec(
    kp, ns, pod, cn,
    // Not the superuser (whatever its name) and not the platform's own accounts.
    `SELECT usename FROM pg_user WHERE NOT usesuper AND usename NOT IN (${['postgres', ...RESERVED_ACCOUNT_NAMES].map(quotePgStringLiteral).join(', ')})`, // allow-array-binding: quoted literals joined into SQL text for psql, not a drizzle bind
  );
  const users = out
    .split('\n')
    .filter(Boolean)
    .map((username) => ({ username, host: '*' }));

  // Query per-user database grants
  const dbGrantsOut = await pgExec(
    kp, ns, pod, cn,
    "SELECT grantee, table_catalog FROM information_schema.role_table_grants WHERE grantee NOT IN ('postgres', 'PUBLIC') GROUP BY grantee, table_catalog",
  );

  // Also check database-level grants via pg_database + has_database_privilege
  const dbListOut = await pgExec(kp, ns, pod, cn, "SELECT datname FROM pg_database WHERE datistemplate = false AND datname != 'postgres'");
  const allDbs = dbListOut.split('\n').filter(Boolean);

  const grantsByUser = new Map<string, string[]>();
  for (const user of users) {
    const userDbs: string[] = [];
    for (const db of allDbs) {
      const hasAccess = await pgExec(
        kp, ns, pod, cn,
        `SELECT has_database_privilege('${user.username}', ${quotePgStringLiteral(db)}, 'CONNECT')`,
      );
      if (hasAccess.trim() === 't') {
        userDbs.push(db);
      }
    }
    if (userDbs.length > 0) {
      grantsByUser.set(user.username, userDbs);
    }
  }

  return users.map((u) => ({
    ...u,
    databases: grantsByUser.get(u.username) ?? [],
  }));
}

async function pgCreateUser(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  username: string,
  password: string,
  dbName?: string,
): Promise<void> {
  const existing = await pgExec(
    kp, ns, pod, cn,
    `SELECT 1 FROM pg_roles WHERE rolname = '${username}'`,
  );
  if (!existing.trim()) {
    await pgExec(kp, ns, pod, cn, `CREATE USER "${username}" WITH PASSWORD '${password}'`);
  } else {
    // Same defect as the MySQL path: skipping creation for an existing role
    // also skips setting the password, while the caller still hands the newly
    // generated one to the panel. ALTER makes the displayed password true.
    await pgExec(kp, ns, pod, cn, `ALTER USER "${username}" WITH PASSWORD '${password}'`);
  }
  if (dbName) {
    await pgExec(
      kp, ns, pod, cn,
      `GRANT ALL PRIVILEGES ON DATABASE ${quoteAnsiIdentifier(dbName)} TO "${username}"`,
    );
  } else {
    // "All databases". PostgreSQL has no `*.*`, so grant on each non-template
    // database that exists. New databases created later are NOT covered — that
    // is a real limitation of the option, and the panel says so rather than
    // pretending otherwise.
    const dbs = await pgExec(
      kp, ns, pod, cn,
      // The server's own `postgres` is no tenant database (refuseReservedDatabaseName).
      "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres'",
    );
    for (const raw of dbs.split('\n')) {
      const name = raw.trim();
      if (!name || name.startsWith('(')) continue;
      await pgExec(
        kp, ns, pod, cn,
        `GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${username}"`,
      );
    }
  }
}

async function pgDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, username: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `DROP USER IF EXISTS "${username}"`);
}

async function pgSetPassword(
  kp: string | undefined,
  ns: string,
  pod: string,
  cn: string,
  username: string,
  newPassword: string,
): Promise<void> {
  await pgExec(kp, ns, pod, cn, `ALTER USER "${username}" WITH PASSWORD '${newPassword}'`);
}

// ─── PostgreSQL Query Execution ─────────────────────────────────────────────

/**
 * Execute a PostgreSQL query with --csv output for result parsing.
 *
 * With `rowCountMarker`, psql runs quietly — no `UPDATE 1` status line for the
 * CSV parser to take as a header — and then prints the statement's row count
 * under that marker (affected-rows.ts).
 */
async function pgExecCsv(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  database: string,
  sql: string,
  rowCountMarker?: string,
  login?: DbLogin,
): Promise<string> {
  // A `-c` string that starts with a backslash is a psql command (`\\! id`
  // runs a shell); with a leading newline psql sends it all to the server as
  // SQL. A tenant's SQL is always sent that way.
  const query = login ? `\n${sql}` : sql;
  const rowCount = rowCountMarker ? ['-q', '-c', query, '-c', psqlRowCountCommand(rowCountMarker)] : ['-c', query];
  // A bare `-d x=y` is read as a connection string; see pgConnInfoDbName.
  const args = ['-X', '-d', pgConnInfoDbName(database), ...rowCount, '--csv'];
  const { stdout, stderr } = await execInPod(
    kubeconfigPath,
    namespace,
    podName,
    containerName,
    // `login` by the image's local trust: no password to send or to drift.
    login ? [...asTenant(login), 'psql', '-U', login.username, ...args] : pgSuperuserCommand('psql', args),
  );
  if (stderr && stderr.includes('ERROR')) {
    throw dbEngineApiError(redactDbSecrets(stderr));
  }
  return stdout;
}

/**
 * Parse PostgreSQL --csv output (CSV with header row) into columns and rows.
 * Handles quoted fields containing commas and newlines.
 */
function parsePgCsvOutput(output: string): { columns: string[]; rows: string[][] } {
  const rows = parseCsvLines(output);
  if (rows.length === 0) return { columns: [], rows: [] };
  return { columns: rows[0], rows: rows.slice(1) };
}

/**
 * Minimal CSV parser that handles quoted fields.
 */
function parseCsvLines(input: string): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ""
        if (i + 1 < input.length && input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(field);
      field = '';
    } else if (ch === '\n') {
      current.push(field);
      field = '';
      if (current.some((f) => f !== '')) {
        result.push(current);
      }
      current = [];
    } else if (ch === '\r') {
      // skip carriage return
    } else {
      field += ch;
    }
  }

  // Handle last field/line
  if (field || current.length > 0) {
    current.push(field);
    if (current.some((f) => f !== '')) {
      result.push(current);
    }
  }

  return result;
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

async function mongoExec(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  rootPassword: string,
  command: string,
  rootUsername = 'root',
  /** Run as this login (the tenant's administrator), unprivileged in the pod. */
  tenant = false,
): Promise<string> {
  // `-p` with no value reads the password from stdin: never in argv, where
  // any process in the pod could read it from /proc/<pid>/cmdline.
  const authArgs = rootPassword
    ? ['-u', rootUsername, '-p', '--authenticationDatabase', 'admin']
    : [];
  const argv = [...(tenant ? UNPRIVILEGED : []), 'mongosh', '--quiet', '--norc', ...authArgs, '--eval', command];
  const { stdout, stderr } = rootPassword
    ? await execInPodWithStdin(kubeconfigPath, namespace, podName, containerName, argv, `${rootPassword}\n`)
    : await execInPod(kubeconfigPath, namespace, podName, containerName, argv);
  if (stderr && stderr.includes('MongoServerError')) {
    throw dbEngineApiError(redactDbSecrets(stderr));
  }
  return stdout;
}

async function mongoListDatabases(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, user = 'root',
): Promise<readonly DbDatabase[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    'db.adminCommand({listDatabases:1}).databases.filter(d=>!["admin","config","local"].includes(d.name)).map(d=>d.name).join("\\n")',
    user,
  );
  return out.split('\n').filter(Boolean).map((name) => ({ name }));
}

async function mongoCreateDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string, user = 'root',
): Promise<void> {
  await mongoExec(kp, ns, pod, cn, pw,
    `db = db.getSiblingDB("${mongoEscapeString(dbName)}"); db.createCollection("_init")`,
    user,
  );
}

async function mongoDropDatabase(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, dbName: string, user = 'root',
): Promise<void> {
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${mongoEscapeString(dbName)}").dropDatabase()`,
    user,
  );
}

async function mongoListCollections(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, database: string, user = 'root',
): Promise<readonly string[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${mongoEscapeString(database)}").getCollectionNames().filter(c=>c!=='_init').join("\\n")`,
    user,
  );
  return out.split('\n').filter(Boolean);
}

async function mongoListUsers(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, user = 'root',
): Promise<readonly DbUser[]> {
  const out = await mongoExec(kp, ns, pod, cn, pw,
    'db.getSiblingDB("admin").system.users.find({},{user:1,roles:1}).toArray().map(u => u.user + "\\t" + u.roles.map(r=>r.db||"admin").join(",")).join("\\n")',
    user,
  );
  return out.split('\n').filter(Boolean).map((line) => {
    const [username, dbs] = line.split('\t');
    return { username, host: '*', databases: dbs ? dbs.split(',') : [] };
  });
}

async function mongoCreateUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
  username: string, password: string, database?: string, rootUser = 'root',
): Promise<void> {
  // No database = the panel's "All databases": readWriteAnyDatabase (readWrite
  // on `admin` alone would reach none of the tenant's data).
  const db = database ?? 'admin';
  const role = database ? `{role:"readWrite",db:"${mongoEscapeString(db)}"}` : '{role:"readWriteAnyDatabase",db:"admin"}';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${mongoEscapeString(db)}").createUser({user:"${mongoEscapeString(username)}",pwd:"${mongoEscapeString(password)}",roles:[${role}]})`,
    rootUser,
  );
}

async function mongoDropUser(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string, username: string, rootUser = 'root',
): Promise<void> {
  // Find the user's database first — users may be created on specific databases, not admin
  const dbName = await mongoExec(kp, ns, pod, cn, pw,
    `var u = db.getSiblingDB("admin").system.users.findOne({user:"${mongoEscapeString(username)}"}); u ? u.db : "admin"`,
    rootUser,
  );
  const targetDb = dbName.trim() || 'admin';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${mongoEscapeString(targetDb)}").dropUser("${mongoEscapeString(username)}")`,
    rootUser,
  );
}

async function mongoSetPassword(
  kp: string | undefined, ns: string, pod: string, cn: string, pw: string,
  username: string, newPassword: string, rootUser = 'root',
): Promise<void> {
  // Find the user's database first
  const dbName = await mongoExec(kp, ns, pod, cn, pw,
    `var u = db.getSiblingDB("admin").system.users.findOne({user:"${mongoEscapeString(username)}"}); u ? u.db : "admin"`,
    rootUser,
  );
  const targetDb = dbName.trim() || 'admin';
  await mongoExec(kp, ns, pod, cn, pw,
    `db.getSiblingDB("${mongoEscapeString(targetDb)}").changeUserPassword("${mongoEscapeString(username)}","${mongoEscapeString(newPassword)}")`,
    rootUser,
  );
}

async function mongoExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
  login?: DbLogin,
): Promise<QueryResult> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    login ? login.password : ctx.rootPassword,
    `db = db.getSiblingDB("${mongoEscapeString(database)}"); EJSON.stringify(${query})`,
    login ? login.username : ctx.rootUsername,
    Boolean(login),
  );
  const elapsed = Date.now() - startTime;

  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
      const rows = parsed.map((doc: Record<string, unknown>) =>
        columns.map((c) => String(doc[c] ?? '')),
      );
      return { columns, rows, rowCount: rows.length, executionTimeMs: elapsed };
    }
  } catch {
    // Not JSON, return as raw text
  }
  return { columns: ['result'], rows: [[out]], rowCount: 1, executionTimeMs: elapsed };
}

/**
 * Describe a MongoDB collection by sampling a document to infer field names.
 * MongoDB is schema-less, so we return fields from the first document found.
 */
async function mongoDescribeCollection(
  ctx: DbManagerContext,
  database: string,
  collection: string,
): Promise<readonly ColumnInfo[]> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword,
    `EJSON.stringify(Object.keys(db.getSiblingDB("${mongoEscapeString(database)}").getCollection(${JSON.stringify(collection)}).findOne() || {}))`,
    ctx.rootUsername,
  );

  try {
    const fields = JSON.parse(out);
    if (Array.isArray(fields)) {
      return fields.map((name: string) => ({
        name,
        type: 'mixed',
        nullable: true,
        defaultValue: null,
        key: name === '_id' ? 'PRI' : '',
      }));
    }
  } catch {
    // No documents or parse error
  }
  return [];
}

/**
 * Browse a MongoDB collection with pagination.
 */
async function mongoBrowseCollection(
  ctx: DbManagerContext,
  database: string,
  collection: string,
  options: BrowseOptions,
  login?: DbLogin,
): Promise<QueryResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderDir = options.orderDir === 'desc' ? -1 : 1;

  let sortExpr = '{}';
  if (options.orderBy) {
    sortExpr = `{${JSON.stringify(options.orderBy)}:${orderDir}}`;
  }

  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    login ? login.password : ctx.rootPassword,
    `EJSON.stringify(db.getSiblingDB("${mongoEscapeString(database)}").getCollection(${JSON.stringify(collection)}).find().sort(${sortExpr}).skip(${offset}).limit(${limit}).toArray())`,
    login ? login.username : ctx.rootUsername,
    Boolean(login),
  );
  const start = Date.now();

  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      const columns = parsed.length > 0 ? Object.keys(parsed[0]) : [];
      const rows = parsed.map((doc: Record<string, unknown>) =>
        columns.map((c) => {
          const val = doc[c];
          return typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
        }),
      );
      return { columns, rows, rowCount: rows.length, executionTimeMs: Date.now() - start };
    }
  } catch {
    // parse error
  }
  return { columns: ['result'], rows: [[out]], rowCount: 1, executionTimeMs: Date.now() - start };
}

/**
 * Count documents in a MongoDB collection.
 */
async function mongoCountDocuments(
  ctx: DbManagerContext,
  database: string,
  collection: string,
  login?: DbLogin,
): Promise<number> {
  const out = await mongoExec(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    login ? login.password : ctx.rootPassword,
    `db.getSiblingDB("${mongoEscapeString(database)}").getCollection(${JSON.stringify(collection)}).countDocuments()`,
    login ? login.username : ctx.rootUsername,
    Boolean(login),
  );
  return parseInt(out.trim(), 10) || 0;
}

/**
 * Export a MongoDB database using mongodump --archive (outputs to stdout).
 */
async function mongoExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  // No --password: the tool prompts and reads it from stdin, never argv (mongoExec says why).
  const authArgs = ctx.rootPassword ? ['-u', ctx.rootUsername, '--authenticationDatabase', 'admin'] : [];
  try {
    const argv = ['mongodump', `--db=${database}`, ...authArgs, '--archive=/dev/stdout', '--gzip'];
    const { stdout, stderr } = ctx.rootPassword
      ? await execInPodWithStdin(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv, `${ctx.rootPassword}\n`)
      // `--db=<name>`: as a separate argument a name starting with `-` reads as an option.
      : await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv);
    if (stderr && stderr.includes('error')) {
      throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
    }
    return stdout;
  } catch (err) {
    if (isBinaryNotFoundError(err)) {
      throw new ApiError(
        'EXPORT_NOT_AVAILABLE',
        'mongodump is not available in this MongoDB container. Use mongosh to export individual collections.',
        400,
      );
    }
    throw err;
  }
}

/**
 * Import into a MongoDB database using mongorestore from stdin.
 */
async function mongoImportDatabase(
  ctx: DbManagerContext,
  database: string,
  data: string,
  login?: DbLogin,
): Promise<ImportResult> {
  const user = login ? login.username : ctx.rootUsername;
  const password = login ? login.password : ctx.rootPassword;
  try {
    // stdin carries the archive, so the password goes in a config file only
    // root can read — first line of stdin, as a JSON (= YAML) string; never argv.
    const script = 'umask 077; f=$(mktemp); trap \'rm -f "$f"\' EXIT; IFS= read -r line; '
      + 'printf \'password: %s\\n\' "$line" > "$f"; mongorestore --config="$f" "$@"';
    const { stderr } = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      password
        ? ['sh', '-c', script, 'sh', `--db=${database}`, '-u', user, '--authenticationDatabase', 'admin', '--archive=/dev/stdin', '--gzip']
        : ['mongorestore', `--db=${database}`, '--archive=/dev/stdin', '--gzip'],
      password ? `${JSON.stringify(password)}\n${data}` : data,
    );
    if (stderr && stderr.includes('error')) {
      return { success: false, error: stderr };
    }
    return { success: true };
  } catch (err) {
    if (isBinaryNotFoundError(err)) {
      return {
        success: false,
        error: 'mongorestore is not available in this MongoDB container.',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function buildDbContext(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  deploymentName: string,
  catalogEntry: { runtime?: string | null; code: string },
  configuration: Record<string, unknown>,
  dbEngine?: Engine,
  componentName?: string,
): Promise<DbManagerContext> {
  const engine = dbEngine ?? detectEngine(catalogEntry);
  // Pod is labeled `app=<deploymentName>` (raw, same for every component of
  // the deployment) and — for multi-component apps — `component=<name>`. We
  // pin both so we don't accidentally target the app pod (e.g. wordpress)
  // when the DB is just one of several components.
  const podName = await findPodName(k8s, namespace, deploymentName, componentName);

  // Container name: for multi-component apps, use the DB component name;
  // for standalone databases, use the catalog entry code
  const containerName = componentName ?? catalogEntry.code;

  // Get root password from configuration
  let rootPassword = '';
  let rootUsername = 'root';
  if (engine === 'mariadb') rootPassword = String(configuration.MARIADB_ROOT_PASSWORD ?? '');
  else if (engine === 'mysql') rootPassword = String(configuration.MYSQL_ROOT_PASSWORD ?? '');
  else if (engine === 'mongodb') {
    rootPassword = String(configuration.MONGO_INITDB_ROOT_PASSWORD ?? '');
    rootUsername = String(configuration.MONGO_INITDB_ROOT_USERNAME ?? 'root');
  } else if (engine === 'postgresql') {
    // Local trust inside the container — no password. The superuser is the
    // one the image was initialised with (POSTGRES_USER, default postgres).
    rootUsername = typeof configuration.POSTGRES_USER === 'string' && configuration.POSTGRES_USER.trim()
      ? configuration.POSTGRES_USER.trim()
      : 'postgres';
  }

  return { kubeconfigPath, namespace, podName, containerName, engine, rootPassword, rootUsername, k8s };
}

export async function listDatabases(ctx: DbManagerContext): Promise<readonly DbDatabase[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlListDatabases(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgListDatabases(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName);
  }
  if (ctx.engine === 'mongodb') {
    return mongoListDatabases(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, ctx.rootUsername,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database listing not supported`, 400);
}

export async function createDatabase(ctx: DbManagerContext, name: string): Promise<void> {
  validateIdentifier(name, 'database name');
  refuseReservedDatabaseName(ctx.engine, name);
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlCreateDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgCreateDatabase(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, name);
  }
  if (ctx.engine === 'mongodb') {
    return mongoCreateDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name, ctx.rootUsername,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database creation not supported`, 400);
}

export async function dropDatabase(ctx: DbManagerContext, name: string): Promise<void> {
  // Dropping names an EXISTING database (`2024-old` included); creating stays strict.
  validateDatabaseName(name);
  // Dropped as root: `mysql` takes the server's accounts with it.
  refuseReservedDatabaseName(ctx.engine, name);
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlDropDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgDropDatabase(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, name);
  }
  if (ctx.engine === 'mongodb') {
    return mongoDropDatabase(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, name, ctx.rootUsername,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database deletion not supported`, 400);
}

export async function listUsers(ctx: DbManagerContext): Promise<readonly DbUser[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlListUsers(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword,
    );
  }
  if (ctx.engine === 'postgresql') {
    return pgListUsers(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName);
  }
  if (ctx.engine === 'mongodb') {
    return mongoListUsers(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, ctx.rootUsername,
    );
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user listing not supported`, 400);
}

export async function createUser(
  ctx: DbManagerContext,
  username: string,
  password: string,
  database?: string,
): Promise<void> {
  try {
    validateIdentifier(username, 'username');
    refuseReservedAccount(ctx, username);
    // The grant targets an EXISTING database; only the username is created here.
    if (database) {
      validateDatabaseName(database);
      refuseReservedDatabaseName(ctx.engine, database);
    }
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlCreateUser(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ctx.rootPassword, username, password, database,
      );
    }
    if (ctx.engine === 'postgresql') {
      return await pgCreateUser(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        username, password, database,
      );
    }
    if (ctx.engine === 'mongodb') {
      return await mongoCreateUser(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ctx.rootPassword, username, password, database, ctx.rootUsername,
      );
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user creation not supported`, 400);
  } catch (err) {
    throw asDbApiError(err);
  }
}

export async function dropUser(ctx: DbManagerContext, username: string): Promise<void> {
  try {
    validateIdentifier(username, 'username');
    refuseReservedAccount(ctx, username);
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlDropUser(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, username,
      );
    }
    if (ctx.engine === 'postgresql') {
      return await pgDropUser(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, username);
    }
    if (ctx.engine === 'mongodb') {
      return await mongoDropUser(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, ctx.rootPassword, username, ctx.rootUsername,
      );
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} user deletion not supported`, 400);
  } catch (err) {
    throw asDbApiError(err);
  }
}

export async function setUserPassword(
  ctx: DbManagerContext,
  username: string,
  password: string,
): Promise<void> {
  try {
    validateIdentifier(username, 'username');
    refuseReservedAccount(ctx, username);
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlSetPassword(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ctx.rootPassword, username, password,
      );
    }
    if (ctx.engine === 'postgresql') {
      return await pgSetPassword(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, username, password,
      );
    }
    if (ctx.engine === 'mongodb') {
      return await mongoSetPassword(
        ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ctx.rootPassword, username, password, ctx.rootUsername,
      );
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} password change not supported`, 400);
  } catch (err) {
    throw asDbApiError(err);
  }
}

// ─── Query Execution ────────────────────────────────────────────────────────

function validateQueryLength(query: string): void {
  if (Buffer.byteLength(query, 'utf-8') > MAX_QUERY_LENGTH) {
    throw new ApiError(
      'QUERY_TOO_LARGE',
      `Query exceeds maximum length of ${MAX_QUERY_LENGTH} bytes`,
      400,
      { maxBytes: MAX_QUERY_LENGTH },
    );
  }
}

/**
 * A database the engine already holds (`2024-school`, `it's`): judged like any
 * existing name, not by the CREATE charset (validateIdentifier, which still
 * guards names the platform creates). Every command line that takes it passes
 * it so it cannot read as an option or a connection string.
 */
function validateDatabaseName(database: string): void {
  validateExistingName(database, 'database');
}

/**
 * Execute an arbitrary SQL query against a database and return structured results.
 */
export async function executeQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  /**
   * `as`: run the query as this account instead of root — the SQL console
   * runs a tenant's SQL as the tenant's administrator, so its privileges, not
   * a regex, decide what it can touch.
   */
  opts: { readonly as?: DbLogin } = {},
): Promise<QueryResult> {
  validateDatabaseName(database);
  validateQueryLength(query);

  const start = Date.now();

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlExecuteQuery(ctx, database, query, start, opts.as);
    }
    if (ctx.engine === 'postgresql') {
      return await pgExecuteQuery(ctx, database, query, start, opts.as);
    }
    if (ctx.engine === 'mongodb') {
      return await mongoExecuteQuery(ctx, database, query, start, opts.as);
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} query execution not supported`, 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: elapsed,
      error: message,
    };
  }
}

async function mysqlExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
  login?: DbLogin,
): Promise<QueryResult> {
  const marker = affectedRowsMarker();
  const sql = `USE ${quoteMysqlIdentifier(database)}; ${withMysqlRowCount(query, marker)}`;
  const output = await mysqlExecWithHeaders(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword, sql, login,
  );
  const elapsed = Date.now() - startTime;
  const counted = splitRowCount(output, marker, '\n');
  const { columns, rows } = parseMysqlBatchOutput(counted.output);

  return {
    columns,
    rows,
    rowCount: rows.length,
    ...affectedRowsField(columns, counted.count),
    executionTimeMs: elapsed,
  };
}

async function pgExecuteQuery(
  ctx: DbManagerContext,
  database: string,
  query: string,
  startTime: number,
  login?: DbLogin,
): Promise<QueryResult> {
  const marker = affectedRowsMarker();
  const output = await pgExecCsv(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    database, query, marker, login,
  );
  const elapsed = Date.now() - startTime;
  const counted = splitRowCount(output, marker, ' ');
  const { columns, rows } = parsePgCsvOutput(counted.output);

  return {
    columns,
    rows,
    rowCount: rows.length,
    ...affectedRowsField(columns, counted.count),
    executionTimeMs: elapsed,
  };
}

// ─── Table Listing ──────────────────────────────────────────────────────────

/**
 * List all tables (or collections) in a given database. A database that is
 * gone answers 404 DATABASE_NOT_FOUND (asDbApiError), not a generic 500.
 */
export async function listTables(
  ctx: DbManagerContext,
  database: string,
): Promise<readonly string[]> {
  validateDatabaseName(database);
  try {
    return await listTablesOf(ctx, database);
  } catch (err) {
    throw asDbApiError(err);
  }
}

async function listTablesOf(ctx: DbManagerContext, database: string): Promise<readonly string[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, `SHOW TABLES FROM ${quoteMysqlIdentifier(database)}`,
    );
    return out.split('\n').filter(Boolean).map(unescapeMysqlBatchField);
  }

  if (ctx.engine === 'postgresql') {
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      database, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.map((r) => r[0]).filter(Boolean);
  }

  if (ctx.engine === 'mongodb') {
    return mongoListCollections(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, database, ctx.rootUsername,
    );
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table listing not supported`, 400);
}

// ─── Table/Database Sizes ────────────────────────────────────────────────────

export interface TableWithSize {
  readonly name: string;
  readonly sizeBytes: number;
  readonly rowCount: number;
}

export interface DatabaseWithSize {
  readonly name: string;
  readonly sizeBytes: number;
}

export async function listTablesWithSize(
  ctx: DbManagerContext,
  database: string,
): Promise<readonly TableWithSize[]> {
  validateDatabaseName(database);
  try {
    return await listTablesWithSizeOf(ctx, database);
  } catch (err) {
    throw asDbApiError(err);
  }
}

async function listTablesWithSizeOf(ctx: DbManagerContext, database: string): Promise<readonly TableWithSize[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword,
      // DATABASE() after USE: no string literal to escape for the schema name.
      `USE ${quoteMysqlIdentifier(database)}; SELECT TABLE_NAME, COALESCE(DATA_LENGTH + INDEX_LENGTH, 0), TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
    );
    return out.split('\n').filter(Boolean).map((line) => {
      const [name, size, rows] = line.split('\t');
      return { name: unescapeMysqlBatchField(name), sizeBytes: parseInt(size, 10) || 0, rowCount: parseInt(rows, 10) || 0 };
    });
  }

  if (ctx.engine === 'postgresql') {
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      database,
      // format('%I.%I') quotes the name. The bare `schemaname || '.' || tablename`
      // folded `CityTb` to citytb and choked on `1-StudentsTb`, failing the whole list.
      "SELECT t.tablename, pg_total_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass), COALESCE(s.n_live_tup, 0) "
        + "FROM pg_tables t LEFT JOIN pg_stat_user_tables s ON s.schemaname = t.schemaname AND s.relname = t.tablename "
        + "WHERE t.schemaname = 'public' ORDER BY t.tablename",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.filter((r) => r[0]).map((r) => ({
      name: r[0],
      sizeBytes: parseInt(r[1], 10) || 0,
      rowCount: parseInt(r[2], 10) || 0,
    }));
  }

  // MongoDB: return collection stats
  if (ctx.engine === 'mongodb') {
    const tables = await mongoListCollections(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword, database, ctx.rootUsername,
    );
    return tables.map((name) => ({ name, sizeBytes: 0, rowCount: 0 }));
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table size not supported`, 400);
}

export async function listDatabasesWithSize(
  ctx: DbManagerContext,
): Promise<readonly DatabaseWithSize[]> {
  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    // Use lightweight SHOW DATABASES instead of information_schema.TABLES.
    // The aggregate query (SUM over all schemas) forces InnoDB to stat every tablespace,
    // consuming 100+ Mi of temporary memory — enough to OOM-kill small containers.
    // Per-database sizes are fetched individually via listTablesWithSize when selected.
    const systemDbs = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', '']);
    const out = await mysqlExec(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ctx.rootPassword,
      'SHOW DATABASES',
    );
    return out.split('\n').filter(Boolean).map(unescapeMysqlBatchField)
      .filter((name) => !systemDbs.has(name))
      .map((name) => ({ name, sizeBytes: 0 }));
  }

  if (ctx.engine === 'postgresql') {
    const systemDbs = new Set(['template0', 'template1', 'postgres', '']);
    const csvOut = await pgExecCsv(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      'postgres',
      "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false",
    );
    const { rows } = parsePgCsvOutput(csvOut);
    return rows.filter((r) => r[0] && !systemDbs.has(r[0])).map((r) => ({
      name: r[0],
      sizeBytes: parseInt(r[1], 10) || 0,
    }));
  }

  // Fallback: return databases without sizes
  const dbs = await listDatabases(ctx);
  return dbs.map((d) => ({ ...d, sizeBytes: 0 }));
}

// ─── Table Structure ────────────────────────────────────────────────────────

/**
 * Describe the structure (columns) of a table.
 */
export async function describeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  validateDatabaseName(database);
  validateExistingName(table, 'table');

  // asDbApiError: the panel must see the engine's own message ("Table … doesn't
  // exist"), not a generic 500.
  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlDescribeTable(ctx, database, table);
    }
    if (ctx.engine === 'postgresql') {
      return await pgDescribeTable(ctx, database, table);
    }
    if (ctx.engine === 'mongodb') {
      return await mongoDescribeCollection(ctx, database, table);
    }
  } catch (err) {
    throw asDbApiError(err);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table description not supported`, 400);
}

async function mysqlDescribeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  const output = await mysqlExecWithHeaders(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ctx.rootPassword, `DESCRIBE ${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(table)}`,
  );
  const { rows } = parseMysqlBatchOutput(output);

  // DESCRIBE output columns: Field, Type, Null, Key, Default, Extra.
  // parseMysqlBatchOutput already unescaped the cells — do not unescape twice.
  return rows.map((row) => ({
    name: row[0] ?? '',
    type: row[1] ?? '',
    nullable: (row[2] ?? 'NO') === 'YES',
    defaultValue: row[4] === 'NULL' || row[4] === undefined ? null : row[4],
    key: row[3] ?? '',
  }));
}

async function pgDescribeTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
): Promise<readonly ColumnInfo[]> {
  const sql = `SELECT
    c.column_name,
    c.data_type,
    c.is_nullable,
    c.column_default,
    COALESCE(tc.constraint_type, '') AS key_type
  FROM information_schema.columns c
  LEFT JOIN information_schema.key_column_usage kcu
    ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name AND c.table_schema = kcu.table_schema
  LEFT JOIN information_schema.table_constraints tc
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  WHERE c.table_name = ${quotePgStringLiteral(table)} AND c.table_schema = 'public'
  ORDER BY c.ordinal_position`;

  const output = await pgExecCsv(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    database, sql,
  );
  const { rows } = parsePgCsvOutput(output);

  // Map PostgreSQL constraint types to MySQL-style key indicators
  const keyMap: Record<string, string> = {
    'PRIMARY KEY': 'PRI',
    'UNIQUE': 'UNI',
    'FOREIGN KEY': 'MUL',
  };

  return rows.map((row) => ({
    name: row[0] ?? '',
    type: row[1] ?? '',
    nullable: (row[2] ?? 'NO') === 'YES',
    defaultValue: row[3] || null,
    key: keyMap[row[4] ?? ''] ?? '',
  }));
}

// ─── Table Data Browsing ────────────────────────────────────────────────────

export interface BrowseOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: string;
  readonly orderDir?: 'asc' | 'desc';
}

/**
 * Browse table data with pagination and ordering.
 */
export async function browseTable(
  ctx: DbManagerContext,
  database: string,
  table: string,
  options: BrowseOptions = {},
  /**
   * `as`: the tenant's administrator. Reading a view runs the tenant's code
   * in it (its functions run as the reader), so a tenant's table is never
   * read as root.
   */
  opts: { readonly as?: DbLogin } = {},
): Promise<QueryResult> {
  validateDatabaseName(database);
  validateExistingName(table, 'table');
  if (options.orderBy) validateExistingName(options.orderBy, 'column');

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const orderDir = options.orderDir === 'desc' ? 'DESC' : 'ASC';

  if (ctx.engine === 'mongodb') {
    return mongoBrowseCollection(ctx, database, table, { limit, offset, orderBy: options.orderBy, orderDir: options.orderDir }, opts.as);
  }

  const quote = ctx.engine === 'mariadb' || ctx.engine === 'mysql' ? quoteMysqlIdentifier
    : ctx.engine === 'postgresql' ? quoteAnsiIdentifier
    : undefined;
  if (!quote) {
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} table browsing not supported`, 400);
  }

  const orderClause = options.orderBy ? ` ORDER BY ${quote(options.orderBy)} ${orderDir}` : '';
  const result = await executeQuery(ctx, database, `SELECT * FROM ${quote(table)}${orderClause} LIMIT ${limit} OFFSET ${offset}`, opts);
  // executeQuery reports engine errors inline — right for the query tab, which
  // renders them as the result. Browsing has no such surface: an inline error
  // looked like an empty table, so it becomes an error response here.
  if (result.error) {
    throw dbEngineApiError(result.error);
  }
  return result;
}

// ─── Row Count ──────────────────────────────────────────────────────────────

/**
 * Get the row count of a table.
 */
export async function countRows(
  ctx: DbManagerContext,
  database: string,
  table: string,
  /** `as`: the tenant's administrator — see browseTable. */
  opts: { readonly as?: DbLogin } = {},
): Promise<number> {
  validateDatabaseName(database);
  validateExistingName(table, 'table');

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql' || ctx.engine === 'postgresql') {
      const quote = ctx.engine === 'postgresql' ? quoteAnsiIdentifier : quoteMysqlIdentifier;
      const result = await executeQuery(ctx, database, `SELECT COUNT(*) FROM ${quote(table)}`, opts);
      if (result.error) throw dbEngineApiError(result.error);
      return parseInt(String(result.rows[0]?.[0] ?? '0'), 10) || 0;
    }

    if (ctx.engine === 'mongodb') {
      return await mongoCountDocuments(ctx, database, table, opts.as);
    }
  } catch (err) {
    throw asDbApiError(err);
  }

  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} row counting not supported`, 400);
}

// ──��� Apply New Credentials to Running Database ─────────────────────────────


// ─── Export Database ────────────────────────────────────────────────────────

/**
 * Export a database as a SQL dump string.
 */
export async function exportDatabase(
  ctx: DbManagerContext,
  database: string,
): Promise<string> {
  validateDatabaseName(database);

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    return mysqlExportDatabase(ctx, database);
  }
  if (ctx.engine === 'postgresql') {
    return pgExportDatabase(ctx, database);
  }
  if (ctx.engine === 'mongodb') {
    return mongoExportDatabase(ctx, database);
  }
  throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} database export not supported`, 400);
}

async function mysqlExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  // Try mariadb-dump first (MariaDB 11+), fall back to mysqldump only when binary is missing
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      // `--` ends the options: a database named `-x` must not read as one.
      ['mariadb-dump', '-u', 'root', `-p${ctx.rootPassword}`, '--routines', '--triggers', '--', database],
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) throw err;
    result = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['mysqldump', '-u', 'root', `-p${ctx.rootPassword}`, '--routines', '--triggers', '--', database],
    );
  }
  if (result.stderr && result.stderr.includes('ERROR')) {
    throw new ApiError('DB_EXPORT_ERROR', result.stderr, 500);
  }
  return result.stdout;
}

async function pgExportDatabase(ctx: DbManagerContext, database: string): Promise<string> {
  const { stdout, stderr } = await execInPod(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    pgSuperuserCommand('pg_dump', [`--dbname=${pgConnInfoDbName(database)}`]),
  );
  if (stderr && stderr.includes('ERROR')) {
    throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  }
  return stdout;
}

// ─── Import SQL ─────────────────────────────────────────────────────────────

/**
 * Import SQL into a database by piping it through stdin to the CLI tool.
 */
export async function importSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
  /** `as`: import as this account (the tenant's administrator) instead of root — see import-rewrite.ts. */
  opts: { readonly as?: DbLogin } = {},
): Promise<ImportResult> {
  validateDatabaseName(database);

  if (Buffer.byteLength(sql, 'utf-8') > MAX_IMPORT_LENGTH) {
    throw new ApiError(
      'IMPORT_TOO_LARGE',
      `SQL import exceeds maximum size of ${Math.round(MAX_IMPORT_LENGTH / 1_048_576)}MB. Upload the file via File Manager and use "Import from File" instead.`,
      400,
      { maxBytes: MAX_IMPORT_LENGTH },
    );
  }

  const systemHit = findSystemStatement(sql, ctx.engine);
  if (systemHit) return { success: false, error: systemImportRefusal(ctx.engine, systemHit) };

  try {
    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      return await mysqlImportSql(ctx, database, opts.as ? rewriteMysqlDumpForTenant(sql) : sql, opts.as);
    }
    if (ctx.engine === 'postgresql') {
      return await pgImportSql(ctx, database, sql, opts.as);
    }
    if (ctx.engine === 'mongodb') {
      return await mongoImportDatabase(ctx, database, sql, opts.as);
    }
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} SQL import not supported`, 400);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

async function mysqlImportSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
  login?: DbLogin,
): Promise<ImportResult> {
  let result: { stdout: string; stderr: string };
  try {
    result = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      [...asTenant(login), 'mariadb', ...mysqlAuthArgs('mariadb', ctx.rootPassword, login), `--database=${database}`],
      sql,
    );
  } catch (err) {
    if (!isBinaryNotFoundError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
    result = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      [...asTenant(login), 'mysql', ...mysqlAuthArgs('mysql', ctx.rootPassword, login), `--database=${database}`],
      sql,
    );
  }
  if (result.stderr && result.stderr.includes('ERROR')) {
    return { success: false, error: result.stderr };
  }
  return { success: true };
}

async function pgImportSql(
  ctx: DbManagerContext,
  database: string,
  sql: string,
  login?: DbLogin,
): Promise<ImportResult> {
  const args = ['-d', pgConnInfoDbName(database)];
  let stderr: string;
  try {
    ({ stderr } = await execInPodWithStdin(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      login
        ? ['sh', '-c', `${PSQL_RESTRICT_PROBE}\nexec ${UNPRIVILEGED_SH} psql -X -U "$1" -d "$2"`, 'sh', login.username, pgConnInfoDbName(database)]
        : pgSuperuserCommand('psql', args),
      login ? restrictedPsqlInput(sql, newPsqlRestrictKey()) : sql,
    ));
  } catch (err) {
    if (err instanceof Error && err.message.includes(PSQL_TOO_OLD)) return { success: false, error: PSQL_TOO_OLD_MESSAGE };
    throw err;
  }
  if (stderr && stderr.includes('ERROR')) {
    return { success: false, error: stderr };
  }
  return { success: true };
}

// ─── Import SQL from PVC File ───────────────────────────────────────────────

/**
 * Validate a PVC-relative file path: no traversal, must be a .sql file, no absolute paths.
 */
const VALID_IMPORT_EXTENSIONS = ['.sql', '.sql.gz', '.gz', '.tar', '.tar.gz', '.tgz', '.zip', '.dump', '.backup'];

function validatePvcFilePath(filePath: string): void {
  if (!filePath || filePath.includes('..')) {
    throw new ApiError(
      'INVALID_PATH',
      'File path cannot be empty or contain ".." traversal',
      400,
      { filePath },
    );
  }
  const lower = filePath.toLowerCase();
  if (!VALID_IMPORT_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    throw new ApiError(
      'INVALID_FILE_TYPE',
      `Only ${VALID_IMPORT_EXTENSIONS.join(', ')} files are supported for import`,
      400,
      { filePath },
    );
  }
}

/**
 * Extract the full extension from a file path (e.g. ".sql.gz" from "dump.sql.gz").
 */
function getImportFileExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  // Check compound extensions first
  if (lower.endsWith('.sql.gz')) return '.sql.gz';
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  const lastDot = lower.lastIndexOf('.');
  return lastDot >= 0 ? lower.slice(lastDot) : '';
}

/**
 * Build the shell command to import a database dump file based on file extension and engine.
 *
 * @param engine - Database engine type
 * @param importPath - Absolute path to the import file inside the database pod
 * @param database - Target database name
 * @param rootPassword - Root password for database auth
 * @param useMysqlBinary - When true, use 'mysql' instead of 'mariadb' CLI binary
 */

/**
 * Import SQL from a file already on the shared PVC (uploaded via the file manager).
 * The route handler reads the file content from the file-manager pod and passes it here.
 * This bypasses the MAX_IMPORT_LENGTH check since the data is read server-side.
 */
/**
 * Import SQL from a file on the shared PVC.
 *
 * Architecture: Database pods mount the PVC with a subPath (e.g. databases/maria-52c5ef),
 * so they only see their own directory as their data root (e.g. /var/lib/mysql).
 * The file-manager pod mounts the full PVC at /data.
 *
 * Strategy: The backend copies the source file into the database's subPath directory
 * via the file-manager, then the database pod reads it from its own mount.
 */
export async function importSqlFromPvcFile(
  ctx: DbManagerContext,
  database: string,
  _sqlContent: string,
  filePath: string,
  deploymentSubPath: string,
  /**
   * `as`: import as this account (the tenant's administrator) — a tenant's
   * file. Without it, root: the platform's own restores, which keep every
   * DEFINER as it was dumped.
   */
  opts: { readonly as?: DbLogin } = {},
): Promise<ImportResult> {
  validateDatabaseName(database);
  validatePvcFilePath(filePath);

  // The file to import is at /data/<filePath> in the file-manager pod.
  // The database pod only sees /data/<deploymentSubPath>/ as its data root.
  // We need to reference the file relative to the database pod's mount.

  const dataRoot = ENGINE_CONFIG[ctx.engine].dataRoot;

  // The import file path inside the database pod:
  // File-manager path: /data/<filePath>
  // Database subPath: databases/<name>-<suffix>
  // If the file is inside the database's subPath, we can reference it directly.
  // Otherwise, we use a temp import path.
  const cleanFilePath = filePath.replace(/^\/+/, '');
  const cleanSubPath = deploymentSubPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const fileExt = getImportFileExtension(filePath);
  const importFileName = `_import_${Date.now()}${fileExt}`;
  const sqlFileName = `_import_${Date.now()}.sql`;

  // Held for the whole import, including the catch's temp-file cleanup —
  // released in the finally (file-manager/lease.ts).
  let fmLease: import('../file-manager/lease.js').FileManagerLease | null = null;
  try {
    // Ensure file-manager is running and get a ready pod name
    const { acquireFileManagerLease } = await import('../file-manager/lease.js');
    fmLease = await acquireFileManagerLease(ctx.k8s!, ctx.namespace, 'sql-import');
    const fmPodName = fmLease.podName;

    // Step 1: Extract/decompress archives in the file-manager pod (has tar, unzip, gunzip).
    // Database pods (especially MySQL 8) lack these tools.
    // Result: a plain .sql (or pg_restore-compatible) file in the database's subPath.
    const fmSrcPath = `/data/${cleanFilePath}`;
    const fmDestDir = `/data/${cleanSubPath}`;
    const fmSqlPath = `${fmDestDir}/${sqlFileName}`;
    const ext = getImportFileExtension(filePath);

    // For pg_restore formats, keep the original extension
    let isPgRestore = ctx.engine === 'postgresql' && ['.tar', '.dump', '.backup'].includes(ext);
    let dbImportFileName = isPgRestore ? importFileName : sqlFileName;
    const pgRestoreFileName = `_import_${Date.now()}.pgdump`;

    if (isPgRestore) {
      // PostgreSQL native format — copy as-is for pg_restore
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, `${fmDestDir}/${importFileName}`]);
    } else if (ext === '.sql') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, fmSqlPath]);
    } else if (ext === '.sql.gz' || ext === '.gz') {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `gunzip -c ${shellEscape(fmSrcPath)} > ${shellEscape(fmSqlPath)}`]);
    } else if (ext === '.tar.gz' || ext === '.tgz' || ext === '.tar' || ext === '.zip') {
      // Extract archive and detect content type.
      // PostgreSQL rules: .sql → psql, .tar/.dump/.backup → pg_restore
      // MariaDB/MySQL: only .sql files are supported
      const extractCmd = ext === '.zip'
        ? `unzip -o ${shellEscape(fmSrcPath)} -d /tmp/_imp > /dev/null`
        : ext === '.tar'
          ? `tar xf ${shellEscape(fmSrcPath)} -C /tmp/_imp`
          : `tar xzf ${shellEscape(fmSrcPath)} -C /tmp/_imp`;

      // Extract, then detect: SQL (has .sql files), PGDUMP (has .tar/.dump/.backup), or EMPTY
      const detectResult = await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c',
          `set -e; rm -rf /tmp/_imp; mkdir -p /tmp/_imp; ${extractCmd}\n` +
          `if [ "$(find /tmp/_imp -name '*.sql' -type f | wc -l)" -gt 0 ]; then\n` +
          `  find /tmp/_imp -name '*.sql' -type f -exec cat {} + > ${shellEscape(fmSqlPath)}\n` +
          `  echo SQL\n` +
          `elif [ "$(find /tmp/_imp \\( -name '*.tar' -o -name '*.dump' -o -name '*.backup' \\) -type f | wc -l)" -gt 0 ]; then\n` +
          `  f=$(find /tmp/_imp \\( -name '*.tar' -o -name '*.dump' -o -name '*.backup' \\) -type f | head -1)\n` +
          `  cp "$f" ${shellEscape(`${fmDestDir}/${pgRestoreFileName}`)}\n` +
          `  echo PGDUMP\n` +
          `elif [ "$(find /tmp/_imp -type f | wc -l)" -gt 0 ]; then\n` +
          `  f=$(find /tmp/_imp -type f | head -1)\n` +
          `  cp "$f" ${shellEscape(`${fmDestDir}/${pgRestoreFileName}`)}\n` +
          `  echo PGDUMP\n` +
          `else\n` +
          `  echo EMPTY\n` +
          `fi\n` +
          `rm -rf /tmp/_imp`,
        ]);

      const mode = detectResult.stdout.trim();
      if (mode === 'PGDUMP' && ctx.engine === 'postgresql') {
        isPgRestore = true;
        dbImportFileName = pgRestoreFileName;
      } else if (mode === 'PGDUMP') {
        // Non-PostgreSQL engine: the archive had no .sql files
        await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
          ['rm', '-f', `${fmDestDir}/${pgRestoreFileName}`]).catch(() => {});
        return { success: false, error: 'No SQL content found in the archive. Ensure the archive contains .sql files.' };
      } else if (mode === 'EMPTY') {
        return { success: false, error: 'The archive is empty.' };
      }
      // mode === 'SQL' → fmSqlPath has the concatenated SQL content
    } else {
      await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['cp', fmSrcPath, fmSqlPath]);
    }

    // Verify the extracted file has content (archives may contain no .sql files)
    if (!isPgRestore && ext !== '.sql') {
      const sizeResult = await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', `stat -c '%s' ${shellEscape(fmSqlPath)} 2>/dev/null || echo 0`]);
      const fileSize = parseInt(sizeResult.stdout.trim(), 10) || 0;
      if (fileSize === 0) {
        // Clean up empty file
        await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
          ['sh', '-c', `rm -f ${shellEscape(fmSqlPath)}`]).catch(() => {});
        return {
          success: false,
          error: 'No SQL content found in the archive. Ensure the archive contains .sql files.',
        };
      }
    }

    // Step 2: Import from the database pod's mount (only needs the database CLI)
    // A full-server dump would replace the server's own accounts (see
    // ./import-system-guard.ts). Scanned in place, so any file size works.
    const systemPattern = isPgRestore ? null : systemImportPattern(ctx.engine);
    if (systemPattern) {
      const scan = await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
        ['sh', '-c', grepScanCommand(shellEscape(systemPattern), shellEscape(fmSqlPath))]);
      if (scan.stdout.includes(GREP_FAILED)) {
        await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
          ['rm', '-f', fmSqlPath]).catch(() => {});
        return { success: false, error: 'The file could not be checked before import (it could not be read). Nothing was imported — upload it again and retry.' };
      }
      const hit = parseGrepHit(scan.stdout);
      if (hit) {
        await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
          ['rm', '-f', fmSqlPath]).catch(() => {});
        return { success: false, error: systemImportRefusal(ctx.engine, hit) };
      }
    }

    const importPath = `${dataRoot}/${dbImportFileName}`;
    let result: { stdout: string; stderr: string };

    if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
      // Use the correct CLI binary for the engine — mariadb containers have 'mariadb',
      // MySQL 8+ containers only have 'mysql'. Using sh -c with the wrong binary silently
      // fails because sh itself succeeds even when the inner command is not found.
      const dbCli = ctx.engine === 'mysql' ? 'mysql' : 'mariadb';
      const auth = mysqlAuthArgs(dbCli, ctx.rootPassword, opts.as).map(shellEscape).join(' ');
      // A tenant's file goes through the same rewrite as pasted SQL (import-rewrite.ts).
      const rewrite = opts.as ? ` | sed -E ${shellEscape(MYSQL_TENANT_IMPORT_SED)}` : '';
      // The file sits in the data directory, readable by root only: `cat`
      // reads it, the client runs unprivileged.
      const client = opts.as ? `${UNPRIVILEGED_SH} ${dbCli}` : dbCli;
      result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['sh', '-c', `cat ${shellEscape(importPath)}${rewrite} | ${client} ${auth} ${shellEscape(`--database=${database}`)}`]);
      // Clean up import file after import (best-effort)
      await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['rm', '-f', importPath]).catch(() => {});
    } else if (ctx.engine === 'postgresql') {
      if (isPgRestore) {
        // pg_restore exits 1 on non-fatal warnings (ownership, privileges) which is normal
        // in containerized environments. Only exit 2+ indicates fatal errors.
        // --no-owner --no-privileges avoids most warnings from dumps made on different servers.
        result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
          ['sh', '-c', `${PG_SAFE_ENV_SH} pg_restore -U ${opts.as ? shellEscape(opts.as.username) : PG_SUPERUSER_SH} --no-owner --no-privileges ${shellEscape(`--dbname=${pgConnInfoDbName(database)}`)} ${shellEscape(importPath)} 2>&1; rc=$?; if [ $rc -gt 1 ]; then exit $rc; fi`]);
      } else if (opts.as) {
        const key = newPsqlRestrictKey();
        try {
          result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
            ['sh', '-c',
              `${PSQL_RESTRICT_PROBE}\n` +
              `{ printf '%s\\n' ${shellEscape(`\\restrict ${key}`)}; sed -E ${shellEscape(PSQL_RESTRICT_LINE_SED)} ${shellEscape(importPath)}; } | ${UNPRIVILEGED_SH} psql -X -U "$1" -d "$2"`,
              'sh', opts.as.username, pgConnInfoDbName(database)]);
        } catch (err) {
          if (err instanceof Error && err.message.includes(PSQL_TOO_OLD)) {
            await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
              ['rm', '-f', importPath]).catch(() => {});
            return { success: false, error: PSQL_TOO_OLD_MESSAGE };
          }
          throw err;
        }
      } else {
        result = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
          ['sh', '-c', `${PG_SAFE_ENV_SH} cat ${shellEscape(importPath)} | psql -U ${PG_SUPERUSER_SH} -d ${shellEscape(pgConnInfoDbName(database))}`]);
      }
      await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['rm', '-f', importPath]).catch(() => {});
    } else {
      throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} file import not supported`, 400);
    }

    if (result.stderr && (result.stderr.includes('ERROR') || result.stderr.includes('error'))) {
      return { success: false, error: result.stderr };
    }

    // Post-import pod health check: wait and verify the pod is still healthy.
    // OOM kills can happen seconds after the import command returns (the DB processes
    // the SQL in the background). We wait 5 seconds to catch delayed crashes.
    if (ctx.k8s) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        const healthPods = await ctx.k8s.core.listNamespacedPod({
          namespace: ctx.namespace,
          labelSelector: `app=${ctx.podName.replace(/-[a-z0-9]+-[a-z0-9]+$/, '')}`,
        });
        type HealthPod = {
          // Pod-level shutdown markers: without them isReplacedPodRecord()
          // cannot fire and a reboot corpse reads as an import-time OOM.
          metadata?: { deletionTimestamp?: string };
          status?: {
            phase?: string;
            reason?: string;
            containerStatuses?: readonly {
              state?: { waiting?: { reason?: string } };
              lastState?: { terminated?: { reason?: string; exitCode?: number } };
            }[];
          };
        };
        const healthPodItems = (healthPods as { items?: readonly HealthPod[] }).items ?? [];
        for (const pod of healthPodItems) {
          // A dead pod record from a node reboot carries exit 137 in
          // lastState.terminated — attributing that to the SQL we just imported
          // would tell the tenant their import OOM-killed the database when it
          // did not. Only a live pod can testify about this import.
          if (isReplacedPodRecord({
            phase: pod.status?.phase,
            reason: pod.status?.reason,
            deletionTimestamp: pod.metadata?.deletionTimestamp,
          })) continue;
          for (const cs of pod.status?.containerStatuses ?? []) {
            const waitingReason = cs.state?.waiting?.reason;
            const restartCount = (cs as { restartCount?: number }).restartCount ?? 0;
            if (waitingReason === 'CrashLoopBackOff' || isOomTermination(cs.lastState?.terminated)) {
              return {
                success: false,
                error: 'Import caused the database to crash (Out of Memory). The database is restarting. Consider splitting the import into smaller files or increasing memory allocation.',
              };
            }
          }
        }
      } catch {
        // Health check failed — not critical, proceed with success
      }
    }

    return { success: true };
  } catch (err) {
    // Clean up temp import file via file-manager pod (best-effort)
    try {
      if (ctx.k8s) {
        const fmPods = await ctx.k8s.core.listNamespacedPod({ namespace: ctx.namespace, labelSelector: 'app=file-manager' });
        const fmPod = ((fmPods as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? []).find(p => p.status?.phase === 'Running');
        if (fmPod?.metadata?.name) {
          await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPod.metadata.name, 'file-manager',
            ['sh', '-c', `rm -f ${shellEscape(`/data/${cleanSubPath}/${importFileName}`)} ${shellEscape(`/data/${cleanSubPath}/${sqlFileName}`)}`]);
        }
      }
    } catch { /* cleanup is best-effort */ }

    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (messageIndicatesOom(message)) {
      return { success: false, error: 'Import failed: Out of Memory. The database ran out of memory while processing the SQL file. Try splitting the import into smaller files, or increase the deployment memory allocation.' };
    }
    if (message.includes('exit code')) {
      return { success: false, error: `Import failed: ${message}. Check the SQL file for syntax errors.` };
    }
    return { success: false, error: message };
  } finally {
    await fmLease?.release();
  }
}

/**
 * Restore a MongoDB `--archive --gzip` dump (produced by
 * {@link exportDatabaseToPvc}) from a file on the tenant PVC back into the
 * running MongoDB pod, via `mongorestore`.
 *
 * Mirrors {@link importSqlFromPvcFile}'s file-manager copy pattern: the
 * archive is copied from its PVC location (`/data/<filePath>` in the
 * file-manager) into the DB's OWN storage subPath (`/data/<deploymentSubPath>/`,
 * which maps to the mongo pod's data root), then referenced from inside the
 * mongo pod at `${dataRoot}/<tempname>` and streamed through mongorestore.
 *
 * `--drop` makes the restore idempotent (each collection is dropped before
 * re-insert). The archive carries its own namespaces (dumped with `--db`),
 * so we do NOT pass `--db` (mongorestore rejects `--db` with `--archive`).
 * A bring-your-own image lacking `mongorestore` yields a clear, non-throwing
 * failure the executor records per-database.
 */
export async function importMongoArchiveFromPvcFile(
  ctx: DbManagerContext,
  filePath: string,
  deploymentSubPath: string,
  /**
   * `as`: restore as this account (the tenant administrator), unprivileged in
   * the pod and never into admin/config/local — an archive is the tenant's
   * data, and one carrying admin.system.users would replace the accounts.
   */
  opts: { readonly as?: DbLogin } = {},
): Promise<ImportResult> {
  validatePvcFilePath(filePath);
  if (ctx.engine !== 'mongodb') {
    throw new ApiError('UNSUPPORTED_ENGINE', `mongo archive restore called for ${ctx.engine}`, 400);
  }
  const dataRoot = ENGINE_CONFIG.mongodb.dataRoot;
  const cleanFilePath = filePath.replace(/^\/+/, '');
  const cleanSubPath = deploymentSubPath.replace(/^\/+/, '').replace(/\/+$/, '');
  const tempName = `_import_${Date.now()}.archive.gz`;

  let fmLease: import('../file-manager/lease.js').FileManagerLease | null = null;
  try {
    const { acquireFileManagerLease } = await import('../file-manager/lease.js');
    fmLease = await acquireFileManagerLease(ctx.k8s!, ctx.namespace, 'mongo-import');
    const fmPodName = fmLease.podName;
    const fmSrcPath = `/data/${cleanFilePath}`;
    const fmDestPath = `/data/${cleanSubPath}/${tempName}`;
    // Copy the archive into the DB's own mount so the mongo pod can read it
    // at ${dataRoot}/${tempName} (the DB pod only sees its data root).
    await execInPod(ctx.kubeconfigPath, ctx.namespace, fmPodName, 'file-manager',
      ['cp', fmSrcPath, fmDestPath]);

    const inPodPath = `${dataRoot}/${tempName}`;
    let result: { stdout: string; stderr: string };
    try {
      if (opts.as) {
        // The archive is read by root (the data directory is the server's),
        // the restore runs as nobody, its password in a file only nobody reads
        // — the first stdin line, as a JSON (= YAML) string; never argv.
        const exclude = "--nsExclude='admin.*' --nsExclude='config.*' --nsExclude='local.*'";
        const script = 'set -e; d=$(mktemp -d); trap \'rm -rf "$d"\' EXIT; IFS= read -r line; umask 077; '
          + 'printf \'password: %s\\n\' "$line" > "$d/c.yaml"; chown -R nobody "$d"; '
          + `cat ${shellEscape(inPodPath)} | ${UNPRIVILEGED_SH} mongorestore --config="$d/c.yaml" -u ${shellEscape(opts.as.username)} `
          + `--authenticationDatabase admin ${exclude} --archive --gzip --drop`;
        result = await execInPodWithStdin(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
          ['sh', '-c', script], `${JSON.stringify(opts.as.password)}\n`);
      } else {
        // The password on stdin (the tool prompts for it), never in argv.
        const authArgs = ctx.rootPassword ? `-u ${shellEscape(ctx.rootUsername)} --authenticationDatabase admin` : '';
        const argv = ['sh', '-c', `mongorestore ${authArgs} --archive=${shellEscape(inPodPath)} --gzip --drop`];
        result = ctx.rootPassword
          ? await execInPodWithStdin(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv, `${ctx.rootPassword}\n`)
          : await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv);
      }
    } finally {
      // Best-effort cleanup of the temp copy inside the DB mount.
      await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
        ['rm', '-f', inPodPath]).catch(() => {});
    }
    // mongorestore reports "done" on success; a line containing "Failed" or
    // "error" (case-insensitive) signals a real failure.
    if (result.stderr && /\b(failed|error)\b/i.test(result.stderr) && !/0 document\(s\)/i.test(result.stderr)) {
      return { success: false, error: result.stderr };
    }
    return { success: true };
  } catch (err) {
    if (isBinaryNotFoundError(err)) {
      return { success: false, error: 'mongorestore is not available in this MongoDB container image; restore the raw files snapshot instead.' };
    }
    if (err instanceof ApiError) throw err;
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fmLease?.release();
  }
}

/**
 * Export a database dump to a file on the shared PVC.
 * Returns the PVC path where the file was written (relative to /data/).
 */
export async function exportDatabaseToPvc(
  ctx: DbManagerContext,
  database: string,
  outputFileName: string,
  deploymentSubPath: string,
  opts: { moveToExports?: boolean; pruneOlderThanDays?: number } = {},
): Promise<{ pvcPath: string; sizeBytes: number }> {
  validateDatabaseName(database);

  const dataRoot = ENGINE_CONFIG[ctx.engine].dataRoot;

  const exportPath = `${dataRoot}/${outputFileName}`;
  const cleanSubPath = deploymentSubPath.replace(/^\/+/, '').replace(/\/+$/, '');

  // Bound predump accumulation on the tenant PVC. Predumps land in the DB
  // pod's data dir and persist there (captured by the files snapshot). Without
  // pruning they grow unboundedly — one per database per bundle, forever —
  // eventually ENOSPC-ing the tenant volume. Prune predumps older than the
  // longest LIVE bundle's retention (an expired bundle's off-site snapshot is
  // already gone, so its live-PVC predump can never be restored). Best-effort;
  // `-maxdepth 1` avoids recursing into the engine's own data subdirs.
  if (opts.pruneOlderThanDays && opts.pruneOlderThanDays > 0) {
    await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['sh', '-c', `find ${dataRoot} -maxdepth 1 \\( -name 'predump-*.sql' -o -name 'predump-*.archive.gz' \\) -mtime +${opts.pruneOlderThanDays} -delete 2>/dev/null || true`],
    ).catch(() => { /* best-effort — accumulation bound, not correctness */ });
  }

  if (ctx.engine === 'mariadb' || ctx.engine === 'mysql') {
    const dumpCli = ctx.engine === 'mysql' ? 'mysqldump' : 'mariadb-dump';
    // `--single-transaction` takes the dump inside one consistent InnoDB
    // snapshot (MVCC) so it is point-in-time consistent WITHOUT locking the
    // tables — a hot backup with zero write-downtime for the tenant app.
    // `--quick` streams rows instead of buffering a whole table in RAM
    // (bounds the dump's memory on large tables). Both are the standard
    // consistent-hot-backup flags; the pre-existing flags stay.
    const { stderr } = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['sh', '-c', `${dumpCli} -u root -p${shellEscape(ctx.rootPassword)} --single-transaction --quick --routines --triggers -- ${shellEscape(database)} > ${shellEscape(exportPath)}`],
    );
    if (stderr && stderr.includes('ERROR')) throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  } else if (ctx.engine === 'postgresql') {
    // pg_dump already runs in a repeatable-read transaction → consistent
    // hot snapshot, no lock. No extra flag needed for consistency.
    const { stderr } = await execInPod(
      ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
      ['sh', '-c', `${PG_SAFE_ENV_SH} pg_dump -U ${PG_SUPERUSER_SH} ${shellEscape(`--dbname=${pgConnInfoDbName(database)}`)} > ${shellEscape(exportPath)}`],
    );
    if (stderr && stderr.includes('ERROR')) throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
  } else if (ctx.engine === 'mongodb') {
    // mongodump --archive writes a single self-contained gzip archive
    // (BSON) to the PVC. Per-collection consistency; the whole-DB archive
    // is captured by the files snapshot alongside the raw WiredTiger dir.
    // `mongodump` may be absent in a bring-your-own MongoDB image — surface
    // that as EXPORT_NOT_AVAILABLE so the caller can record a VISIBLE
    // degraded dump rather than a silent gap. (The files snapshot copies the
    // raw data directory too, but from the running server, so that copy is
    // not guaranteed to restore.)
    // The password on stdin (the tool prompts for it), never in argv.
    const authArgs = ctx.rootPassword ? `-u ${shellEscape(ctx.rootUsername)} --authenticationDatabase admin` : '';
    try {
      const argv = ['sh', '-c', `mongodump ${shellEscape(`--db=${database}`)} ${authArgs} --archive=${shellEscape(exportPath)} --gzip`];
      const { stderr } = ctx.rootPassword
        ? await execInPodWithStdin(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv, `${ctx.rootPassword}\n`)
        : await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName, argv);
      // mongodump writes progress to stderr; only a line containing "error"
      // (case-insensitive, mongodump's own convention) is a real failure.
      if (stderr && /\berror\b/i.test(stderr)) throw new ApiError('DB_EXPORT_ERROR', stderr, 500);
    } catch (err) {
      if (isBinaryNotFoundError(err)) {
        throw new ApiError(
          'EXPORT_NOT_AVAILABLE',
          'mongodump is not available in this MongoDB container image, so this database has no logical backup. The files snapshot copies its data files, but from the running server, so that copy is not guaranteed to restore.',
          400,
        );
      }
      throw err;
    }
  } else {
    throw new ApiError('UNSUPPORTED_ENGINE', `${ctx.engine} PVC export not supported`, 400);
  }

  // Get file size
  const { stdout: sizeOut } = await execInPod(
    ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
    ['stat', '-c', '%s', exportPath],
  );
  const sizeBytes = parseInt(sizeOut.trim(), 10) || 0;

  // Move the export from the database subPath to /data/exports/ via the
  // file-manager pod. SKIPPED for the pre-capture predump path
  // (moveToExports=false): the dump was written into the DB pod's OWN data dir
  // (exportPath) and is captured by the files snapshot IN PLACE — the restore
  // executor `find`s it there. Doing the move would (a) require the ON-DEMAND
  // file-manager pod to be running at capture time and (b) throw + poison the
  // dump status if it isn't, even though the dump itself succeeded (caught by
  // the multi-engine E2E on DEV). The interactive SQL-Manager export
  // (moveToExports defaults true) still moves the file to /exports for download.
  if (opts.moveToExports === false) {
    // In-place path (informational — the predump restore matches by filename).
    const inPlace = cleanSubPath ? `/${cleanSubPath}/${outputFileName}` : `/${outputFileName}`;
    return { pvcPath: inPlace, sizeBytes };
  }

  const { withFileManagerLease } = await import('../file-manager/lease.js');
  await withFileManagerLease(ctx.k8s!, ctx.namespace, 'sql-export', (exportFmPodName) => execInPod(
    ctx.kubeconfigPath, ctx.namespace, exportFmPodName, 'file-manager',
    ['sh', '-c', `mkdir -p /data/exports && mv ${shellEscape(`/data/${cleanSubPath}/${outputFileName}`)} ${shellEscape(`/data/exports/${outputFileName}`)}`],
  ));

  const pvcPath = `/exports/${outputFileName}`;
  return { pvcPath, sizeBytes };
}
