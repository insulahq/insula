/**
 * Account and database names the platform reserves on a tenant database
 * instance (tenant-admin.ts, db-admin-access.ts). Shared by the SQL Manager,
 * which hides them from Database Users (the tenant administrator is shown in
 * its own card) and never changes them (db-manager.ts refuseReservedAccount).
 */

/** Databases a tenant may create in SQL itself (MariaDB/MySQL): this prefix. */
export const SELF_SERVICE_DB_PREFIX = 'db_';

/** The tenant administrator's preferred name, and the fallback when the tenant already has an account by that name. */
export const TENANT_ADMIN_USERNAMES = ['dbadmin', 'dbadmin_insula'] as const;

/** Every name above that is an account (Database Users never lists these). */
export const RESERVED_ACCOUNT_NAMES: readonly string[] = [...TENANT_ADMIN_USERNAMES, 'insula_socket_probe'];

/** A backup run's own login (backup-login.ts): never listed, never changed in Database Users. */
export const BACKUP_LOGIN_PREFIX = 'platform_bk_';

export function isBackupLoginPrefixed(name: string): boolean {
  return name.toLowerCase().startsWith(BACKUP_LOGIN_PREFIX);
}
