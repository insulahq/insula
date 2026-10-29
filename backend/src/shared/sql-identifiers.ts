/**
 * Names of things that already exist in a tenant's database — tables,
 * collections, columns — as the SQL Manager reads them back and asks for them.
 *
 * Every engine accepts almost any character inside a quoted identifier:
 * `1-StudentsTb`, `order items`, `Größe`, `fs.files`. A name the engine
 * already holds is valid by definition, so these paths must NOT be judged by
 * the CREATE-time charset (letters, digits, underscore): that rejected every
 * table of an imported schema whose names start with a digit or contain a
 * hyphen, and the panel rendered the 400 as an empty table.
 *
 * Safety comes from quoting each name for its engine, not from narrowing the
 * charset. The commands run as argv (no shell), and the tenant can already run
 * any SQL as root through the query tab, so the quoting is about addressing
 * the right object, not about a privilege boundary.
 */

import { ApiError } from './errors.js';

/**
 * Generous upper bound: MariaDB/MySQL cap names at 64 characters and
 * PostgreSQL at 63 bytes, MongoDB namespaces at 255 bytes. Anything longer
 * cannot exist, so fail fast instead of shipping it to the engine.
 */
export const MAX_EXISTING_NAME_LENGTH = 255;

/** Database names: MariaDB/MySQL and MongoDB cap them at 64, PostgreSQL at 63 bytes. */
export const MAX_EXISTING_DATABASE_NAME_LENGTH = 64;

export type ExistingNameKind = 'database' | 'table' | 'column';

const INVALID_NAME_CODE: Record<ExistingNameKind, string> = {
  database: 'INVALID_DATABASE_NAME',
  table: 'INVALID_TABLE_NAME',
  column: 'INVALID_COLUMN_NAME',
};

/**
 * Reject only what no engine can hold: a non-string (a repeated query
 * parameter arrives as an array), an empty name, a NUL, or an absurd length.
 *
 * A database name also reaches command lines (dump, restore, psql). Those
 * paths must pass it so that it can never read as an option or a connection
 * string — `--` before a positional name, `--db=`/`--database=` forms, and
 * {@link pgConnInfoDbName} for libpq — rather than restricting the name.
 */
export function validateExistingName(value: unknown, kind: ExistingNameKind): asserts value is string {
  const max = kind === 'database' ? MAX_EXISTING_DATABASE_NAME_LENGTH : MAX_EXISTING_NAME_LENGTH;
  const valid = typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !value.includes('\0');
  if (!valid) {
    throw new ApiError(
      INVALID_NAME_CODE[kind],
      `Invalid ${kind} name: must be 1-${max} characters and contain no NUL character`,
      400,
      { [kind]: typeof value === 'string' ? value : String(value) },
    );
  }
}

/**
 * A libpq connection string that selects exactly this database. psql,
 * pg_dump and pg_restore treat a `-d`/`--dbname` value containing `=` (or a
 * `postgres://` prefix) as a whole connection string, so a database named
 * `host=elsewhere` would redirect the connection. Quoting the name as
 * `dbname='…'` (backslash-escaping `\` and `'`) makes every name literal.
 */
export function pgConnInfoDbName(database: string): string {
  return `dbname='${database.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** MariaDB/MySQL identifier: backticks, an embedded backtick doubled. */
export function quoteMysqlIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/** PostgreSQL/SQLite (SQL standard) identifier: double quotes, an embedded quote doubled. */
export function quoteAnsiIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/**
 * PostgreSQL string literal. `standard_conforming_strings` is on by default
 * (PostgreSQL 9.1+), so a backslash is literal and only `'` needs doubling.
 */
export function quotePgStringLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/**
 * Undo the escaping the `mariadb`/`mysql` client applies to DATA cells in
 * `--batch` output: `\\`, `\t`, `\n` and `\0`. Names read as data (SHOW
 * TABLES, information_schema, DESCRIBE) must be unescaped before they are
 * quoted back into a query, or `back\slash` comes back as `back\\slash` and
 * the table can never be opened. Header rows are printed raw — do not apply
 * this to column headers.
 */
export function unescapeMysqlBatchField(field: string): string {
  return field.replace(/\\([\\tn0])/g, (_match, ch: string) => {
    if (ch === 't') return '\t';
    if (ch === 'n') return '\n';
    if (ch === '0') return '\0';
    return '\\';
  });
}
