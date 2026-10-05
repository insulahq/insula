/**
 * Refuse SQL imports that would rewrite the database server's own accounts.
 *
 * A full-server dump (`mysqldump --all-databases`, `mariadb-dump -A`) carries
 * the `mysql` system schema. Importing it drops and recreates `mysql.global_priv`
 * and friends from the SOURCE server: the platform's root and healthcheck
 * passwords change and every user the platform created disappears. MariaDB keeps
 * serving the old accounts from memory until the next restart or FLUSH
 * PRIVILEGES, so the import "succeeds" and the damage lands later — every app on
 * the server loses its database login at once and the pod fails its health check.
 *
 * Account statements (CREATE/ALTER/DROP USER, GRANT, SET PASSWORD, …) in a dump
 * bypass Database Users the same way, so they are refused too. Ordinary
 * single-database dumps never contain any of these at the start of a line.
 *
 * The patterns are written in the subset shared by POSIX ERE (`grep -E -i`, run
 * in the file-manager pod against files of any size) and JavaScript RegExp (the
 * inline import): no `\s`, no `\b`, no POSIX classes.
 */

export type ImportEngine = 'mariadb' | 'mysql' | 'postgresql' | 'mongodb' | string;

const WS = '[ \\t]';
const END = '([^A-Za-z0-9_$]|$)';
const MYSQL_SCHEMA = '`?mysql`?';

// Where a statement can start: a line start or after a `;` on the same line,
// optionally inside a version comment (`/*!50001 USE mysql*/`), which the
// server executes. Account statements are matched only at a line start (or in
// a version comment): after a `;` they turn up in ordinary INSERT data — a
// blog post about SQL — and refusing those dumps would be a false alarm.
const STMT_START = `(^|;)${WS}*(/\\*![0-9]*${WS}*)?`;
const LINE_START = `^${WS}*(/\\*![0-9]*${WS}*)?`;

const MYSQL_PATTERNS: readonly string[] = [
  // USE `mysql`;   and the client shorthand \u mysql
  `${STMT_START}USE${WS}+${MYSQL_SCHEMA}${WS}*(;|\\*/|$)`,
  `^${WS}*\\\\u${WS}+${MYSQL_SCHEMA}${END}`,
  // CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql`
  `${STMT_START}CREATE${WS}+(DATABASE|SCHEMA)${WS}+(/\\*![0-9]+${WS}+IF${WS}+NOT${WS}+EXISTS${WS}*\\*/${WS}*|IF${WS}+NOT${WS}+EXISTS${WS}+)?${MYSQL_SCHEMA}${END}`,
  // INSERT INTO `mysql`.`global_priv` …, DROP TABLE mysql.user, …
  `${STMT_START}(INSERT${WS}+(IGNORE${WS}+)?INTO|REPLACE${WS}+INTO|UPDATE|DELETE${WS}+FROM|DROP${WS}+TABLE(${WS}+IF${WS}+EXISTS)?|CREATE${WS}+TABLE(${WS}+IF${WS}+NOT${WS}+EXISTS)?|ALTER${WS}+TABLE|TRUNCATE(${WS}+TABLE)?|LOCK${WS}+TABLES)${WS}+${MYSQL_SCHEMA}${WS}*\\.`,
  // Account management
  `${LINE_START}((CREATE|ALTER|DROP|RENAME)${WS}+(USER|ROLE)|SET${WS}+PASSWORD|SET${WS}+DEFAULT${WS}+ROLE|GRANT|REVOKE)${END}`,
];

const POSTGRES_PATTERNS: readonly string[] = [
  // pg_dumpall role section
  `^${WS}*(CREATE|ALTER|DROP)${WS}+(ROLE|USER)${END}`,
  // switching to another database mid-file
  '^\\\\c(onnect)?[ \\t]',
];

/** One ERE alternation for `grep -E -i`, or null when the engine has no guard. */
export function systemImportPattern(engine: ImportEngine): string | null {
  const parts = engine === 'mariadb' || engine === 'mysql'
    ? MYSQL_PATTERNS
    : engine === 'postgresql' ? POSTGRES_PATTERNS : null;
  return parts ? parts.map((p) => `(${p})`).join('|') : null;
}

export interface SystemStatementHit {
  readonly line: number;
  readonly text: string;
}

/** First line of `sql` that the guard refuses, or null. */
export function findSystemStatement(sql: string, engine: ImportEngine): SystemStatementHit | null {
  const pattern = systemImportPattern(engine);
  if (!pattern) return null;
  const re = new RegExp(pattern, 'i');
  const lines = sql.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) return { line: i + 1, text: lines[i] };
  }
  return null;
}

/** Marker the scan prints when grep itself failed (exit > 1). */
export const GREP_FAILED = '__IMPORT_SCAN_FAILED__';

/**
 * The in-pod scan. `-a`: a dump with a NUL byte (a binary BLOB) would
 * otherwise print only "Binary file matches" and pass. A grep error (exit 2,
 * e.g. unreadable file) is reported, never read as "nothing found".
 */
export function grepScanCommand(quotedPattern: string, quotedFile: string): string {
  return `grep -a -n -m1 -i -E ${quotedPattern} ${quotedFile}; rc=$?; [ "$rc" -le 1 ] || echo ${GREP_FAILED}`;
}

/** Parse `grep -n -m1` output (`<line>:<text>`) into a hit. */
export function parseGrepHit(stdout: string): SystemStatementHit | null {
  const first = stdout.split('\n').find((l) => l.length > 0);
  if (!first) return null;
  const sep = first.indexOf(':');
  const line = Number(first.slice(0, sep));
  if (sep < 1 || !Number.isInteger(line)) return null;
  return { line, text: first.slice(sep + 1) };
}

/** The operator-facing refusal. Never echoes more than a short excerpt of the line. */
export function systemImportRefusal(engine: ImportEngine, hit: SystemStatementHit): string {
  const excerpt = hit.text.trim().slice(0, 80);
  const isMysql = engine === 'mariadb' || engine === 'mysql';
  const how = isMysql
    ? 'Export only your application database (for example `mariadb-dump --databases <name>` or `mysqldump <name>`), not `--all-databases`'
    : 'Export only your application database with `pg_dump <name>`, not `pg_dumpall`';
  return (
    `Import refused: line ${hit.line} (\`${excerpt}\`) changes database accounts or the server's system schema. ` +
    'Importing it would replace the server\'s user accounts — the platform and your apps would lose their logins. ' +
    `${how}, and manage users under Database Users.`
  );
}
