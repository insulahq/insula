import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSystemStatement, GREP_FAILED, grepScanCommand, parseGrepHit, systemImportPattern, systemImportRefusal,
} from './import-system-guard.js';

// Lines a full-server MariaDB/MySQL dump really contains.
const MYSQL_REFUSED = [
  'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `mysql` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
  'USE `mysql`;',
  'use mysql;',
  'DROP TABLE IF EXISTS `mysql`.`global_priv`;',
  'INSERT INTO `mysql`.`global_priv` VALUES (\'localhost\',\'root\',\'{}\');',
  'LOCK TABLES `mysql`.`db` WRITE;',
  'CREATE USER `bookstack`@`%` IDENTIFIED BY PASSWORD \'*0\';',
  'ALTER USER \'root\'@\'localhost\' IDENTIFIED BY \'x\';',
  'DROP USER IF EXISTS `app`@`%`;',
  'GRANT ALL PRIVILEGES ON `app`.* TO `app`@`%`;',
  'SET PASSWORD FOR \'root\'@\'localhost\' = PASSWORD(\'x\');',
  '  REVOKE ALL ON *.* FROM `app`@`%`;',
  // review: statements that do not start the line
  'SELECT 1; USE mysql;',
  '/*!50001 USE `mysql`*/;',
  '/*!50001 CREATE USER `x`@`%` */;',
  'SET @a = 1; INSERT INTO `mysql`.`global_priv` VALUES (1);',
  '\\u mysql',
  'USE `mysql`;\r',
];

// Lines an ordinary single-database dump contains — must pass.
const MYSQL_ALLOWED = [
  '-- Current Database: `mysql`',
  'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `bookstack` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
  'USE `bookstack`;',
  'USE `mysql_app`;',
  'DROP TABLE IF EXISTS `wp_options`;',
  'LOCK TABLES `wp_posts` WRITE;',
  'INSERT INTO `wp_posts` VALUES (1,\'USE mysql; GRANT ALL; host mysql.example.com, mysql.user\');',
  '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
  '/*!50013 DEFINER=`app`@`%` SQL SECURITY DEFINER */',
  'CREATE TABLE `granted_items` (`id` int);',
  'UPDATE `users` SET `password` = \'x\';',
  'INSERT INTO `posts` VALUES (2,\'Run this; GRANT ALL ON *.* TO admin; then reload\');',
  '\\u bookstack',
];

const PG_REFUSED = [
  'CREATE ROLE app;',
  'ALTER ROLE postgres WITH SUPERUSER LOGIN PASSWORD \'x\';',
  'DROP ROLE IF EXISTS app;',
  '\\connect other_db',
  '\\c template1',
];

const PG_ALLOWED = [
  'GRANT ALL ON SCHEMA public TO app;',
  'ALTER TABLE public.posts OWNER TO app;',
  'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
  'CREATE TABLE public.roles (id integer);',
  'COPY public.posts (id, body) FROM stdin;',
];

function grepAvailable(): boolean {
  try { execFileSync('grep', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('findSystemStatement', () => {
  it.each(MYSQL_REFUSED)('refuses (mariadb): %s', (line) => {
    expect(findSystemStatement(`-- dump\n${line}\n`, 'mariadb')).toEqual({ line: 2, text: line });
  });

  it.each(MYSQL_ALLOWED)('allows (mariadb): %s', (line) => {
    expect(findSystemStatement(line, 'mariadb')).toBeNull();
  });

  it.each(PG_REFUSED)('refuses (postgresql): %s', (line) => {
    expect(findSystemStatement(line, 'postgresql')).not.toBeNull();
  });

  it.each(PG_ALLOWED)('allows (postgresql): %s', (line) => {
    expect(findSystemStatement(line, 'postgresql')).toBeNull();
  });

  it('applies the MySQL rules to the mysql engine too, and none to mongodb', () => {
    expect(findSystemStatement('USE `mysql`;', 'mysql')).not.toBeNull();
    expect(systemImportPattern('mongodb')).toBeNull();
  });
});

describe.skipIf(!grepAvailable())('the same pattern under grep -E -i (as run in the file-manager pod)', () => {
  const q = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
  const scan = (engine: string, content: string | Buffer, mode?: number): string => {
    const dir = mkdtempSync(join(tmpdir(), 'import-guard-'));
    try {
      const file = join(dir, 'dump.sql');
      writeFileSync(file, content);
      if (mode !== undefined) chmodSync(file, mode);
      return execFileSync('sh', ['-c', grepScanCommand(q(systemImportPattern(engine) as string), q(file))]).toString();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const run = (engine: string, lines: readonly string[]): string => scan(engine, `${lines.join('\n')}\n`);

  it('scans a dump containing a NUL byte (a binary BLOB) instead of reporting "Binary file matches"', () => {
    const out = scan('mariadb', Buffer.concat([Buffer.from('INSERT INTO `t` VALUES (\''), Buffer.from([0]), Buffer.from('\');\nUSE `mysql`;\n')]));
    expect(parseGrepHit(out)?.line).toBe(2);
  });

  it.skipIf(process.getuid?.() === 0)('a file grep cannot read is reported, never read as clean', () => {
    expect(scan('mariadb', 'USE `mysql`;\n', 0o000)).toContain(GREP_FAILED);
  });

  it.each(MYSQL_REFUSED)('grep refuses: %s', (line) => {
    expect(parseGrepHit(run('mariadb', ['-- header', line]))).toEqual({ line: 2, text: line });
  });

  it('grep allows an ordinary single-database dump', () => {
    expect(run('mariadb', MYSQL_ALLOWED)).toBe('');
    expect(run('postgresql', PG_ALLOWED)).toBe('');
  });

  it.each(PG_REFUSED)('grep refuses (postgresql): %s', (line) => {
    expect(parseGrepHit(run('postgresql', [line]))?.line).toBe(1);
  });
});

describe('parseGrepHit / systemImportRefusal', () => {
  it('parses grep -n output and ignores empty output', () => {
    expect(parseGrepHit('12:USE `mysql`;\n')).toEqual({ line: 12, text: 'USE `mysql`;' });
    expect(parseGrepHit('')).toBeNull();
  });

  it('names the line, explains the damage and how to export instead, with a short excerpt', () => {
    const msg = systemImportRefusal('mariadb', { line: 7, text: `USE \`mysql\`; ${'x'.repeat(500)}` });
    expect(msg).toMatch(/line 7/);
    expect(msg).toMatch(/--all-databases/);
    expect(msg).toMatch(/Database Users/);
    expect(msg.length).toBeLessThan(500);
    expect(systemImportRefusal('postgresql', { line: 1, text: 'CREATE ROLE x;' })).toMatch(/pg_dumpall/);
  });
});
