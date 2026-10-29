/**
 * Quote an identifier for the target database engine. MariaDB/MySQL use
 * backticks; PostgreSQL/SQLite use double quotes. An embedded quote character
 * is doubled — table and column names are whatever the tenant's schema holds
 * (`1-StudentsTb`, `order items`, a name with a backtick), not just
 * letters and underscores.
 */
export function quoteId(name: string, runtime: string | undefined): string {
  const r = (runtime ?? '').toLowerCase();
  if (r.includes('mariadb') || r.includes('mysql')) return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}
