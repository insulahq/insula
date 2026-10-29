import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock exec function accessible by both mock and test code
const mockExecFn = vi.fn();

// Mock @kubernetes/client-node before importing db-manager.
// Vitest 4 requires real classes here — a plain vi.fn(() => ({...}))
// factory is not callable with `new`, so we use class declarations.
vi.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromFile = vi.fn();
    loadFromCluster = vi.fn();
  }
  class MockExec {
    exec = mockExecFn;
  }
  return { KubeConfig: MockKubeConfig, Exec: MockExec };
});

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  buildDbContext,
  listDatabases,
  createDatabase,
  listUsers,
  createUser,
  dropUser,
  setUserPassword,
  executeQuery,
  listTables,
  listTablesWithSize,
  describeTable,
  browseTable,
  countRows,
  exportDatabase,
  importSql,
} from './db-manager.js';

function createMockK8s(pods: Array<{ name: string; phase: string }>): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue({
        items: pods.map((p) => ({
          metadata: { name: p.name },
          status: { phase: p.phase },
        })),
      }),
    },
    apps: {} as K8sClients['apps'],
    networking: {} as K8sClients['networking'],
    custom: {} as K8sClients['custom'],
  } as unknown as K8sClients;
}

function setupExecSuccess(stdout: string, stderr = '') {
  mockExecFn.mockImplementation(
    (
      _ns: string,
      _pod: string,
      _container: string,
      _command: string[],
      stdoutStream: NodeJS.WritableStream,
      stderrStream: NodeJS.WritableStream,
      _stdin: null,
      _tty: boolean,
      callback: (status: Record<string, unknown>) => void,
    ) => {
      if (stdout) stdoutStream.write(Buffer.from(stdout));
      if (stderr) stderrStream.write(Buffer.from(stderr));
      setTimeout(() => callback({ status: 'Success' }), 0);
      return Promise.resolve({} as unknown);
    },
  );
}

function setupExecFailure(stderr: string) {
  mockExecFn.mockImplementation(
    (
      _ns: string,
      _pod: string,
      _container: string,
      _command: string[],
      _stdoutStream: NodeJS.WritableStream,
      stderrStream: NodeJS.WritableStream,
      _stdin: null,
      _tty: boolean,
      callback: (status: Record<string, unknown>) => void,
    ) => {
      stderrStream.write(Buffer.from(stderr));
      setTimeout(() => callback({ status: 'Failure' }), 0);
      return Promise.resolve({} as unknown);
    },
  );
}

