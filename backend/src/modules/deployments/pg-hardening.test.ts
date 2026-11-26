/**
 * pg-hardening.ts against a fake psql. What the SQL does on a real server was
 * checked on PostgreSQL 18; here the statements it sends are held to what the
 * threat model needs.
 */
import { describe, expect, it } from 'vitest';
import { DbExecError, type DbManagerContext } from './db-manager.js';
import type { DbCommandRunner } from './db-exec.js';
import { connectableDatabases, databaseHardeningSql, hardenPostgresCluster, hardenPostgresDatabase } from './pg-hardening.js';

const hex = (s: string): string => Buffer.from(s).toString('hex');

function ctx(rootUsername = 'postgres'): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'ns', podName: 'pod', containerName: 'c', engine: 'postgresql', rootPassword: '', rootUsername };
}

interface Call { readonly argv: string[]; readonly sql: string; readonly database?: string }

function fake(answer: (c: Call) => string | Error | undefined): { calls: Call[]; sqls: string[]; run: DbCommandRunner } {
  const calls: Call[] = [];
  return {
    calls,
    get sqls() { return calls.map((c) => c.sql); },
    run: async (_ctx, argv) => {
      const psql = argv[4] === 'psql';
      const call: Call = { argv, sql: argv[argv.length - 1]!, database: psql ? argv[argv.indexOf('-d') + 1] : undefined };
      calls.push(call);
      const a = answer(call);
      if (a instanceof Error) throw a;
      return { stdout: a ?? '', stderr: '' };
    },
  };
}

