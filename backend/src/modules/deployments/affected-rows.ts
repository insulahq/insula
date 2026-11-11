/**
 * How many rows a tenant's SQL statement wrote.
 *
 * The SQL panel runs statements through each engine's command-line client, and
 * a write prints nothing there: `mariadb --batch` and `sqlite3 -csv` print no
 * row for an UPDATE, and `psql` prints only a status line (`UPDATE 1`) that the
 * CSV parser took for a column header. The panel then reported the number of
 * result rows, so every UPDATE, INSERT and DELETE read "0 rows affected",
 * whether it changed one row or a thousand.
 *
 * Each statement is therefore followed by one more that asks the engine for
 * its own count (`ROW_COUNT()`, `changes()`, psql's `:ROW_COUNT`), printed
 * under a column name nothing else can share, and split off the output before
 * it is parsed.
 */
import { randomBytes } from 'node:crypto';

/** A column name no result of the tenant's own statement can share. */
export function affectedRowsMarker(): string {
  return `insula_affected_${randomBytes(8).toString('hex')}`;
}

/**
 * A client-side `DELIMITER` change would leave the `;` the follow-up statement
 * relies on meaning nothing, and turn a working script into a syntax error.
 */
const MYSQL_DELIMITER_COMMAND = /^\s*delimiter\s/im;

/**
 * `query`, then the MariaDB/MySQL statement that prints its row count.
 *
 * The newline before the `;` ends a trailing `-- comment`, which would
 * otherwise swallow the follow-up; a `;` the query already ends with just makes
 * an empty statement, which both clients skip. ROW_COUNT() is the rows the last
 * statement CHANGED (not matched), and -1 after a statement that returned rows.
 */
export function withMysqlRowCount(query: string, marker: string): string {
  if (MYSQL_DELIMITER_COMMAND.test(query)) return query;
  return `${query}\n;\nSELECT ROW_COUNT() AS \`${marker}\``;
}

/**
 * `query`, then the SQLite statement that prints its row count. A dot-command
 * (`.tables`) takes the whole argument as its own, so it is left alone.
 *
 * SQLite has no "this returned rows" answer like MariaDB's -1, and an empty
 * result set prints no header, so an empty SELECT would read as "0 rows
 * affected". The count is therefore given only when this run wrote anything at
 * all (`total_changes()` counts from 0 in each fresh sqlite3 process); -1
 * otherwise, which reports no count. An UPDATE that matched nothing loses its
 * 0, which is true either way.
 */
export function withSqliteRowCount(query: string, marker: string): string {
  if (query.trimStart().startsWith('.')) return query;
  return `${query}\n;\nSELECT CASE WHEN total_changes() > 0 THEN changes() ELSE -1 END AS "${marker}"`;
}

/** The psql command that prints `<marker> <count>` after the query has run. */
export function psqlRowCountCommand(marker: string): string {
  return `\\echo ${marker} :ROW_COUNT`;
}

export interface MarkerSplit {
  /** The output of the tenant's own statement, without the count. */
  readonly output: string;
  /** The count the engine reported, or null when it printed none. */
  readonly count: number | null;
}

/**
 * Split the count off the END of `output`. `separator` is what sits between
 * the marker and the number: a line break where the count is a one-row result
 * set (`mariadb --batch`; `sqlite3 -csv`, which ends its lines with `\r\n`), a
 * space where psql `\echo`ed it.
 *
 * Only a marker at the start of a line counts. When there is none — the
 * engine stopped at an error first, or the query was left unchanged — the
 * output is returned whole.
 */
export function splitRowCount(output: string, marker: string, separator: '\n' | ' '): MarkerSplit {
  const at = output.lastIndexOf(marker);
  const after = output.slice(at + marker.length);
  const separated = separator === ' ' ? after.startsWith(' ') : /^\r?\n/.test(after);
  if (at === -1 || !separated || (at > 0 && output[at - 1] !== '\n')) return { output, count: null };
  const value = after.trim();
  return {
    output: output.slice(0, at),
    count: /^-?\d+$/.test(value) ? Number(value) : null,
  };
}

/**
 * `{ affectedRows }` for a statement that returned no result set and whose
 * count the engine reported, `{}` otherwise. A negative count means "not a
 * write": MariaDB's answer after a statement that returned rows (an empty
 * result set prints no header, so it is the only way to tell an empty SELECT
 * from a write), and the SQLite follow-up's when nothing was written.
 *
 * Every engine counts the LAST statement only; the panel says so when the
 * query held more than one.
 */
export function affectedRowsField(columns: readonly string[], count: number | null): { affectedRows?: number } {
  if (columns.length > 0 || count === null || count < 0) return {};
  return { affectedRows: count };
}
