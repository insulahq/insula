/**
 * Rewrite a MariaDB/MySQL dump so the tenant's administrator can load it.
 *
 * Tenant imports run as the tenant administrator, not root (tenant-admin.ts).
 * Dumps made elsewhere — a Plesk or cPanel export, another host — carry two
 * kinds of statement that account may not run:
 *   - `DEFINER=`user`@`host`` on views, triggers, routines and events. Naming
 *     any definer but yourself needs SET USER (MariaDB) / SET_USER_ID (MySQL),
 *     which a tenant account must not have: it would let it create code that
 *     runs as root. The clause is removed, so the object's definer is the
 *     importing account — the tenant's own.
 *   - `SET @@SESSION.SQL_LOG_BIN` and `SET @@GLOBAL.GTID_PURGED` (also written
 *     `SET [SESSION|GLOBAL] sql_log_bin = …`), which MySQL dumps of a GTID
 *     server write and which need administrative privileges.
 *     They are dropped: they steer replication, not the data.
 * The same rules exist twice — as a JavaScript rewrite for SQL pasted into the
 * panel and as a sed program for a file imported from the volume — and a test
 * runs both over the same fixtures.
 *
 * A DEFINER clause inside string data (a blog post about SQL) is rewritten
 * too; that is the price of a line-level rewrite and rare in practice.
 */

/** `user` or `host`: quoted any way MySQL accepts, or bare. */
const QUOTED = '`[^`]*`|\'[^\']*\'|"[^"]*"';
const DEFINER_JS = new RegExp(`DEFINER\\s*=\\s*(${QUOTED}|[A-Za-z0-9_.$-]+)@(${QUOTED}|[A-Za-z0-9_.%:-]+)`, 'gi');
const ADMIN_SET_JS = /^[ \t]*SET[ \t]+(?:@@(?:SESSION|GLOBAL)\.|(?:SESSION|GLOBAL)[ \t]+)?(SQL_LOG_BIN|GTID_PURGED)\b.*$/gim;

/** The rewrite, for SQL held in memory. */
export function rewriteMysqlDumpForTenant(sql: string): string {
  return sql.replace(ADMIN_SET_JS, '').replace(DEFINER_JS, '');
}

/**
 * The same rewrite as a `sed -E` program (GNU sed — the MariaDB and MySQL
 * images ship it). Pass it as ONE argument: `sed -E "$PROGRAM"`.
 */
export const MYSQL_TENANT_IMPORT_SED = [
  '/^[ \\t]*[Ss][Ee][Tt][ \\t]+(@@([Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Gg][Ll][Oo][Bb][Aa][Ll])\\.|([Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Gg][Ll][Oo][Bb][Aa][Ll])[ \\t]+)?([Ss][Qq][Ll]_[Ll][Oo][Gg]_[Bb][Ii][Nn]|[Gg][Tt][Ii][Dd]_[Pp][Uu][Rr][Gg][Ee][Dd])\\b/s/.*//',
  's/[Dd][Ee][Ff][Ii][Nn][Ee][Rr][[:space:]]*=[[:space:]]*(`[^`]*`|\'[^\']*\'|"[^"]*"|[A-Za-z0-9_.$-]+)@(`[^`]*`|\'[^\']*\'|"[^"]*"|[A-Za-z0-9_.%:-]+)//g',
].join(';');
