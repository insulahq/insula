import { describe, it, expect } from 'vitest';
import { mysqlCreateDatabaseSql, APP_COMPATIBLE_MYSQL_COLLATION } from './db-manager.js';

describe('mysqlCreateDatabaseSql', () => {
  // A bare CREATE DATABASE inherits the server default. On MariaDB 11.4+ that
  // is utf8mb4_uca1400_ai_ci, which `SHOW COLLATION WHERE Collation=… AND
  // Charset=…` does not return — and that query is exactly how Moodle (and
  // others) verify a database is Unicode. Reproduced on DEV against
  // mariadb:12.3: the Moodle installer aborted with "unicode must be installed
  // and enabled" on a database the platform had just created.
  it('pins the charset and collation instead of inheriting the server default', () => {
    const sql = mysqlCreateDatabaseSql('moodle_a');
    expect(sql).toContain('CHARACTER SET utf8mb4');
    expect(sql).toContain(`COLLATE ${APP_COMPATIBLE_MYSQL_COLLATION}`);
  });

  it('uses a collation SHOW COLLATION reports on every supported server', () => {
    // utf8mb4_unicode_ci is present in MySQL 5.7+ and every MariaDB; the
    // UCA-1400 names are not, which is the whole bug.
    expect(APP_COMPATIBLE_MYSQL_COLLATION).toBe('utf8mb4_unicode_ci');
    expect(APP_COMPATIBLE_MYSQL_COLLATION).not.toContain('uca1400');
  });

  it('stays idempotent and keeps the name quoted', () => {
    const sql = mysqlCreateDatabaseSql('tenant_db');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('`tenant_db`');
  });
});
