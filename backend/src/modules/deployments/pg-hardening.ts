/**
 * What a tenant could have left on a PostgreSQL instance while its console
 * ran as the superuser — closed before the platform relies on the superuser
 * being its own (db-admin-access.ts). A superuser can make a way back in for
 * later, and every one of these is one:
 *
 *   cluster-wide
 *   - another role with SUPERUSER, CREATEROLE (up to 15 it may grant itself
 *     pg_execute_server_program), REPLICATION or BYPASSRLS;
 *   - membership in the superuser role itself (SET ROLE to it), or in
 *     pg_execute_server_program / pg_read_server_files / pg_write_server_files
 *     (a shell, or any file, as the server) or pg_create_subscription;
 *   - settings on the platform's own role (ALTER ROLE … SET role/search_path):
 *     every platform session would start under them;
 *   - a shell command in the configuration (archive_command, restore_command,
 *     …: ALTER SYSTEM, or the file rewritten by COPY TO) — it runs as the
 *     server's OS user, which the local trust makes the superuser;
 *   - a pg_hba.conf rule that trusts the network;
 *
 *   in each database
 *   - an event trigger: it runs as whoever runs DDL — the platform's
 *     superuser, whenever it does maintenance (from 17 also at login);
 *   - a write grant on a catalog (`GRANT UPDATE ON pg_authid` is SUPERUSER
 *     for the asking) or on a catalog function the server keeps to itself
 *     (pg_read_file, lo_export, pg_reload_conf, …);
 *   - a function in an untrusted language (C, internal, plpython3u, …) made
 *     outside an extension — `LANGUAGE C AS 'libc.so.6', 'system'` is a shell
 *     for whoever may call it — or a file_fdw table (its `program` option is
 *     one);
 *   - anything the superuser owns in a tenant schema: a SECURITY DEFINER
 *     function, a view or a rule runs with its owner's rights;
 *   - a subscription owned by the superuser: it applies changes as the
 *     superuser.
 *
 * Each is undone so that only a superuser could redo it — and the platform's
 * is the only one left.
 */

import { randomBytes } from 'node:crypto';
import { fromHex, outputLines, pgIdent, pgString, pgSuperuser, sh, type Exec } from './db-exec.js';

const hex = (expr: string): string => `pg_catalog.encode(pg_catalog.convert_to(${expr}, 'UTF8'), 'hex')`;

/** Predefined roles that reach outside the database. */
const DANGEROUS_PREDEFINED = ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_create_subscription'];

/** Settings whose value is a shell command the server runs: cleared. */
const COMMAND_SETTINGS = ['archive_command', 'archive_cleanup_command', 'restore_command', 'recovery_end_command', 'ssl_passphrase_command'];

/**
 * Settings that load code or move the server's own files (a library from the
 * data directory, a pg_hba.conf elsewhere): back to the server's default.
 */
const LOADING_SETTINGS = [
  'shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries', 'dynamic_library_path', 'jit_provider',
  'archive_library', 'hba_file', 'ident_file', 'unix_socket_directories',
];

/** Per-role / per-database settings that load code or change who a session is. */
const SESSION_SETTINGS = ['session_preload_libraries', 'local_preload_libraries', 'role'];

async function serverVersionNum(x: Exec): Promise<number> {
  return Number((await sh(x, pgSuperuser(x.ctx, 'SHOW server_version_num'))).trim()) || 0;
}

