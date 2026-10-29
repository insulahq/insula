const isMysqlFamily = (runtime: string | undefined): boolean => {
  const r = (runtime ?? '').toLowerCase();
  return r.includes('mariadb') || r.includes('mysql');
};

/**
 * Quote an identifier for the target database engine. MariaDB/MySQL use
 * backticks; PostgreSQL/SQLite use double quotes. An embedded quote character
 * is doubled — table and column names are whatever the tenant's schema holds
 * (`1-StudentsTb`, `order items`, a name with a backtick), not just
 * letters and underscores.
 */
export function quoteId(name: string, runtime: string | undefined): string {
  if (isMysqlFamily(runtime)) return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a value as an SQL string literal for the target engine.
 *
 * MariaDB/MySQL treat a backslash in a string literal as an escape
 * character, so `C:\new` written with only `'` doubled is stored as `C:`,
 * a newline and `ew`. The backslash is doubled there too. (A server running
 * with `NO_BACKSLASH_ESCAPES` would then store two; that mode is opt-in and
 * not the default of any engine the catalog ships.) PostgreSQL
 * (`standard_conforming_strings`, the default since 9.1) and SQLite take a
 * backslash literally, so only `'` is doubled.
 */
export function quoteSqlString(value: string, runtime: string | undefined): string {
  if (isMysqlFamily(runtime)) return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}
