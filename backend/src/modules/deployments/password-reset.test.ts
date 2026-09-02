import { describe, it, expect } from 'vitest';
import { buildPasswordResetInitContainer, findAdminPasswordEnvVar } from './password-reset.js';

describe('buildPasswordResetInitContainer', () => {
  const baseArgs = {
    storagePath: 'database/mariadb/my-db',
    volumeMountName: 'tenant-storage',
  };

  describe('MariaDB', () => {
    it('returns init container for mariadb with correct image and ALTER USER', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('reset-root-password');
      expect(result!.image).toBe('mariadb:11');
      expect(result!.command[0]).toBe('sh');
      expect(result!.command[2]).toContain('mariadbd');
      expect(result!.command[2]).toContain('--skip-networking');
      expect(result!.command[2]).toContain('--skip-grant-tables');
      expect(result!.command[2]).toContain('ALTER USER');
      expect(result!.command[2]).toContain('MARIADB_ROOT_PASSWORD');
    });

    it('mounts the PVC at the correct path', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      const mount = result!.volumeMounts.find((m: { mountPath: string }) => m.mountPath === '/var/lib/mysql');
      expect(mount).toBeDefined();
      expect(mount!.subPath).toBe('database/mariadb/my-db');
    });

    it('skips if data directory marker is absent', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      });

      expect(result!.command[2]).toContain('if [ ! -d');
    });
  });

  describe('MySQL', () => {
    it('returns init container for mysql with mysqld --skip-grant-tables', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mysql/my-db',
        catalogCode: 'mysql',
        image: 'mysql:8.4',
        passwordEnvVar: 'MYSQL_ROOT_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('mysql:8.4');
      expect(result!.command[2]).toContain('mysqld');
      expect(result!.command[2]).toContain('--skip-networking');
      expect(result!.command[2]).toContain('--skip-grant-tables');
      expect(result!.command[2]).toContain('MYSQL_ROOT_PASSWORD');
    });
  });

  describe('PostgreSQL', () => {
    it('returns init container for postgresql with pg_hba.conf trust method', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/postgresql/my-db',
        catalogCode: 'postgresql',
        image: 'postgres:18',
        passwordEnvVar: 'POSTGRES_PASSWORD',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('postgres:18');
      expect(result!.command[2]).toContain('pg_hba.conf');
      expect(result!.command[2]).toContain('trust');
      expect(result!.command[2]).toContain('ALTER USER');
      expect(result!.command[2]).toContain('pg_ctl');
    });

    it('detects existing data via PG_VERSION file', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/postgresql/my-db',
        catalogCode: 'postgresql',
        image: 'postgres:18',
        passwordEnvVar: 'POSTGRES_PASSWORD',
      });

      expect(result!.command[2]).toContain('PG_VERSION');
    });
  });

  describe('MongoDB', () => {
    it('returns init container for mongodb with no-auth mode', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mongodb-7/my-db',
        catalogCode: 'mongodb-7',
        image: 'mongo:7',
        passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD',
        passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME',
      });

      expect(result).not.toBeNull();
      expect(result!.image).toBe('mongo:7');
      expect(result!.command[2]).toContain('mongod');
      expect(result!.command[2]).toContain('--bind_ip 127.0.0.1');
      expect(result!.command[2]).toContain('createUser');
    });

    it('detects existing data via WiredTiger file', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        storagePath: 'database/mongodb-7/my-db',
        catalogCode: 'mongodb-7',
        image: 'mongo:7',
        passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD',
        passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME',
      });

      expect(result!.command[2]).toContain('WiredTiger');
    });
  });

  describe('non-database entries', () => {
    it('returns null for non-database catalog codes', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'nginx-php',
        image: 'nginx:latest',
        passwordEnvVar: '',
      });

      expect(result).toBeNull();
    });

    it('returns null for empty passwordEnvVar', () => {
      const result = buildPasswordResetInitContainer({
        ...baseArgs,
        catalogCode: 'mariadb',
        image: 'mariadb:11',
        passwordEnvVar: '',
      });

      expect(result).toBeNull();
    });
  });

  // These scripts now run as an init container in front of EVERY database
  // deployment (service.ts arms reuseExistingData unconditionally), so a
  // failure here would crash-loop the pod and take the tenant's database
  // offline. Locking in the best-effort contract.
  describe('best-effort contract (never take the database down)', () => {
    const ENGINES = [
      { catalogCode: 'mariadb', image: 'mariadb:12', passwordEnvVar: 'MARIADB_ROOT_PASSWORD' },
      { catalogCode: 'mysql', image: 'mysql:8', passwordEnvVar: 'MYSQL_ROOT_PASSWORD' },
      { catalogCode: 'postgresql', image: 'postgres:18', passwordEnvVar: 'POSTGRES_PASSWORD' },
      { catalogCode: 'mongodb', image: 'mongo:7', passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD' },
    ] as const;

    for (const engine of ENGINES) {
      it(`${engine.catalogCode}: never aborts on error and always exits 0`, () => {
        const script = buildPasswordResetInitContainer({ ...baseArgs, ...engine })!.command[2];

        // `set -e` would turn any single failed statement into a crash-looping
        // init container — i.e. an outage instead of a degraded SQL Manager.
        expect(script).not.toMatch(/^set -e$/m);
        expect(script.trimEnd().endsWith('exit 0')).toBe(true);
        expect(script).toContain('WARNING');
      });
    }

    it('mariadb/mysql tolerate a datadir with no root@% account', () => {
      for (const engine of [ENGINES[0], ENGINES[1]]) {
        const script = buildPasswordResetInitContainer({ ...baseArgs, ...engine })!.command[2];
        // A bare `ALTER USER 'root'@'%'` errors out when the account was
        // dropped, which used to abort the whole reset.
        expect(script).toContain("ALTER USER IF EXISTS 'root'@'%'");
        expect(script).toContain("CREATE USER IF NOT EXISTS 'root'@'localhost'");
      }
    });

    it('mariadb/mysql create the socket directory the entrypoint would have made', () => {
      for (const engine of [ENGINES[0], ENGINES[1]]) {
        const script = buildPasswordResetInitContainer({ ...baseArgs, ...engine })!.command[2];
        expect(script).toContain('mkdir -p');
      }
    });

    it('postgresql restores pg_hba.conf on every exit path', () => {
      const script = buildPasswordResetInitContainer({ ...baseArgs, ...ENGINES[2] })!.command[2];
      // Without the trap, an early exit leaves the main container running with
      // trust auth for every local connection.
      expect(script).toContain('trap ');
      expect(script).toContain('restore_hba');
      expect(script).toMatch(/EXIT INT TERM/);
    });
  });

  // The create path used a loose `.includes('PASSWORD')` while the redeploy
  // path used the strict one. On a MariaDB entry that generates both
  // MARIADB_PASSWORD (app user) and MARIADB_ROOT_PASSWORD, the loose matcher
  // could stamp the APP password onto root — leaving the platform locked out
  // of the database it just provisioned. One shared matcher now.
  describe('findAdminPasswordEnvVar', () => {
    it('picks the ROOT password even when an app-user password comes first', () => {
      expect(findAdminPasswordEnvVar([
        'MARIADB_PASSWORD', 'MARIADB_USER', 'MARIADB_ROOT_PASSWORD',
      ])).toBe('MARIADB_ROOT_PASSWORD');
    });

    it('never returns a non-admin password key', () => {
      expect(findAdminPasswordEnvVar(['MARIADB_PASSWORD', 'MARIADB_USER'])).toBeUndefined();
      expect(findAdminPasswordEnvVar(['APP_PASSWORD'])).toBeUndefined();
    });

    it('recognises every supported engine admin key', () => {
      expect(findAdminPasswordEnvVar(['MYSQL_ROOT_PASSWORD'])).toBe('MYSQL_ROOT_PASSWORD');
      expect(findAdminPasswordEnvVar(['POSTGRES_PASSWORD'])).toBe('POSTGRES_PASSWORD');
      expect(findAdminPasswordEnvVar(['MONGO_INITDB_ROOT_PASSWORD'])).toBe('MONGO_INITDB_ROOT_PASSWORD');
    });

    it('returns undefined for a non-database deployment', () => {
      expect(findAdminPasswordEnvVar(['APP_SECRET', 'SESSION_KEY'])).toBeUndefined();
    });
  });
});