/** Cluster-wide: roles, memberships, configuration, pg_hba. Returns what changed. */
export async function hardenPostgresCluster(x: Exec): Promise<string[]> {
  const { ctx } = x;
  const changed: string[] = [];
  const roles = outputLines(await sh(x, pgSuperuser(ctx,
    `SELECT ${hex('rolname')} FROM pg_catalog.pg_roles WHERE rolname <> current_user AND rolname !~ '^pg_' AND (rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls)`)))
    .map(fromHex);
  for (const r of roles) {
    await sh(x, pgSuperuser(ctx, `ALTER ROLE ${pgIdent(r)} NOSUPERUSER NOCREATEROLE NOREPLICATION NOBYPASSRLS`));
    changed.push(`${r} is no longer a superuser or role administrator`);
  }

  const v16 = (await serverVersionNum(x)) >= 160000;
  const members = outputLines(await sh(x, pgSuperuser(ctx,
    `SELECT ${hex('r.rolname')} || ',' || ${hex('m.rolname')} || ',' || ${hex('coalesce(g.rolname, current_user)')} FROM pg_catalog.pg_auth_members am`
    + ' JOIN pg_catalog.pg_roles r ON r.oid = am.roleid JOIN pg_catalog.pg_roles m ON m.oid = am.member LEFT JOIN pg_catalog.pg_roles g ON g.oid = am.grantor'
    + ` WHERE (r.rolsuper OR r.rolname IN (${DANGEROUS_PREDEFINED.map(pgString).join(', ')})) AND m.rolname <> current_user`))); // allow-array-binding: literals joined into SQL text for psql, not a drizzle bind
  for (const line of members) {
    const [role, member, grantor] = line.split(',').map(fromHex);
    // From 16 a membership is one per grantor, and REVOKE takes the current user's only.
    await sh(x, pgSuperuser(ctx, `REVOKE ${pgIdent(role)} FROM ${pgIdent(member)}${v16 ? ` GRANTED BY ${pgIdent(grantor)}` : ''}`));
    changed.push(`${member} is no longer a member of ${role}`);
  }

  const settings = (await sh(x, pgSuperuser(ctx,
    'SELECT COUNT(*) FROM pg_catalog.pg_db_role_setting WHERE setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)'))).trim();
  if (settings !== '0') {
    const inDbs = outputLines(await sh(x, pgSuperuser(ctx,
      `SELECT ${hex('d.datname')} FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase`
      + ' WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)'))).map(fromHex);
    await sh(x, pgSuperuser(ctx, 'ALTER ROLE CURRENT_USER RESET ALL'));
    for (const d of inDbs) await sh(x, pgSuperuser(ctx, `ALTER ROLE CURRENT_USER IN DATABASE ${pgIdent(d)} RESET ALL`));
    changed.push(`cleared the settings on ${ctx.rootUsername} (every platform session started under them)`);
  }
  changed.push(...(await clearSessionSettings(x)));
  const reload = await clearFileSettings(x);
  changed.push(...reload);

  changed.push(...(await closeTrustedNetworkRules(x)));
  if (reload.length > 0 || changed.some((c) => c.startsWith('pg_hba'))) await sh(x, pgSuperuser(ctx, 'SELECT pg_catalog.pg_reload_conf()'));
  return changed;
}

/** ALTER ROLE / DATABASE … SET of a SESSION_SETTINGS name, for anyone: reset. */
async function clearSessionSettings(x: Exec): Promise<string[]> {
  const out = await sh(x, pgSuperuser(x.ctx,
    `SELECT ${hex("coalesce(d.datname, '')")} || ',' || ${hex("coalesce(r.rolname, '')")} || ',' || ${hex("split_part(c, '=', 1)")}`
    + ' FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase'
    + ' LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole, LATERAL unnest(s.setconfig) c'
    + ` WHERE split_part(c, '=', 1) IN (${SESSION_SETTINGS.map(pgString).join(', ')})`)); // allow-array-binding: literals joined into SQL text for psql, not a drizzle bind
  const changed: string[] = [];
  for (const line of outputLines(out)) {
    const [db, role, name] = line.split(',').map((c) => (c ? fromHex(c) : ''));
    const stmt = role && db ? `ALTER ROLE ${pgIdent(role)} IN DATABASE ${pgIdent(db)} RESET ${name}`
      : role ? `ALTER ROLE ${pgIdent(role)} RESET ${name}`
      : db ? `ALTER DATABASE ${pgIdent(db)} RESET ${name}`
      : `ALTER ROLE ALL RESET ${name}`;
    await sh(x, pgSuperuser(x.ctx, stmt));
    changed.push(`reset ${name} set for ${role || 'every role'}${db ? ` in ${db}` : ''}`);
  }
  return changed;
}