describe('databaseHardeningSql', () => {
  const TAG = '$t1$';
  const sql = databaseHardeningSql('dbadmin', TAG);

  it('is one DO block and the read of what it changed', () => {
    expect(sql.split(TAG)).toHaveLength(3);
    expect(sql.startsWith(`DO ${TAG}\nDECLARE`)).toBe(true);
    expect(sql).toContain(`END ${TAG};\nSELECT t FROM pg_temp.insula_changes;`);
    expect(sql.trimEnd().endsWith('SELECT t FROM pg_temp.insula_changes;')).toBe(true);
  });

  it('disables event triggers BEFORE it creates anything: the temp table is made by EXECUTE, after the first loop', () => {
    // no top-level DDL ahead of the block, where an event trigger could fire as the superuser
    expect(sql.slice(0, sql.indexOf('DO ')).trim()).toBe('');
    const disable = sql.indexOf('ALTER EVENT TRIGGER %I DISABLE');
    const create = sql.indexOf("EXECUTE 'CREATE TEMP TABLE IF NOT EXISTS insula_changes (t text)'");
    expect(disable).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(disable);
    expect(sql.indexOf('INSERT INTO pg_temp.insula_changes')).toBeGreaterThan(create);
  });

  it('a user mapping that skips the password check is made to need one again', () => {
    expect(sql).toContain("um.umoptions @> ARRAY['password_required=false']");
    expect(sql).toContain("ALTER USER MAPPING FOR %s SERVER %I OPTIONS (SET password_required %L)");
  });

  it('dblink\'s unchecked connect functions and adminpack are taken from everyone but their owner', () => {
    expect(sql).toContain("e.extname = 'dblink' AND p.proname LIKE 'dblink\\_connect\\_u%'");
    expect(sql).toContain("e.extname = 'adminpack'");
    expect(sql).toContain("REVOKE ALL ON FUNCTION %s FROM %s");
  });

  it('pins its own search_path before anything else, and schema-qualifies what follows', () => {
    const first = sql.indexOf('set_config');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(sql.indexOf('FOR r IN'));
    expect(sql).toContain("pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)");
  });

  it('quotes the owner as a string literal', () => {
    expect(sql).toContain("target text := 'dbadmin';");
    expect(databaseHardeningSql("o'brien", TAG)).toContain("target text := 'o''brien';");
    expect(databaseHardeningSql('a"b', TAG)).toContain(`target text := 'a"b';`);
  });

  it('hands objects to the owner through %I, never by pasting the name into a statement', () => {
    expect(sql).toContain("'ALTER SCHEMA %I OWNER TO %I', r.nspname, target");
    expect(sql).toMatch(/ALTER TABLE %I\.%I OWNER TO %I'\s+END, r\.nspname, r\.relname, target/);
  });

  it('disables event triggers that are not an extension\'s', () => {
    expect(sql).toContain("e.evtenabled <> 'D'");
    expect(sql).toContain("ALTER EVENT TRIGGER %I DISABLE");
    expect(sql).toMatch(/pg_event_trigger e WHERE e\.evtenabled <> 'D' AND NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_depend d WHERE d\.classid = 'pg_event_trigger'/);
  });

  it('keeps PUBLIC\'s UPDATE on pg_settings and revokes every other catalog write', () => {
    expect(sql).toContain("NOT (c.oid = 'pg_catalog.pg_settings'::pg_catalog.regclass AND a.grantee = 0 AND a.privilege_type = 'UPDATE')");
    expect(sql).toContain("a.privilege_type <> 'SELECT'");
    expect(sql).toContain("REVOKE %s ON TABLE %s FROM %s");
  });

  it('locks untrusted-language functions down to the superuser, but not aggregates (internal, and as harmless as their functions)', () => {
    const lockdown = sql.slice(sql.indexOf('-- Untrusted code'), sql.indexOf('FOR r IN SELECT c.oid::pg_catalog.regclass AS rel, c.oid, c.relowner'));
    expect(lockdown).toContain("NOT l.lanpltrusted AND p.prokind <> 'a'");
    expect(lockdown).toContain('NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend');
    expect(lockdown).toContain('REVOKE ALL ON %s %s FROM PUBLIC');
    // procedures are PROCEDURE, everything else FUNCTION
    expect(lockdown).toContain("CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END");
  });

  it('an aggregate the superuser owns is handed to the owner like any other object', () => {
    expect(sql).toContain("(l.lanpltrusted OR p.prokind = 'a')");
    expect(sql).toContain("CASE r.prokind WHEN 'a' THEN 'AGGREGATE' ELSE 'ROUTINE' END");
  });

  it('never touches the server\'s own schemas when handing objects over', () => {
    expect(sql).toContain("n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_'");
  });

  it('leaves a sequence a table owns, and an extension\'s objects, with their table / extension', () => {
    expect(sql).toContain("d.deptype IN ('a', 'i', 'e')");
  });

  it('locks file_fdw tables (their program option is a shell) and disables the superuser\'s subscriptions', () => {
    expect(sql).toContain("w.fdwname = 'file_fdw'");
    expect(sql).toContain('ALTER SUBSCRIPTION %I DISABLE');
    expect(sql).toContain('s.subowner = su');
  });

  it('uses a random dollar-quote tag, so an owner name cannot end the body early', () => {
    const hostile = databaseHardeningSql('x$insula$; ALTER ROLE evil SUPERUSER; --');
    const tag = /^DO (\$insula_[0-9a-f]{12}\$)\n/.exec(hostile)![1]!;
    expect(hostile.split(tag)).toHaveLength(3);
    expect(databaseHardeningSql('a').match(/^DO (\$[^\n]*\$)\n/)![1]).not.toBe(databaseHardeningSql('a').match(/^DO (\$[^\n]*\$)\n/)![1]);
  });

  it('refuses an owner that contains the tag it was given', () => {
    expect(() => databaseHardeningSql('x$t1$y', '$t1$')).toThrow('dollar-quote tag');
  });
});

describe('hardenPostgresDatabase', () => {
  it('runs the block in the database asked for and returns the rows it reports', async () => {
    const s = fake(() => 'disabled the event trigger t in shop\n\nshop owns public.orders\n');
    const out = await hardenPostgresDatabase({ ctx: ctx('myapp'), run: s.run }, 'shop', 'dbadmin');
    expect(out).toEqual(['disabled the event trigger t in shop', 'shop owns public.orders']);
    expect(s.calls[0]!.database).toBe("dbname='shop'");
    expect(s.calls[0]!.argv[s.calls[0]!.argv.indexOf('-U') + 1]).toBe('myapp');
    expect(s.calls[0]!.sql.replace(/\$insula_[0-9a-f]{12}\$/g, '$T$')).toBe(databaseHardeningSql('dbadmin', '$T$'));
  });

  it('a failure reaches the caller', async () => {
    const s = fake(() => new DbExecError('ERROR: permission denied'));
    // tryRun reports a throw as a failure, sh raises it
    await expect(hardenPostgresDatabase({ ctx: ctx(), run: s.run }, 'shop', 'o')).rejects.toThrow('permission denied');
  });
});

describe('connectableDatabases', () => {
  it('reads name, owner and whether the superuser owns it, hex-encoded', async () => {
    const s = fake(() => [
      `${hex('postgres')},${hex('postgres')},true`,
      `${hex('my,db')},${hex('tenant')},false`,
      `${hex('sh\nop')},${hex('postgres')},true`,
    ].join('\n'));
    expect(await connectableDatabases({ ctx: ctx(), run: s.run })).toEqual([
      { name: 'postgres', owner: 'postgres', superuserOwned: true },
      { name: 'my,db', owner: 'tenant', superuserOwned: false },
      { name: 'sh\nop', owner: 'postgres', superuserOwned: true },
    ]);
    expect(s.sqls[0]).toContain('d.datallowconn');
  });
});

describe('hardenPostgresCluster', () => {
  const DATA = '/var/lib/postgresql/data';
  interface World {
    roles?: string[];
    version?: string;
    members?: Array<[role: string, member: string, grantor: string]>;
    settings?: string;
    settingDbs?: string[];
    /** [name, file, setting, boot_val], in seqno order. */
    files?: Array<[string, string, string, string]>;
    sessionSettings?: Array<[db: string, role: string, name: string]>;
    hba?: string[];
    dataDir?: string;
  }

  function server(w: World) {
    return fake(({ sql }) => {
      if (sql.includes('FROM pg_catalog.pg_roles WHERE rolname <> current_user')) return (w.roles ?? []).map(hex).join('\n');
      if (sql === 'SHOW server_version_num') return w.version ?? '180000';
      if (sql === 'SHOW data_directory') return w.dataDir ?? DATA;
      if (sql.includes('pg_catalog.pg_auth_members')) return (w.members ?? []).map((m) => m.map(hex).join(',')).join('\n');
      if (sql.startsWith('SELECT COUNT(*) FROM pg_catalog.pg_db_role_setting')) return w.settings ?? '0';
      if (sql.includes('unnest(s.setconfig)')) return (w.sessionSettings ?? []).map((r) => r.map((c) => (c ? hex(c) : '')).join(',')).join('\n');
      if (sql.includes('pg_db_role_setting s JOIN')) return (w.settingDbs ?? []).map(hex).join('\n');
      if (sql.includes('pg_file_settings')) return (w.files ?? []).map(([n, f, st, b]) => `${n},${hex(f)},${st ? hex(st) : ''},${b ? hex(b) : ''}`).join('\n');
      if (sql.includes('pg_hba_file_rules')) return (w.hba ?? []).join('\n');
      return undefined;
    });
  }

  it('on a clean server changes nothing and sends no write', async () => {
    const s = server({});
    expect(await hardenPostgresCluster({ ctx: ctx(), run: s.run })).toEqual([]);
    expect(s.sqls.filter((q) => /^(ALTER|REVOKE|SELECT pg_catalog\.pg_reload_conf)/.test(q))).toEqual([]);
    expect(s.calls.some((c) => c.argv[0] === 'sed')).toBe(false);
  });

  it('strips the dangerous attributes from every other role', async () => {
    const s = server({ roles: ['evil', 'we"ird'] });
    const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
    expect(changed).toEqual(['evil is no longer a superuser or role administrator', 'we"ird is no longer a superuser or role administrator']);
    expect(s.sqls).toContain('ALTER ROLE "evil" NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(s.sqls).toContain('ALTER ROLE "we""ird" NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  });

  it('revokes memberships of superuser roles and of the roles that reach outside, per grantor from 16', async () => {
    const s = server({ members: [['pg_execute_server_program', 'evil', 'postgres']], version: '180002' });
    const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
    expect(changed).toEqual(['evil is no longer a member of pg_execute_server_program']);
    expect(s.sqls).toContain('REVOKE "pg_execute_server_program" FROM "evil" GRANTED BY "postgres"');
    expect(s.sqls.find((q) => q.includes('pg_auth_members'))).toContain('r.rolsuper OR r.rolname IN');
  });

  it('before 16 a membership has no grantor to name', async () => {
    const s = server({ members: [['pg_read_server_files', 'evil', 'postgres']], version: '150014' });
    await hardenPostgresCluster({ ctx: ctx(), run: s.run });
    expect(s.sqls).toContain('REVOKE "pg_read_server_files" FROM "evil"');
  });

  it('settings on the platform\'s own role are cleared, per database too', async () => {
    const s = server({ settings: '2', settingDbs: ['shop'] });
    const changed = await hardenPostgresCluster({ ctx: ctx('myapp'), run: s.run });
    expect(changed).toEqual(['cleared the settings on myapp (every platform session started under them)']);
    expect(s.sqls).toContain('ALTER ROLE CURRENT_USER RESET ALL');
    expect(s.sqls).toContain('ALTER ROLE CURRENT_USER IN DATABASE "shop" RESET ALL');
  });

  describe('session settings anyone set', () => {
    it.each([
      [['', 'evil', 'session_preload_libraries'], 'ALTER ROLE "evil" RESET session_preload_libraries', 'reset session_preload_libraries set for evil'],
      [['shop', 'evil', 'role'], 'ALTER ROLE "evil" IN DATABASE "shop" RESET role', 'reset role set for evil in shop'],
      [['shop', '', 'local_preload_libraries'], 'ALTER DATABASE "shop" RESET local_preload_libraries', 'reset local_preload_libraries set for every role in shop'],
      [['', '', 'role'], 'ALTER ROLE ALL RESET role', 'reset role set for every role'],
    ] as const)('%j', async (row, statement, message) => {
      const s = server({ sessionSettings: [[...row] as [string, string, string]] });
      const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(s.sqls).toContain(statement);
      expect(changed).toContain(message);
    });

    it('only those three names are looked for', async () => {
      const s = server({});
      await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      const q = s.sqls.find((x) => x.includes('unnest(s.setconfig)'))!;
      expect(q).toContain("IN ('session_preload_libraries', 'local_preload_libraries', 'role')");
    });
  });

  describe('configuration files', () => {
    const conf = `${DATA}/postgresql.conf`;
    const auto = `${DATA}/postgresql.auto.conf`;

    it('a shell command written in postgresql.conf is overridden with an empty ALTER SYSTEM, then the configuration reloaded', async () => {
      const s = server({ files: [['archive_command', conf, 'cp %p /x', ''], ['restore_command', conf, 'sh -c evil', '']] });
      const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(changed).toEqual([
        "set archive_command back to the server's default (a shell command the server would run)",
        "set restore_command back to the server's default (a shell command the server would run)",
      ]);
      expect(s.sqls).toContain("ALTER SYSTEM SET archive_command = ''");
      expect(s.sqls).toContain("ALTER SYSTEM SET restore_command = ''");
      expect(s.sqls.at(-1)).toBe('SELECT pg_catalog.pg_reload_conf()');
    });

    it('what ALTER SYSTEM itself wrote is RESET, not overridden', async () => {
      const s = server({ files: [['archive_command', auto, 'cp %p /x', '']] });
      await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(s.sqls).toContain('ALTER SYSTEM RESET archive_command');
      expect(s.sqls.some((q) => q.startsWith('ALTER SYSTEM SET'))).toBe(false);
    });

    it('the last entry of a name is the one in force', async () => {
      const s = server({ files: [['archive_command', conf, 'cp %p /x', ''], ['archive_command', auto, '', '']] });
      expect(await hardenPostgresCluster({ ctx: ctx(), run: s.run })).toEqual([]);
      const t = server({ files: [['archive_command', conf, '', ''], ['archive_command', auto, 'evil', '']] });
      expect(await hardenPostgresCluster({ ctx: ctx(), run: t.run })).toHaveLength(1);
    });

    it('a setting that loads code goes back to the default the server booted with', async () => {
      const s = server({ files: [['shared_preload_libraries', conf, '/data/evil.so', 'pg_stat_statements'], ['jit_provider', conf, 'llvmjit', 'llvmjit']] });
      const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(s.sqls).toContain("ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'");
      expect(s.sqls.some((q) => q.startsWith('ALTER SYSTEM') && q.includes('jit_provider'))).toBe(false);
      expect(changed).toEqual(["set shared_preload_libraries back to the server's default (it loaded code or moved the server's files)"]);
    });

    it('a moved hba_file or ident_file goes back into the data directory', async () => {
      const s = server({ files: [['hba_file', conf, '/tmp/evil_hba.conf', ''], ['ident_file', conf, `${DATA}/pg_ident.conf`, '']] });
      await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(s.sqls).toContain(`ALTER SYSTEM SET hba_file = '${DATA}/pg_hba.conf'`);
      expect(s.sqls.some((q) => q.startsWith('ALTER SYSTEM') && q.includes('ident_file'))).toBe(false);
    });

    it('the settings looked for are the command and the loading ones, in file order', async () => {
      const s = server({});
      await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      const q = s.sqls.find((x) => x.includes('pg_file_settings'))!;
      for (const name of ['archive_command', 'archive_cleanup_command', 'restore_command', 'recovery_end_command', 'ssl_passphrase_command',
        'shared_preload_libraries', 'dynamic_library_path', 'jit_provider', 'archive_library', 'hba_file', 'ident_file', 'unix_socket_directories']) {
        expect(q).toContain(`'${name}'`);
      }
      expect(q).toContain('ORDER BY f.seqno');
    });
  });

  describe('pg_hba', () => {
    it('a rule trusting the network is commented out in the file it came from (inside the data directory), then reloaded', async () => {
      const s = server({ hba: [`7,${hex(`${DATA}/pg_hba.conf`)}`] });
      const changed = await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      expect(changed).toEqual(['pg_hba: disabled a rule that trusted the network (pg_hba.conf line 7)']);
      const sed = s.calls.find((c) => c.argv[0] === 'sed')!;
      expect(sed.argv).toEqual(['sed', '-i', '7s/^/# disabled by the platform (trusted the network): /', `${DATA}/pg_hba.conf`]);
      expect(s.sqls.at(-1)).toBe('SELECT pg_catalog.pg_reload_conf()');
    });

    it('a file outside the data directory is never edited', async () => {
      const s = server({ hba: [`7,${hex('/etc/passwd')}`, `8,${hex(`${DATA}/../etc/x`)}`, `9,${hex(`${DATA}x/pg_hba.conf`)}`] });
      expect(await hardenPostgresCluster({ ctx: ctx(), run: s.run })).toEqual([]);
      expect(s.calls.some((c) => c.argv[0] === 'sed')).toBe(false);
    });

    it('a hba row that is not a line number, or a data directory that is not a path, is ignored, never given to sed', async () => {
      const s = server({ hba: [`7;rm,${hex(`${DATA}/pg_hba.conf`)}`, `x,${hex(`${DATA}/x`)}`] });
      expect(await hardenPostgresCluster({ ctx: ctx(), run: s.run })).toEqual([]);
      const t = server({ hba: [`7,${hex('relative/pg_hba.conf')}`], dataDir: 'relative' });
      expect(await hardenPostgresCluster({ ctx: ctx(), run: t.run })).toEqual([]);
      expect(s.calls.concat(t.calls).some((c) => c.argv[0] === 'sed')).toBe(false);
    });

    it('only loopback trust is spared: the rule query excludes 127.0.0.1/::1 host rules and local sockets', async () => {
      const s = server({});
      await hardenPostgresCluster({ ctx: ctx(), run: s.run });
      const q = s.sqls.find((x) => x.includes('pg_hba_file_rules'))!;
      expect(q).toContain("type <> 'local' AND auth_method = 'trust'");
      expect(q).toContain("'127.0.0.1', '::1'");
      expect(q).toContain('file_name'); // 16+
      const old = server({ version: '140010' });
      await hardenPostgresCluster({ ctx: ctx(), run: old.run });
      expect(old.sqls.find((x) => x.includes('pg_hba_file_rules'))).toContain("current_setting('hba_file')");
    });
  });

  it('never modifies the platform\'s own role: it is excluded by name', async () => {
    const s = server({});
    await hardenPostgresCluster({ ctx: ctx(), run: s.run });
    expect(s.sqls[0]).toContain('rolname <> current_user');
    expect(s.sqls[0]).toContain("rolname !~ '^pg_'");
  });
});
