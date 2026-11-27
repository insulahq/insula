/**
 * Commands the platform runs as a tenant instance's administrator login, in
 * the instance's own pod — shared by db-admin-access.ts, tenant-admin.ts and
 * the *-hardening.ts modules.
 *
 * Secrets never go in argv: a tenant's MongoDB console query is JavaScript
 * running in the same pod (as `nobody`, db-manager.ts), and any process there
 * can read another's /proc/<pid>/cmdline. MongoDB passwords go on stdin.
 */

import { DbExecError, type DbManagerContext } from './db-manager.js';
import { PG_RECONCILER_SESSION_SH } from './pg-session.js';

/** Runs one command in the instance's pod — execInDbPod, or a stand-in in tests. `stdin` is written, then closed. */
export type DbCommandRunner = (
  ctx: DbManagerContext,
  argv: string[],
  stdin?: string,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** The runner for one call chain. */
export interface Exec { readonly ctx: DbManagerContext; readonly run: DbCommandRunner }

/** A command and what it reads on stdin. */
export interface Command { readonly argv: string[]; readonly stdin?: string }

type CommandLike = string[] | Command;

function toCommand(c: CommandLike): Command {
  return Array.isArray(c) ? { argv: c } : c;
}

/** The clients' own noise, never the reason something failed. */
export function withoutClientNoise(text: string): string {
  return text.split('\n')
    .filter((l) => !/Using a password on the command line interface can be insecure|^Enter password:/i.test(l.trim()))
    .join('\n').trim();
}

export interface RunResult { readonly ok: boolean; readonly stdout: string; readonly error: string }

/** Never throws: the clients exit 0 on some errors in batch mode and say so on stderr. */
export async function tryRun(x: Exec, c: CommandLike): Promise<RunResult> {
  const { argv, stdin } = toCommand(c);
  try {
    const { stdout, stderr } = await x.run(x.ctx, argv, stdin);
    if (/\bERROR\b/.test(stderr)) return { ok: false, stdout, error: withoutClientNoise(stderr) };
    return { ok: true, stdout, error: '' };
  } catch (err) {
    return { ok: false, stdout: '', error: withoutClientNoise(err instanceof Error ? err.message : String(err)) };
  }
}

/** stdout, or DbExecError with the client's error. */
export async function sh(x: Exec, c: CommandLike): Promise<string> {
  const r = await tryRun(x, c);
  if (!r.ok) throw new DbExecError(r.error);
  return r.stdout;
}

export async function works(x: Exec, c: CommandLike): Promise<boolean> {
  return (await tryRun(x, c)).ok;
}

/** Non-empty trimmed output lines. */
export function outputLines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// ─── Quoting ────────────────────────────────────────────────────────────────

/** SQL string literal for MariaDB/MySQL (backslash and quote escaped). */
export function mysqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function mysqlIdent(s: string): string {
  return `\`${s.replace(/`/g, '``')}\``;
}

/** The GRANT pattern matching exactly this database (`_` and `%` are wildcards there). */
export function grantPattern(db: string): string {
  return db.replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
}

export function pgIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function pgString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A name read back from the server as HEX(): a name may hold a newline or a
 * tab, which would split or shift a plain output row.
 */
export function fromHex(hex: string): string {
  if (!/^(?:[0-9A-Fa-f]{2})*$/.test(hex)) throw new DbExecError(`unexpected output from the database: ${hex.slice(0, 40)}`);
  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * A column selected as hex behind a sentinel: an EMPTY value (the anonymous
 * account's user name) would otherwise vanish when the output is trimmed and
 * shift every column after it.
 */
export function hexColumnSql(expr: string): string {
  return `CONCAT('x', HEX(${expr}))`;
}

/** Read one hexColumnSql column back. */
export function fromHexColumn(col: string | undefined): string {
  if (!col?.startsWith('x')) throw new DbExecError(`unexpected output from the database: ${(col ?? '').slice(0, 40)}`);
  return fromHex(col.slice(1));
}

/** Undo the mysql client's --batch escaping of one column (\n \t \0 \\). */
export function unescapeBatch(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c));
}

// ─── MariaDB / MySQL ────────────────────────────────────────────────────────

export function mysqlClient(ctx: DbManagerContext): string {
  return ctx.engine === 'mysql' ? 'mysql' : 'mariadb';
}

function mysqlRootArgs(ctx: DbManagerContext): string[] {
  return [
    // A socket-only root ignores the password; an app stack's root still needs it.
    mysqlClient(ctx), '-uroot', `-p${ctx.rootPassword || 'x'}`, '--protocol=socket', '--batch', '--skip-column-names',
    '--default-character-set=utf8mb4',
    // No client commands in what root reads (object definitions come from the
    // tenant's own objects); DELIMITER still works.
    '--binary-mode',
    // mysqlString() escapes with backslashes, which a global
    // NO_BACKSLASH_ESCAPES would turn into plain characters; and a tenant's
    // lock must not stall the pass over every other tenant.
    "--init-command=SET SESSION sql_mode = '', SESSION lock_wait_timeout = 30",
  ];
}

/** `user`@`host` — quoted as identifiers, which no sql_mode changes. A MariaDB role has no host. */
export function mysqlAccount(user: string, host: string | null): string {
  return host === null ? mysqlIdent(user) : `${mysqlIdent(user)}@${mysqlIdent(host)}`;
}

/** As root over the socket (db-admin-access.ts made that the platform's login). */
export function mysqlRoot(ctx: DbManagerContext, sql: string): string[] {
  return [...mysqlRootArgs(ctx), '-e', sql];
}

/** A longer script for root, on stdin (DELIMITER and all). */
export function mysqlRootScript(ctx: DbManagerContext, script: string): Command {
  return { argv: mysqlRootArgs(ctx), stdin: script };
}

/** The engines' own schemas: no tenant account reaches them. */
export const MYSQL_SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

// ─── PostgreSQL ─────────────────────────────────────────────────────────────

/** psql as the instance's superuser in a pinned session (pg-session.ts). */
export function pgSuperuser(ctx: DbManagerContext, sql: string, database = 'postgres'): string[] {
  // Always a conninfo string: a database name like `host=… options=…` is
  // otherwise read as one, and could point the platform's superuser elsewhere.
  return ['sh', '-c', PG_RECONCILER_SESSION_SH, 'sh', 'psql', '-X', '-U', ctx.rootUsername, '-d', pgDbConnInfo(database), '-v', 'ON_ERROR_STOP=1', '-qtAc', sql];
}

/** `dbname='…'` with libpq's quoting. */
export function pgDbConnInfo(database: string): string {
  return `dbname='${database.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ─── MongoDB ────────────────────────────────────────────────────────────────

/** mongosh as root, the password on stdin (`-p` with no value prompts for it). */
export function mongoRoot(ctx: DbManagerContext, js: string, extraStdin = ''): Command {
  return {
    argv: ['mongosh', '--quiet', '--norc', '-u', ctx.rootUsername, '-p', '--authenticationDatabase', 'admin', '--eval', js],
    stdin: `${ctx.rootPassword}\n${extraStdin}`,
  };
}

/**
 * Prints `ok` once logged in. Not `"ok"`: mongosh strips the quotes from an
 * --eval argument that is only a quoted string, and evaluates `ok`.
 */
export const MONGO_OK_JS = 'String("ok")';

/** The last line mongosh printed — what `--eval` returned. */
export function mongoResult(out: string): string {
  return out.trim().split('\n').pop() ?? '';
}