/**
 * Configuration files: a shell command, or a setting that loads code or moves
 * the server's files. What ALTER SYSTEM wrote goes (RESET); what a rewritten
 * postgresql.conf says is overridden by ALTER SYSTEM with the default.
 * Returns what changed (the caller reloads; restart-only settings apply at the
 * next start).
 */
async function clearFileSettings(x: Exec): Promise<string[]> {
  const names = [...COMMAND_SETTINGS, ...LOADING_SETTINGS];
  const out = await sh(x, pgSuperuser(x.ctx,
    `SELECT f.name || ',' || ${hex("coalesce(f.sourcefile, '')")} || ',' || ${hex("coalesce(f.setting, '')")} || ',' || ${hex("coalesce(s.boot_val, '')")}`
    + ' FROM pg_catalog.pg_file_settings f LEFT JOIN pg_catalog.pg_settings s ON s.name = f.name'
    + ` WHERE f.name IN (${names.map(pgString).join(', ')}) ORDER BY f.seqno`)); // allow-array-binding: literals joined into SQL text for psql, not a drizzle bind
  // The last entry of a name is the one in force.
  const last = new Map<string, { file: string; setting: string; boot: string }>();
  for (const line of outputLines(out)) {
    const [name, file, setting, boot] = line.split(',');
    last.set(name, { file: file ? fromHex(file) : '', setting: setting ? fromHex(setting) : '', boot: boot ? fromHex(boot) : '' });
  }
  const dataDir = (await sh(x, pgSuperuser(x.ctx, 'SHOW data_directory'))).trim();
  const changed: string[] = [];
  for (const [name, e] of last) {
    const isDefault = COMMAND_SETTINGS.includes(name) ? e.setting === ''
      : name === 'hba_file' ? e.setting === `${dataDir}/pg_hba.conf`
      : name === 'ident_file' ? e.setting === `${dataDir}/pg_ident.conf`
      : e.setting === e.boot;
    if (isDefault) continue;
    if (e.file.endsWith('postgresql.auto.conf')) {
      await sh(x, pgSuperuser(x.ctx, `ALTER SYSTEM RESET ${name}`));
    } else {
      const value = COMMAND_SETTINGS.includes(name) ? ''
        : name === 'hba_file' ? `${dataDir}/pg_hba.conf`
        : name === 'ident_file' ? `${dataDir}/pg_ident.conf`
        : e.boot;
      await sh(x, pgSuperuser(x.ctx, `ALTER SYSTEM SET ${name} = ${pgString(value)}`));
    }
    changed.push(`set ${name} back to the server's default (${COMMAND_SETTINGS.includes(name) ? 'a shell command the server would run' : 'it loaded code or moved the server\'s files'})`);
  }
  return changed;
}

/** pg_hba rules trusting anything but the pod's own loopback, commented out. */
async function closeTrustedNetworkRules(x: Exec): Promise<string[]> {
  const v16 = (await serverVersionNum(x)) >= 160000;
  const file = v16 ? 'file_name' : "pg_catalog.current_setting('hba_file')";
  const out = await sh(x, pgSuperuser(x.ctx,
    `SELECT line_number || ',' || ${hex(file)} FROM pg_catalog.pg_hba_file_rules WHERE type <> 'local' AND auth_method = 'trust'`
    + " AND NOT (coalesce(address, '') IN ('127.0.0.1', '::1') AND coalesce(netmask, '') IN ('255.255.255.255', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'))"));
  const changed: string[] = [];
  const dataDir = (await sh(x, pgSuperuser(x.ctx, 'SHOW data_directory'))).trim();
  for (const line of outputLines(out)) {
    const [n, f] = line.split(',');
    const path = fromHex(f);
    // Only the server's own files: never edit a path somewhere else in the pod.
    if (!/^\d+$/.test(n) || !dataDir.startsWith('/') || !path.startsWith(`${dataDir}/`) || path.includes('/../')) continue;
    await sh(x, ['sed', '-i', `${n}s/^/# disabled by the platform (trusted the network): /`, path]);
    changed.push(`pg_hba: disabled a rule that trusted the network (${path.split('/').pop()} line ${n})`);
  }
  return changed;
}

