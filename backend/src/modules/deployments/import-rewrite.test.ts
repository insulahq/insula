import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MYSQL_TENANT_IMPORT_SED, rewriteMysqlDumpForTenant } from './import-rewrite.js';

/** The lines a Plesk/cPanel/mysqldump export carries that a tenant account may not run. */
const DUMP = [
  '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
  "SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;",
  'SET @@SESSION.SQL_LOG_BIN= 0;',
  "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5';",
  'CREATE TABLE `t` (`i` int);',
  '/*!50001 CREATE ALGORITHM=UNDEFINED */',
  '/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */',
  '/*!50001 VIEW `v` AS select 1 */;',
  '/*!50003 CREATE*/ /*!50017 DEFINER=`app`@`%`*/ /*!50003 TRIGGER `tr` BEFORE INSERT ON `t` FOR EACH ROW SET NEW.i = 1 */;;',
  "CREATE DEFINER='root'@'127.0.0.1' PROCEDURE `p`() SELECT 1;",
  '/*!50106 CREATE*/ /*!50117 DEFINER=root@localhost*/ /*!50106 EVENT `e` ON SCHEDULE EVERY 1 DAY DO SELECT 1 */ ;;',
  'CREATE DEFINER = `x`@`::1` FUNCTION `f`() RETURNS int RETURN 1;',
  'CREATE DEFINER=CURRENT_USER PROCEDURE `q`() SELECT 1;',
  'SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;',
  'SET sql_log_bin = 0;',
  'SET SESSION sql_log_bin=0;',
  'set global sql_log_bin = 1;',
  '  SET   Session   SQL_LOG_BIN = 0;',
  'SET @@global.gtid_purged = 1;',
  'SET GLOBAL GTID_PURGED=\'abc:1-5\';',
  'SET sql_log_bin_backup = 1;',
  'SET @sql_log_bin = 1;',
  'SET @@SESSION.SQL_MODE = 0;',
  'SET sql_mode = 1;',
  "INSERT INTO `t` VALUES (1);",
].join('\n');

describe('rewriteMysqlDumpForTenant', () => {
  const out = rewriteMysqlDumpForTenant(DUMP);

  it('removes every user@host DEFINER, so the importing account is the definer', () => {
    expect(out).not.toMatch(/DEFINER\s*=\s*[`'"]?[A-Za-z0-9_.$-]+[`'"]?@/i);
    expect(out).toContain('/*!50013  SQL SECURITY DEFINER */');
    expect(out).toContain("CREATE  PROCEDURE `p`() SELECT 1;");
    expect(out).toContain('CREATE  FUNCTION `f`() RETURNS int RETURN 1;');
  });

  it('keeps DEFINER=CURRENT_USER (it is the importer already)', () => {
    expect(out).toContain('CREATE DEFINER=CURRENT_USER PROCEDURE `q`() SELECT 1;');
  });

  it('drops the replication SETs and nothing else', () => {
    expect(out).not.toMatch(/SET @@(SESSION|GLOBAL)\.(SQL_LOG_BIN|GTID_PURGED)/i);
    expect(out).not.toMatch(/^[ \t]*SET[ \t]+(SESSION|GLOBAL)?[ \t]*(SQL_LOG_BIN|GTID_PURGED)\b/im);
    expect(out).toContain('SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;');
    expect(out).toContain('INSERT INTO `t` VALUES (1);');
    // lookalikes that steer nothing stay
    for (const kept of ['SET sql_log_bin_backup = 1;', 'SET @sql_log_bin = 1;', 'SET @@SESSION.SQL_MODE = 0;', 'SET sql_mode = 1;']) expect(out).toContain(kept);
    expect(out.split('\n')).toHaveLength(DUMP.split('\n').length);
  });
});

describe('rewriteMysqlDumpForTenant — one statement at a time', () => {
  it.each([
    ['SET sql_log_bin = 0;', ''],
    ['SET SESSION sql_log_bin=0;', ''],
    ['set global sql_log_bin = 1;', ''],
    ['SET @@session.sql_log_bin = 0;', ''],
    ['SET GLOBAL gtid_purged = \'x\';', ''],
    ['SET sql_log_bin_backup = 1;', 'SET sql_log_bin_backup = 1;'],
    ['SELECT 1; -- SET sql_log_bin = 0', 'SELECT 1; -- SET sql_log_bin = 0'],
    ['CREATE DEFINER=`a`@`b` VIEW v AS SELECT 1;', 'CREATE  VIEW v AS SELECT 1;'],
    ['CREATE DEFINER="a b"@"h" PROCEDURE p() SELECT 1;', 'CREATE  PROCEDURE p() SELECT 1;'],
    ['CREATE DEFINER=`a`@`10.0.%` PROCEDURE p() SELECT 1;', 'CREATE  PROCEDURE p() SELECT 1;'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(rewriteMysqlDumpForTenant(input)).toBe(expected);
  });
});

describe('MYSQL_TENANT_IMPORT_SED — the same rewrite for a file', () => {
  const sed = spawnSync('sed', ['--version'], { encoding: 'utf8' });
  const gnu = sed.status === 0 && /GNU sed/.test(sed.stdout);

  it.runIf(gnu)('produces exactly what the JavaScript rewrite produces', () => {
    const r = spawnSync('sed', ['-E', MYSQL_TENANT_IMPORT_SED], { input: DUMP, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.replace(/\n$/, '')).toBe(rewriteMysqlDumpForTenant(DUMP));
  });

  it('is one sed program with both rules', () => {
    expect(MYSQL_TENANT_IMPORT_SED.split(';')).toHaveLength(2);
  });
});
