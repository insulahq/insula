import { describe, it, expect } from 'vitest';
import { buildPasswordResetInitContainer, findAdminPasswordEnvVar } from './password-reset.js';

describe('buildPasswordResetInitContainer', () => {
  const baseArgs = {
    storagePath: 'database/mariadb/my-db',
    volumeMountName: 'tenant-storage',
    cpuRequest: '100m',
    memoryRequest: '400Mi',
  };

  it('starts the temporary MySQL-family server lean, inside the instance\'s memory limit (engine defaults OOM a 300Mi MySQL 8)', () => {
    const mysql = buildPasswordResetInitContainer({ ...baseArgs, catalogCode: 'mysql', image: 'mysql:8.0', passwordEnvVar: 'MYSQL_ROOT_PASSWORD' })!.command[2]!;
    const maria = buildPasswordResetInitContainer({ ...baseArgs, catalogCode: 'mariadb', image: 'mariadb:11', passwordEnvVar: 'MARIADB_ROOT_PASSWORD' })!.command[2]!;
    for (const script of [mysql, maria]) {
      expect(script).toMatch(/--skip-grant-tables[^\n]*--performance-schema=OFF --innodb-buffer-pool-size=32M --innodb-log-buffer-size=4M --max-connections=10/);
    }
    // MySQL-only: MariaDB refuses an option it does not know.
    expect(mysql).toContain('--temptable-max-ram=16M');
    expect(maria).not.toContain('--temptable-max-ram');
  });

  it('starts every engine\'s temporary server no bigger than the server itself', () => {
    const maria = buildPasswordResetInitContainer({ ...baseArgs, catalogCode: 'mariadb', image: 'mariadb:11', passwordEnvVar: 'MARIADB_ROOT_PASSWORD' })!.command[2]!;
    expect(maria).toContain('--aria-pagecache-buffer-size=8M --key-buffer-size=8M');
    const pg = buildPasswordResetInitContainer({ ...baseArgs, catalogCode: 'postgresql', image: 'postgres:18', passwordEnvVar: 'POSTGRES_PASSWORD' })!.command[2]!;
    // Small buffers, and no library loaded or WAL archived while the login is put back.
    expect(pg).toContain("-c listen_addresses='' -c shared_buffers=16MB -c max_connections=10 -c work_mem=1MB -c maintenance_work_mem=16MB -c shared_preload_libraries= -c archive_mode=off");
    const mongo = buildPasswordResetInitContainer({ ...baseArgs, catalogCode: 'mongodb-7', image: 'mongo:7.0', passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD', passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME' })!.command[2]!;
    expect(mongo).toContain('--wiredTigerCacheSizeGB 0.25');
  });

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
      // root by socket only — no password to re-stamp, none to go stale.
      expect(result!.command[2]).toContain("ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket");
      expect(result!.command[2]).not.toContain('MARIADB_ROOT_PASSWORD');
      expect(result!.command[2]).not.toContain('IDENTIFIED BY');
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
      // auth_socket: loaded by option in the temporary server, registered for the real one.
      expect(result!.command[2]).toContain('--plugin-load-add=auth_socket.so');
      expect(result!.command[2]).toContain("INSERT IGNORE INTO mysql.plugin (name, dl) VALUES ('auth_socket', 'auth_socket.so')");
      expect(result!.command[2]).toContain("ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket");
      expect(result!.command[2]).not.toContain('MYSQL_ROOT_PASSWORD');
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
      // The configured superuser, whatever its name, loses its password.
      expect(result!.command[2]).toContain('SU="${POSTGRES_USER:-postgres}"');
      expect(result!.command[2]).toContain('ALTER ROLE CURRENT_USER PASSWORD NULL');
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

    it('recreates root restricted to logins from inside the pod', () => {
      const result = buildPasswordResetInitContainer({
        storagePath: 'database/mongodb-7/my-db', catalogCode: 'mongodb-7', image: 'mongo:7', volumeMountName: 'data',
        passwordEnvVar: 'MONGO_INITDB_ROOT_PASSWORD', passwordEnvVarUser: 'MONGO_INITDB_ROOT_USERNAME', cpuRequest: '100m', memoryRequest: '256Mi',
      });
      expect(result!.command[2]).toContain('authenticationRestrictions: [{ clientSource: ["127.0.0.1", "::1"] }]');
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

    it('mariadb/mysql recreate root@localhost if missing and drop every other root account', () => {
      for (const engine of [ENGINES[0], ENGINES[1]]) {
        const script = buildPasswordResetInitContainer({ ...baseArgs, ...engine })!.command[2];
        // A bare `ALTER USER 'root'@'%'` errors out when the account was
        // dropped, which used to abort the whole reset.
        expect(script).toContain("CREATE USER IF NOT EXISTS 'root'@'localhost'");
        expect(script).toContain("SELECT Host FROM mysql.user WHERE User = 'root' AND Host <> 'localhost'");
        expect(script).toContain("DROP USER IF EXISTS 'root'@'$H'");
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

  /**
   * The init container is charged against the tenant's ResourceQuota for the
   * pod's WHOLE lifetime — Kubernetes bills a pod
   * `max(sum(containers), max(initContainers))` — so asking for more than the
   * container it precedes silently eats quota nothing is using.
   *
   * A flat figure here charges every database below it the same, so mirroring
   * the fronted container is what keeps the init container free: with
   * init <= containers, `max(sum, init)` collapses to `sum`.
   */
  describe('resources mirror the container it fronts', () => {
    const forDb = (cpuRequest: string, memoryRequest: string) =>
      buildPasswordResetInitContainer({
        ...baseArgs,
        cpuRequest,
        memoryRequest,
        catalogCode: 'mariadb',
        image: 'mariadb:12',
        passwordEnvVar: 'MARIADB_ROOT_PASSWORD',
      })!;

    it('requests exactly the fronted container request, not a fixed 512Mi', () => {
      const result = forDb('100m', '400Mi');
      expect(result.resources.requests.memory).toBe('400Mi');
      expect(result.resources.requests.cpu).toBe('100m');
    });

    it('keeps memory request == limit (Guaranteed QoS, ADR-037)', () => {
      const result = forDb('100m', '400Mi');
      expect(result.resources.limits.memory).toBe(result.resources.requests.memory);
    });

    // The regression that shipped: any database under 512Mi was charged 512Mi,
    // which is why dropping that database from 400Mi to 350Mi moved the quota
    // not at all and returned a byte-identical error.
    it.each(['128Mi', '256Mi', '350Mi', '400Mi', '2Gi'])(
      'never exceeds the container it fronts (%s)',
      (memory) => {
        expect(forDb('100m', memory).resources.requests.memory).toBe(memory);
      },
    );
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