describe('db-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildDbContext', () => {
    it('should detect mariadb engine from catalog entry runtime', async () => {
      const k8s = createMockK8s([{ name: 'mydb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        '/tmp/kubeconfig',
        'tenant-abc',
        'mydb',
        { runtime: 'mariadb', code: 'mariadb' },
        { MARIADB_ROOT_PASSWORD: 'secret123' },
      );

      expect(ctx.engine).toBe('mariadb');
      expect(ctx.rootPassword).toBe('secret123');
      expect(ctx.podName).toBe('mydb-0');
      expect(ctx.containerName).toBe('mariadb');
      expect(ctx.namespace).toBe('tenant-abc');
    });

    it('should detect postgresql engine', async () => {
      const k8s = createMockK8s([{ name: 'pgdb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'tenant-abc',
        'pgdb',
        { runtime: 'postgresql', code: 'postgresql' },
        {},
      );

      expect(ctx.engine).toBe('postgresql');
      expect(ctx.rootPassword).toBe('');
    });

    it('should detect postgres alias', async () => {
      const k8s = createMockK8s([{ name: 'pgdb-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'tenant-abc',
        'pgdb',
        { runtime: 'postgres', code: 'postgres' },
        {},
      );

      expect(ctx.engine).toBe('postgresql');
    });

    it('should detect mysql engine', async () => {
      const k8s = createMockK8s([{ name: 'mysql-0', phase: 'Running' }]);

      const ctx = await buildDbContext(
        k8s,
        undefined,
        'tenant-abc',
        'mysql-inst',
        { runtime: 'mysql', code: 'mysql' },
        { MYSQL_ROOT_PASSWORD: 'mysecret' },
      );

      expect(ctx.engine).toBe('mysql');
      expect(ctx.rootPassword).toBe('mysecret');
    });

    it('should throw for unsupported engine', async () => {
      const k8s = createMockK8s([{ name: 'redis-0', phase: 'Running' }]);

      await expect(
        buildDbContext(k8s, undefined, 'tenant-abc', 'redis', { runtime: 'redis', code: 'redis' }, {}),
      ).rejects.toThrow('not supported for management');
    });

    it('should throw when no running pod found', async () => {
      const k8s = createMockK8s([{ name: 'mydb-0', phase: 'Pending' }]);

      await expect(
        buildDbContext(k8s, undefined, 'tenant-abc', 'mydb', { runtime: 'mariadb', code: 'mariadb' }, {}),
      ).rejects.toThrow('No running pod found');
    });

    it('should throw when no pods at all', async () => {
      const k8s = createMockK8s([]);

      await expect(
        buildDbContext(k8s, undefined, 'tenant-abc', 'mydb', { runtime: 'mariadb', code: 'mariadb' }, {}),
      ).rejects.toThrow('No running pod found');
    });

    it('multi-component lookup uses component label to disambiguate the DB pod', async () => {
      // Deployer labels every pod in the deployment with `app=my-wp2` plus
      // `component=<componentName>`. DB-manager must pin both so it doesn't
      // pick the wordpress pod when asked for the mariadb one.
      const listSpy = vi.fn().mockResolvedValue({
        items: [{ metadata: { name: 'my-wp2-mariadb-xyz' }, status: { phase: 'Running' } }],
      });
      const k8s = { core: { listNamespacedPod: listSpy }, apps: {}, networking: {}, custom: {} } as unknown as K8sClients;

      await buildDbContext(
        k8s, undefined, 'ns-xyz', 'my-wp2',
        { runtime: undefined, code: 'wordpress' },
        { MARIADB_ROOT_PASSWORD: 's3cr3t' },
        'mariadb', 'mariadb',
      );
      const args = listSpy.mock.calls[0][0];
      expect(args.namespace).toBe('ns-xyz');
      expect(args.labelSelector).toBe('app=my-wp2,component=mariadb');
    });
  });

  describe('listDatabases', () => {
    it('should list mysql databases excluding system databases', async () => {
      setupExecSuccess('information_schema\nmysql\nperformance_schema\nsys\nmyapp_db\ntest_db');

      const ctx = {
        kubeconfigPath: '/tmp/kubeconfig',
        namespace: 'tenant-abc',
        podName: 'mydb-0',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'secret',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([{ name: 'myapp_db' }, { name: 'test_db' }]);
    });

    it('should list postgresql databases excluding postgres', async () => {
      setupExecSuccess('myapp_db\ntest_db');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'tenant-abc',
        podName: 'pgdb-0',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([{ name: 'myapp_db' }, { name: 'test_db' }]);
    });

    it('should return empty array when no user databases exist', async () => {
      setupExecSuccess('information_schema\nmysql\nperformance_schema\nsys');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([]);
    });
  });

  describe('createDatabase', () => {
    it('should reject invalid database names', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createDatabase(ctx, 'my-db')).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, '123abc')).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, 'a'.repeat(65))).rejects.toThrow('Invalid database name');
      await expect(createDatabase(ctx, '')).rejects.toThrow('Invalid database name');
    });

    it('should accept valid database names for mariadb', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createDatabase(ctx, 'my_database')).resolves.toBeUndefined();
    });

    it('should accept valid database names for postgresql', async () => {
      // PG needs two exec calls: SELECT check + CREATE
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          _command: string[],
          stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: null,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          // First call: check if db exists (return empty = doesn't exist)
          // Second call: create db
          if (callCount === 0) {
            // empty stdout means db doesn't exist
          }
          callCount++;
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      await expect(createDatabase(ctx, 'new_db')).resolves.toBeUndefined();
    });
  });

  describe('listUsers', () => {
    it('should list mysql users excluding system users', async () => {
      // First call: SELECT User, Host FROM mysql.user
      // Second call (may try mariadb binary first, then mysql): SELECT User, Db FROM mysql.db
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          command: string[],
          stdoutStream: NodeJS.WritableStream,
          stderrStream: NodeJS.WritableStream,
          _stdin: null,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          callCount++;
          const sql = command.find((c) => c.includes('SELECT'));
          const stdout = sql?.includes('mysql.db')
            ? 'app_user\tmy_database\nreader\tother_db'
            : 'root\t%\nmariadb.sys\tlocalhost\napp_user\t%\nreader\t%';
          stdoutStream.write(Buffer.from(stdout));
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const users = await listUsers(ctx);
      expect(users).toEqual([
        { username: 'app_user', host: '%', databases: ['my_database'] },
        { username: 'reader', host: '%', databases: ['other_db'] },
      ]);
    });

    it('should list postgresql users', async () => {
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          command: string[],
          stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: null,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          callCount++;
          const sql = command.find((c) => c.includes('SELECT') || c.includes('select'));
          let stdout = '';
          if (sql?.includes('pg_user')) {
            stdout = 'app_user\nreader';
          } else if (sql?.includes('pg_database')) {
            stdout = 'test_db';
          } else if (sql?.includes('has_database_privilege')) {
            stdout = 't';
          }
          stdoutStream.write(Buffer.from(stdout));
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const users = await listUsers(ctx);
      expect(users).toEqual([
        { username: 'app_user', host: '*', databases: ['test_db'] },
        { username: 'reader', host: '*', databases: ['test_db'] },
      ]);
    });
  });

  describe('createUser', () => {
    it('should reject invalid usernames', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'user-name', 'pass')).rejects.toThrow('Invalid username');
      await expect(createUser(ctx, '', 'pass')).rejects.toThrow('Invalid username');
    });

    it('should reject invalid database names in grant', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'good_user', 'pass', 'bad-db')).rejects.toThrow('Invalid database name');
    });

    it('should create user with database grant for mysql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'new_user', 'pass123', 'mydb')).resolves.toBeUndefined();

      // Assert the STATEMENTS, not the call count. The previous version
      // asserted "3 calls", which says nothing about whether the password was
      // applied or the grant issued — and it broke the moment a genuinely
      // necessary statement was added.
      // The SQL lives inside the k8s exec command array, not the last arg
      // (which is the status callback) — stringify the whole call.
      const sql = mockExecFn.mock.calls
        .map((c: unknown[]) => c.map(a => (typeof a === 'function' ? '' : JSON.stringify(a))).join(' '))
        .join('\n');
      expect(sql).toContain("CREATE USER IF NOT EXISTS 'new_user'@'%'");
      // ALTER is load-bearing: CREATE ... IF NOT EXISTS is a NO-OP for an
      // existing user, so without this the caller's password is never applied
      // while still being returned to the panel and displayed.
      expect(sql).toContain("ALTER USER 'new_user'@'%' IDENTIFIED BY 'pass123'");
      expect(sql).toContain('GRANT ALL PRIVILEGES ON `mydb`.* TO \'new_user\'@\'%\'');
      expect(sql).toContain('FLUSH PRIVILEGES');
    });

    it('grants on *.* when no database is given (the panel\'s "All databases")', async () => {
      setupExecSuccess('');
      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(createUser(ctx, 'all_user', 'pass123')).resolves.toBeUndefined();

      // Omitting the database used to fall through granting NOTHING, leaving
      // `GRANT USAGE ON *.*` — which means no privileges — so the account could
      // authenticate and then be denied on every database.
      const sql = mockExecFn.mock.calls
        .map((c: unknown[]) => c.map(a => (typeof a === 'function' ? '' : JSON.stringify(a))).join(' '))
        .join('\n');
      expect(sql).toContain("GRANT ALL PRIVILEGES ON *.* TO 'all_user'@'%'");
      expect(sql).toContain('FLUSH PRIVILEGES');
    });
  });

  describe('dropUser', () => {
    it('should validate username before dropping', async () => {
      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(dropUser(ctx, 'invalid-user')).rejects.toThrow('Invalid username');
    });

    it('should drop valid user for mysql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(dropUser(ctx, 'old_user')).resolves.toBeUndefined();
    });
  });

  describe('setUserPassword', () => {
    it('should execute password change for mysql', async () => {
      // The host lookup answers '%' (every call gets the same stdout here).
      setupExecSuccess('%');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(setUserPassword(ctx, 'app_user', 'new_pass')).resolves.toBeUndefined();
      // host lookup + ALTER USER + FLUSH PRIVILEGES
      expect(mockExecFn).toHaveBeenCalledTimes(3);
    });

    it('should execute password change for postgresql', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      await expect(setUserPassword(ctx, 'app_user', 'new_pass')).resolves.toBeUndefined();
      expect(mockExecFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('exec error handling', () => {
    it('should throw when pod exec fails', async () => {
      setupExecFailure('ERROR 1045 (28000): Access denied');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'wrong',
      };

      await expect(listDatabases(ctx)).rejects.toThrow();
    });

    it('should fall back to mysql binary when mariadb binary is not found', async () => {
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          command: string[],
          stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          callCount++;
          if (command[0] === 'mariadb') {
            // Simulate binary not found
            setTimeout(() => callback({
              status: 'Failure',
              message: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "mariadb": executable file not found in $PATH',
            }), 0);
            return Promise.resolve({} as unknown);
          }
          // mysql binary succeeds
          stdoutStream.write(Buffer.from('myapp_db'));
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mysql',
        engine: 'mysql' as const,
        rootPassword: 'pw',
      };

      const dbs = await listDatabases(ctx);
      expect(dbs).toEqual([{ name: 'myapp_db' }]);
      expect(callCount).toBe(2);
    });

    it('should NOT fall back when mariadb binary exists but SQL fails', async () => {
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          _command: string[],
          _stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          // Simulate an actual SQL error (not binary-not-found)
          setTimeout(() => callback({
            status: 'Failure',
            message: 'ERROR 1045 (28000): Access denied for user',
          }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'wrong',
      };

      // Should throw the original error, not silently retry with mysql
      await expect(listDatabases(ctx)).rejects.toThrow('Access denied');
      // Only one call — no fallback
      expect(mockExecFn).toHaveBeenCalledTimes(1);
    });

    it('should fall back to mysqldump when mariadb-dump is not found for export', async () => {
      let callCount = 0;
      mockExecFn.mockImplementation(
        (
          _ns: string,
          _pod: string,
          _container: string,
          command: string[],
          stdoutStream: NodeJS.WritableStream,
          _stderrStream: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          callback: (status: Record<string, unknown>) => void,
        ) => {
          callCount++;
          if (command[0] === 'mariadb-dump') {
            setTimeout(() => callback({
              status: 'Failure',
              message: 'executable file not found in $PATH',
            }), 0);
            return Promise.resolve({} as unknown);
          }
          // mysqldump succeeds
          stdoutStream.write(Buffer.from('-- MySQL dump\nCREATE TABLE t (id INT);'));
          setTimeout(() => callback({ status: 'Success' }), 0);
          return Promise.resolve({} as unknown);
        },
      );

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mysql',
        engine: 'mysql' as const,
        rootPassword: 'pw',
      };

      const dump = await exportDatabase(ctx, 'mydb');
      expect(dump).toContain('CREATE TABLE');
      expect(callCount).toBe(2);
    });
  });

  // ─── Query Execution Tests ──────────────────────────────────────────────

  describe('executeQuery', () => {
    const mariaCtx = {
      kubeconfigPath: '/tmp/kc',
      namespace: 'ns',
      podName: 'pod',
      containerName: 'mariadb',
      engine: 'mariadb' as const,
      rootPassword: 'pw',
    };

    const pgCtx = {
      kubeconfigPath: undefined,
      namespace: 'ns',
      podName: 'pod',
      containerName: 'postgresql',
      engine: 'postgresql' as const,
      rootPassword: '',
    };

    it('should parse mysql --batch output into columns and rows', async () => {
      // --batch output: header row + tab-separated data (with column names)
      setupExecSuccess('id\tname\temail\n1\tAlice\talice@example.com\n2\tBob\tbob@example.com');

      const result = await executeQuery(mariaCtx, 'mydb', 'SELECT * FROM users');

      expect(result.columns).toEqual(['id', 'name', 'email']);
      expect(result.rows).toEqual([
        ['1', 'Alice', 'alice@example.com'],
        ['2', 'Bob', 'bob@example.com'],
      ]);
      expect(result.rowCount).toBe(2);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('should parse postgresql --csv output into columns and rows', async () => {
      setupExecSuccess('id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com');

      const result = await executeQuery(pgCtx, 'mydb', 'SELECT * FROM users');

      expect(result.columns).toEqual(['id', 'name', 'email']);
      expect(result.rows).toEqual([
        ['1', 'Alice', 'alice@example.com'],
        ['2', 'Bob', 'bob@example.com'],
      ]);
      expect(result.rowCount).toBe(2);
    });

    it('should handle csv output with quoted fields containing commas', async () => {
      setupExecSuccess('id,name,bio\n1,"Smith, John","A man, a plan"');

      const result = await executeQuery(pgCtx, 'mydb', 'SELECT * FROM users');

      expect(result.columns).toEqual(['id', 'name', 'bio']);
      expect(result.rows).toEqual([
        ['1', 'Smith, John', 'A man, a plan'],
      ]);
    });

    it('should handle csv output with escaped quotes', async () => {
      setupExecSuccess('id,value\n1,"He said ""hello"""');

      const result = await executeQuery(pgCtx, 'mydb', 'SELECT * FROM data');

      expect(result.columns).toEqual(['id', 'value']);
      expect(result.rows).toEqual([
        ['1', 'He said "hello"'],
      ]);
    });

    it('should return empty result for empty output', async () => {
      setupExecSuccess('');

      const result = await executeQuery(mariaCtx, 'mydb', 'DELETE FROM users WHERE 1=0');

      expect(result.columns).toEqual([]);
      expect(result.rows).toEqual([]);
      expect(result.rowCount).toBe(0);
    });

    it('should return error result when exec fails non-fatally', async () => {
      // Simulate a failure that returns an error in the result
      setupExecFailure('ERROR 1146 (42S02): Table does not exist');

      const result = await executeQuery(mariaCtx, 'mydb', 'SELECT * FROM nonexistent');

      // The error is captured in the result
      expect(result.error).toBeDefined();
      expect(result.rowCount).toBe(0);
    });

    it('should reject queries exceeding max length', async () => {
      const longQuery = 'SELECT ' + 'x'.repeat(1_048_576);

      await expect(
        executeQuery(mariaCtx, 'mydb', longQuery),
      ).rejects.toThrow('exceeds maximum length');
    });

    it('should reject invalid database names', async () => {
      await expect(
        executeQuery(mariaCtx, '../../etc', 'SELECT 1'),
      ).rejects.toThrow('Invalid database name');
    });
  });

  // ─── Table Listing Tests ────────────────────────────────────────────────

  describe('listTables', () => {
    it('should list mysql tables from a database', async () => {
      setupExecSuccess('users\nposts\ncomments');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const tables = await listTables(ctx, 'mydb');
      expect(tables).toEqual(['users', 'posts', 'comments']);
    });

    // SHOW TABLES rows are data cells, which --batch escapes. Without undoing
    // that, `back\slash` is listed as `back\\slash` and can never be opened.
    it('returns mysql table names exactly as the engine holds them', async () => {
      setupExecSuccess('1-StudentsTb\nback\\\\slash\ntab\\tx');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      expect(await listTables(ctx, 'school')).toEqual(['1-StudentsTb', 'back\\slash', 'tab\tx']);
    });

    it('returns table names with sizes exactly as the engine holds them', async () => {
      // Cells are tab-separated; a tab INSIDE a name arrives escaped as `\t`.
      setupExecSuccess('1-StudentsTb\t278528\t1000\nback\\\\slash\t16384\t2\ntab\\tx\t16384\t1');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      expect(await listTablesWithSize(ctx, 'school')).toEqual([
        { name: '1-StudentsTb', sizeBytes: 278528, rowCount: 1000 },
        { name: 'back\\slash', sizeBytes: 16384, rowCount: 2 },
        { name: 'tab\tx', sizeBytes: 16384, rowCount: 1 },
      ]);
    });

    it('quotes mongodb collection names and sort keys as JS string literals', async () => {
      setupExecSuccess('[]');
      const ctx = {
        kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'mongodb',
        engine: 'mongodb' as const, rootPassword: 'pw', rootUsername: 'root',
      };

      await browseTable(ctx, 'school', '1-students"x', { orderBy: 'a"b', orderDir: 'desc' });

      const script = (mockExecFn.mock.calls[0][3] as string[]).find((a) => a.includes('getCollection'));
      expect(script).toContain('getCollection("1-students\\"x")');
      expect(script).toContain('.sort({"a\\"b":-1})');
    });

    it('should list postgresql tables from a database', async () => {
      setupExecSuccess('tablename\nusers\nposts\ncomments');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const tables = await listTables(ctx, 'mydb');
      expect(tables).toEqual(['users', 'posts', 'comments']);
    });

    it('should return empty array when no tables exist', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const tables = await listTables(ctx, 'empty_db');
      expect(tables).toEqual([]);
    });

    it('should reject invalid database names', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(listTables(ctx, '../etc')).rejects.toThrow('Invalid database name');
    });
  });

  // ─── Table Structure Tests ──────────────────────────────────────────────

  describe('describeTable', () => {
    it('should describe mysql table structure', async () => {
      // DESCRIBE output: Field, Type, Null, Key, Default, Extra
      setupExecSuccess(
        'Field\tType\tNull\tKey\tDefault\tExtra\n' +
        'id\tint(11)\tNO\tPRI\tNULL\tauto_increment\n' +
        'name\tvarchar(255)\tYES\t\tNULL\t\n' +
        'email\tvarchar(255)\tNO\tUNI\tNULL\t',
      );

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const columns = await describeTable(ctx, 'mydb', 'users');

      expect(columns).toEqual([
        { name: 'id', type: 'int(11)', nullable: false, defaultValue: null, key: 'PRI' },
        { name: 'name', type: 'varchar(255)', nullable: true, defaultValue: null, key: '' },
        { name: 'email', type: 'varchar(255)', nullable: false, defaultValue: null, key: 'UNI' },
      ]);
    });

    it('should describe postgresql table structure', async () => {
      setupExecSuccess(
        'column_name,data_type,is_nullable,column_default,key_type\n' +
        'id,integer,NO,,PRIMARY KEY\n' +
        'name,character varying,YES,,\n' +
        'email,character varying,NO,,UNIQUE',
      );

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const columns = await describeTable(ctx, 'mydb', 'users');

      expect(columns).toEqual([
        { name: 'id', type: 'integer', nullable: false, defaultValue: null, key: 'PRI' },
        { name: 'name', type: 'character varying', nullable: true, defaultValue: null, key: '' },
        { name: 'email', type: 'character varying', nullable: false, defaultValue: null, key: 'UNI' },
      ]);
    });

    // An imported schema named its tables `1-StudentsTb`, `2-…`: the old
    // CREATE-time charset check refused them with a 400 that the panel showed
    // as an empty table. Any name the engine holds must be describable.
    it('describes tables whose names start with a digit or contain a hyphen', async () => {
      setupExecSuccess('Field\tType\tNull\tKey\tDefault\tExtra\nSTUDENTID\tint(11)\tNO\tPRI\tNULL\t');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      const columns = await describeTable(ctx, 'mydb', '1-StudentsTb');

      expect(columns.map((c) => c.name)).toEqual(['STUDENTID']);
      const argv: string[] = mockExecFn.mock.calls[0][3];
      expect(argv).toContain('DESCRIBE `mydb`.`1-StudentsTb`');
    });

    it('doubles an embedded backtick and unescapes batch-escaped column names', async () => {
      // --batch prints a backslash inside a data cell as `\\`.
      setupExecSuccess('Field\tType\tNull\tKey\tDefault\tExtra\nc\\\\d\tint(11)\tYES\t\tNULL\t');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      const columns = await describeTable(ctx, 'mydb', 'we`ird');

      expect(columns[0].name).toBe('c\\d');
      expect(mockExecFn.mock.calls[0][3]).toContain('DESCRIBE `mydb`.`we``ird`');
    });

    it('quotes a postgresql table name as a string literal', async () => {
      setupExecSuccess('column_name,data_type,is_nullable,column_default,key_type\n');
      const ctx = {
        kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'postgresql',
        engine: 'postgresql' as const, rootPassword: '',
      };

      await describeTable(ctx, 'mydb', "it's-here");

      const sql = (mockExecFn.mock.calls[0][3] as string[]).find((a) => a.includes('information_schema.columns'));
      expect(sql).toContain("c.table_name = 'it''s-here'");
    });

    it('rejects only names no engine can hold', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(describeTable(ctx, 'mydb', '')).rejects.toThrow('Invalid table name');
      await expect(describeTable(ctx, 'mydb', 'a\0b')).rejects.toThrow('Invalid table name');
      await expect(describeTable(ctx, 'mydb', 'x'.repeat(256))).rejects.toThrow('Invalid table name');
      await expect(describeTable(ctx, 'mydb', ['a', 'b'] as unknown as string)).rejects.toThrow('Invalid table name');
      expect(mockExecFn).not.toHaveBeenCalled();
    });

    it('surfaces the engine error as DB_EXEC_ERROR', async () => {
      setupExecFailure("ERROR 1146 (42S02) at line 1: Table 'mydb.gone' doesn't exist");
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(describeTable(ctx, 'mydb', 'gone')).rejects.toMatchObject({
        code: 'DB_EXEC_ERROR', message: expect.stringContaining("doesn't exist"),
      });
    });
  });

  // ─── Table Data Browsing Tests ──────────────────────────────────────────

  describe('browseTable', () => {
    it('should browse mysql table with default options', async () => {
      setupExecSuccess('id\tname\n1\tAlice\n2\tBob');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const result = await browseTable(ctx, 'mydb', 'users');

      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rows).toEqual([['1', 'Alice'], ['2', 'Bob']]);
      expect(result.rowCount).toBe(2);
    });

    it('should browse postgresql table with ordering', async () => {
      setupExecSuccess('id,name\n2,Bob\n1,Alice');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const result = await browseTable(ctx, 'mydb', 'users', {
        orderBy: 'id',
        orderDir: 'desc',
        limit: 10,
        offset: 0,
      });

      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rowCount).toBe(2);
    });

    it('should clamp limit to max 1000', async () => {
      setupExecSuccess('id\n1');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await browseTable(ctx, 'mydb', 'users', { limit: 9999 });

      // The SQL in the exec call should use 1000 as the limit
      const execCall = mockExecFn.mock.calls[0];
      const sqlArg = execCall[3].find((arg: string) => arg.includes('LIMIT'));
      expect(sqlArg).toContain('LIMIT 1000');
    });

    it('browses a hyphenated table and quotes the sort column', async () => {
      setupExecSuccess('CITYID\tCITY\n1\tNorthfield');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      const result = await browseTable(ctx, 'school', '1-StudentsTb', { orderBy: 'first name', orderDir: 'desc' });

      expect(result.rows).toEqual([['1', 'Northfield']]);
      const sqlArg = (mockExecFn.mock.calls[0][3] as string[]).find((a) => a.includes('LIMIT'));
      expect(sqlArg).toBe('USE `school`; SELECT * FROM `1-StudentsTb` ORDER BY `first name` DESC LIMIT 50 OFFSET 0');
    });

    it('quotes postgresql names with doubled double quotes', async () => {
      setupExecSuccess('id\n1');
      const ctx = {
        kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'postgresql',
        engine: 'postgresql' as const, rootPassword: '',
      };

      await browseTable(ctx, 'mydb', 'a"b', { orderBy: 'c"d' });

      const sqlArg = (mockExecFn.mock.calls[0][3] as string[]).find((a) => a.includes('LIMIT'));
      expect(sqlArg).toBe('SELECT * FROM "a""b" ORDER BY "c""d" ASC LIMIT 50 OFFSET 0');
    });

    // The query tab renders engine errors inline; browsing has no such surface,
    // so an inline error used to arrive as HTTP 200 and render as an empty table.
    it('turns an engine failure into a DB_EXEC_ERROR instead of an empty 200 result', async () => {
      setupExecFailure("ERROR 1146 (42S02) at line 1: Table 'school.old_courses' doesn't exist");
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(browseTable(ctx, 'school', 'old_courses')).rejects.toMatchObject({
        code: 'DB_EXEC_ERROR', status: 500, message: expect.stringContaining("doesn't exist"),
      });
    });

    it('rejects a sort column no engine can hold', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(browseTable(ctx, 'mydb', 'users', { orderBy: 'a\0b' })).rejects.toThrow('Invalid column name');
      expect(mockExecFn).not.toHaveBeenCalled();
    });
  });

  // ─── Row Count Tests ────────────────────────────────────────────────────

  describe('countRows', () => {
    it('should count rows in a mysql table', async () => {
      setupExecSuccess('42');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const count = await countRows(ctx, 'mydb', 'users');
      expect(count).toBe(42);
    });

    it('should count rows in a postgresql table', async () => {
      setupExecSuccess('count\n99');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const count = await countRows(ctx, 'mydb', 'users');
      expect(count).toBe(99);
    });

    it('should return 0 for empty table', async () => {
      setupExecSuccess('0');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const count = await countRows(ctx, 'mydb', 'empty_table');
      expect(count).toBe(0);
    });

    it('counts rows of a hyphenated table', async () => {
      setupExecSuccess('1000');
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      expect(await countRows(ctx, 'school', '1-StudentsTb')).toBe(1000);
      expect(mockExecFn.mock.calls[0][3]).toContain('SELECT COUNT(*) FROM `school`.`1-StudentsTb`');
    });

    it('surfaces the engine error as DB_EXEC_ERROR', async () => {
      setupExecFailure("ERROR 1146 (42S02) at line 1: Table 'mydb.gone' doesn't exist");
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(countRows(ctx, 'mydb', 'gone')).rejects.toMatchObject({ code: 'DB_EXEC_ERROR' });
    });

    it('rejects an empty table name', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc', namespace: 'ns', podName: 'pod', containerName: 'mariadb',
        engine: 'mariadb' as const, rootPassword: 'pw',
      };

      await expect(countRows(ctx, 'mydb', '')).rejects.toThrow('Invalid table name');
    });
  });

  // ─── Export Database Tests ──────────────────────────────────────────────

  describe('exportDatabase', () => {
    it('should export a mysql database dump', async () => {
      const dumpContent = '-- MariaDB dump\nCREATE TABLE users (id INT);\nINSERT INTO users VALUES (1);';
      setupExecSuccess(dumpContent);

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const dump = await exportDatabase(ctx, 'mydb');
      expect(dump).toContain('CREATE TABLE');
      expect(dump).toContain('INSERT INTO');
    });

    it('should export a postgresql database dump', async () => {
      const dumpContent = '-- PostgreSQL database dump\nCREATE TABLE users (id integer);';
      setupExecSuccess(dumpContent);

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const dump = await exportDatabase(ctx, 'mydb');
      expect(dump).toContain('CREATE TABLE');
    });

    it('should reject invalid database names for export', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(exportDatabase(ctx, '../etc')).rejects.toThrow('Invalid database name');
    });
  });

  // ─── Import SQL Tests ──────────────────────────────────────────────────

  describe('importSql', () => {
    it('should import sql into a mysql database', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const result = await importSql(ctx, 'mydb', 'CREATE TABLE test (id INT);');
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should import sql into a postgresql database', async () => {
      setupExecSuccess('');

      const ctx = {
        kubeconfigPath: undefined,
        namespace: 'ns',
        podName: 'pod',
        containerName: 'postgresql',
        engine: 'postgresql' as const,
        rootPassword: '',
      };

      const result = await importSql(ctx, 'mydb', 'CREATE TABLE test (id integer);');
      expect(result.success).toBe(true);
    });

    it('should return error when import has SQL errors for mysql', async () => {
      setupExecSuccess('', 'ERROR 1064 (42000): You have an error in your SQL syntax');

      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const result = await importSql(ctx, 'mydb', 'INVALID SQL');
      expect(result.success).toBe(false);
      expect(result.error).toContain('ERROR');
    });

    it('should reject imports exceeding max size', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      const largeSql = 'INSERT INTO test VALUES ' + '(1),'.repeat(14_000_000);

      await expect(importSql(ctx, 'mydb', largeSql)).rejects.toThrow('exceeds maximum size');
    });

    it('should reject invalid database names for import', async () => {
      const ctx = {
        kubeconfigPath: '/tmp/kc',
        namespace: 'ns',
        podName: 'pod',
        containerName: 'mariadb',
        engine: 'mariadb' as const,
        rootPassword: 'pw',
      };

      await expect(importSql(ctx, '../etc', 'SELECT 1')).rejects.toThrow('Invalid database name');
    });
  });
});