/** Databases the platform's superuser can connect to: every tenant database, postgres and template1. */
export interface ConnectableDatabase { readonly name: string; readonly owner: string; readonly superuserOwned: boolean }

export async function connectableDatabases(x: Exec): Promise<ConnectableDatabase[]> {
  const out = await sh(x, pgSuperuser(x.ctx,
    `SELECT ${hex('d.datname')} || ',' || ${hex('o.rolname')} || ',' || (o.rolname = current_user)::text`
    + ' FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid = d.datdba WHERE d.datallowconn'));
  return outputLines(out).map((l) => {
    const [n, o, owned] = l.split(',');
    return { name: fromHex(n), owner: fromHex(o), superuserOwned: owned === 'true' };
  });
}

/**
 * One database: event triggers, catalog grants, untrusted functions and
 * file_fdw tables, superuser-owned objects (to `owner`), subscriptions. One
 * statement batch, so one exec per database; the changes come back as rows.
 */
export function databaseHardeningSql(owner: string, tag = randomDollarTag(owner)): string {
  if (owner.includes(tag)) throw new Error('the dollar-quote tag occurs in the owner name');
  const to = pgString(owner);
  const ext = (cls: string, oid: string): string =>
    `EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = '${cls}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
  const tenantSchema = (n: string): string => `${n}.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND ${n}.nspname !~ '^pg_'`;
  const roleName = 'CASE WHEN a.grantee = 0 THEN \'PUBLIC\' ELSE pg_catalog.quote_ident((SELECT rolname FROM pg_catalog.pg_roles WHERE oid = a.grantee)) END';
  const notOwnerOrPredefined = '(a.grantee = 0 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles g WHERE g.oid = a.grantee AND g.rolname ~ \'^pg_\'))';
  // DO is not DDL, so no event trigger fires before the first loop disables
  // them all (up to 16 no session setting turns them off); the temp table
  // that carries the changes back is created only after that.
  return `DO ${tag}
DECLARE r record; su oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user); target text := ${to};
  note text; disabled text[] := '{}';
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  FOR r IN SELECT e.evtname FROM pg_catalog.pg_event_trigger e WHERE e.evtenabled <> 'D' AND NOT ${ext('pg_event_trigger', 'e.oid')} LOOP
    EXECUTE pg_catalog.format('ALTER EVENT TRIGGER %I DISABLE', r.evtname);
    disabled := disabled || r.evtname::text;
  END LOOP;
  EXECUTE 'CREATE TEMP TABLE IF NOT EXISTS insula_changes (t text)';
  INSERT INTO pg_temp.insula_changes SELECT pg_catalog.format('disabled the event trigger %s in %s', n, pg_catalog.current_database()) FROM pg_catalog.unnest(disabled) n;
  -- Mappings that let a role connect on without a password (to this server's own trust socket, say).
  FOR r IN SELECT um.srvname, um.usename FROM pg_catalog.pg_user_mappings um WHERE um.umoptions @> ARRAY['password_required=false'] LOOP
    EXECUTE pg_catalog.format('ALTER USER MAPPING FOR %s SERVER %I OPTIONS (SET password_required %L)',
      CASE WHEN r.usename = 'public' THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.usename) END, r.srvname, 'true');
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('the user mapping of %s on %s needs a password again', r.usename, r.srvname));
  END LOOP;
  -- Extension functions the extension keeps to the superuser: dblink's unchecked connects, adminpack.
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS sig, ${roleName} AS who FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_depend d ON d.classid = 'pg_proc'::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = 'e'
           JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid,
           LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           WHERE ((e.extname = 'dblink' AND p.proname LIKE 'dblink\\_connect\\_u%') OR e.extname = 'adminpack') AND a.grantee <> p.proowner LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', r.sig, r.who);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('revoked %s''s grant on %s', r.who, r.sig));
  END LOOP;
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS sig, ${roleName} AS who FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
           LATERAL pg_catalog.aclexplode(p.proacl) a
           WHERE n.nspname IN ('pg_catalog', 'information_schema') AND a.grantee <> p.proowner AND ${notOwnerOrPredefined} LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %s', r.sig, r.who);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('revoked %s''s grant on the server function %s', r.who, r.sig));
  END LOOP;
  FOR r IN SELECT c.oid::pg_catalog.regclass AS rel, a.privilege_type AS priv, ${roleName} AS who FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
           LATERAL pg_catalog.aclexplode(c.relacl) a
           WHERE n.nspname IN ('pg_catalog', 'information_schema') AND a.grantee <> c.relowner AND a.privilege_type <> 'SELECT' AND ${notOwnerOrPredefined}
             AND NOT (c.oid = 'pg_catalog.pg_settings'::pg_catalog.regclass AND a.grantee = 0 AND a.privilege_type = 'UPDATE') LOOP
    EXECUTE pg_catalog.format('REVOKE %s ON TABLE %s FROM %s', r.priv, r.rel, r.who);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('revoked %s''s %s on the catalog %s', r.who, r.priv, r.rel));
  END LOOP;
  FOR r IN SELECT c.oid::pg_catalog.regclass AS rel, t.attname, a.privilege_type AS priv, ${roleName} AS who FROM pg_catalog.pg_attribute t
           JOIN pg_catalog.pg_class c ON c.oid = t.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, LATERAL pg_catalog.aclexplode(t.attacl) a
           WHERE n.nspname IN ('pg_catalog', 'information_schema') AND a.privilege_type <> 'SELECT' LOOP
    EXECUTE pg_catalog.format('REVOKE %s (%I) ON TABLE %s FROM %s', r.priv, r.attname, r.rel, r.who);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('revoked %s''s %s on %s.%s', r.who, r.priv, r.rel, r.attname));
  END LOOP;
  -- Untrusted code: callable by no one but the superuser, which keeps it.
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS sig, p.oid, p.proowner, p.prokind FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_language l ON l.oid = p.prolang JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           -- An aggregate is "internal" too, and as harmless as its functions.
           WHERE NOT l.lanpltrusted AND p.prokind <> 'a' AND ${tenantSchema('n')} AND NOT ${ext('pg_proc', 'p.oid')}
             AND (p.proowner <> su OR p.proacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee <> su)) LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON %s %s FROM PUBLIC', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig);
    FOR note IN SELECT DISTINCT pg_catalog.quote_ident(g.rolname) FROM pg_catalog.pg_proc p2, LATERAL pg_catalog.aclexplode(p2.proacl) a JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
                WHERE p2.oid = r.oid AND a.grantee NOT IN (0, su) LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON %s %s FROM %s', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig, note);
    END LOOP;
    IF r.proowner <> su THEN EXECUTE pg_catalog.format('ALTER ROUTINE %s OWNER TO CURRENT_USER', r.sig); END IF;
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('only the platform may run %s (untrusted code made outside an extension)', r.sig));
  END LOOP;
  FOR r IN SELECT c.oid::pg_catalog.regclass AS rel, c.oid, c.relowner FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_class c ON c.oid = ft.ftrelid
           JOIN pg_catalog.pg_foreign_server s ON s.oid = ft.ftserver JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw
           WHERE w.fdwname = 'file_fdw' AND (c.relowner <> su OR c.relacl IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> su)) LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC', r.rel);
    FOR note IN SELECT DISTINCT pg_catalog.quote_ident(g.rolname) FROM pg_catalog.pg_class c2, LATERAL pg_catalog.aclexplode(c2.relacl) a JOIN pg_catalog.pg_roles g ON g.oid = a.grantee
                WHERE c2.oid = r.oid AND a.grantee NOT IN (0, su) LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %s', r.rel, note);
    END LOOP;
    IF r.relowner <> su THEN EXECUTE pg_catalog.format('ALTER FOREIGN TABLE %s OWNER TO CURRENT_USER', r.rel); END IF;
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('only the platform may read %s (a file_fdw table)', r.rel));
  END LOOP;
  -- What the superuser owns in tenant schemas goes to the tenant.
  FOR r IN SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspowner = su AND ${tenantSchema('n')} AND NOT ${ext('pg_namespace', 'n.oid')} LOOP
    EXECUTE pg_catalog.format('ALTER SCHEMA %I OWNER TO %I', r.nspname, target);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('%s owns the schema %s', target, r.nspname));
  END LOOP;
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relowner = su AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${tenantSchema('n')}
             -- A sequence a table owns moves with its table; an extension's objects stay its own; file_fdw tables stay locked.
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_foreign_table ft JOIN pg_catalog.pg_foreign_server s ON s.oid = ft.ftserver
                             JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw WHERE ft.ftrelid = c.oid AND w.fdwname = 'file_fdw') LOOP
    EXECUTE pg_catalog.format(CASE r.relkind WHEN 'S' THEN 'ALTER SEQUENCE %I.%I OWNER TO %I'
                                   WHEN 'v' THEN 'ALTER VIEW %I.%I OWNER TO %I'
                                   WHEN 'm' THEN 'ALTER MATERIALIZED VIEW %I.%I OWNER TO %I'
                                   WHEN 'f' THEN 'ALTER FOREIGN TABLE %I.%I OWNER TO %I'
                                   ELSE 'ALTER TABLE %I.%I OWNER TO %I' END, r.nspname, r.relname, target);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('%s owns %s.%s', target, r.nspname, r.relname));
  END LOOP;
  FOR r IN SELECT p.oid::pg_catalog.regprocedure AS sig, p.prokind FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
           WHERE p.proowner = su AND (l.lanpltrusted OR p.prokind = 'a') AND ${tenantSchema('n')} AND NOT ${ext('pg_proc', 'p.oid')} LOOP
    EXECUTE pg_catalog.format('ALTER %s %s OWNER TO %I', CASE r.prokind WHEN 'a' THEN 'AGGREGATE' ELSE 'ROUTINE' END, r.sig, target);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('%s owns %s', target, r.sig));
  END LOOP;
  FOR r IN SELECT s.subname FROM pg_catalog.pg_subscription s WHERE s.subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
           AND s.subenabled AND s.subowner = su LOOP
    EXECUTE pg_catalog.format('ALTER SUBSCRIPTION %I DISABLE', r.subname);
    INSERT INTO pg_temp.insula_changes VALUES (pg_catalog.format('disabled the subscription %s (it applied changes as the superuser)', r.subname));
  END LOOP;
END ${tag};
SELECT t FROM pg_temp.insula_changes;`;
}

/** A dollar-quote tag that does not occur in `text`. */
function randomDollarTag(text: string): string {
  let tag = '';
  do tag = `$insula_${randomBytes(6).toString('hex')}$`; while (text.includes(tag));
  return tag;
}

/** Harden one database; objects the superuser owns go to `owner`. Returns what changed. */
export async function hardenPostgresDatabase(x: Exec, database: string, owner: string): Promise<string[]> {
  return outputLines(await sh(x, pgSuperuser(x.ctx, databaseHardeningSql(owner), database)));
}

