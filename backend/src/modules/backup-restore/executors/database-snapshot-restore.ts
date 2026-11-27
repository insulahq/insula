/**
 * Restores databases from their per-database restic snapshots
 * (tenant-bundles/components/database-snapshots.ts).
 *
 * One Job per instance, beside the database, in two containers that share
 * only a directory of named pipes:
 *  - `fetch` (the backup-tools image, a native sidecar) holds the restic
 *    credentials and streams each snapshot's dump into a pipe;
 *  - `restore` (the instance's own image) holds only the tenant
 *    administrator's login and replays the pipe through the database client
 *    over the network. The dump is the tenant's data and objects: it must not
 *    run with more than the tenant holds, and the client that replays it — it
 *    can run shell commands — never sees the backup store's credentials.
 * Nothing is staged on the tenant's volume.
 *
 * Modes (contracts DatabaseRestoreMode):
 *  - replace — into the same-named database; created if it is gone.
 *  - copy    — into a new database the platform creates and hands to the
 *              tenant's administrator; the original is not touched.
 *  - test    — into a scratch database, counted, then dropped.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseRestoreMode } from '@insula/api-contracts';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import {
  createDatabase,
  dropDatabase,
  execInDbPod,
  listDatabases,
  refuseReservedDatabaseName,
  type DbManagerContext,
  type Engine,
  ENGINE_CONFIG,
} from '../../deployments/db-manager.js';
import { mongoResult, mongoRoot, mysqlRoot, mysqlString, pgDbConnInfo, pgIdent, pgSuperuser, sh, type Exec } from '../../deployments/db-exec.js';
import { MYSQL_TENANT_IMPORT_SED } from '../../deployments/import-rewrite.js';
import { dumpIsNewerThanServer, readServerVersion } from '../../deployments/backup-login.js';
import { trustRoutineCreators } from '../../deployments/tenant-admin.js';
import { dumpFileName } from '../../tenant-bundles/components/database-snapshots.js';
import {
  CREDS_MOUNT_PATH,
  LOGIN_MOUNT_PATH,
  NARROW_CONTAINER,
  ONE_LINE_WHY,
  UNPRIVILEGED_POD,
  JOB_DEADLINE_SECONDS,
  databaseImage,
  databaseServiceHost,
  deleteSecret,
  newRunNonce,
  redactRepository,
  runDatabaseJob,
} from '../../tenant-bundles/components/database-job.js';

const RESTORE_COMPONENT_LABEL = 'restore-files';
const PIPE_DIR = '/pipe';

/** One database to bring back. */
export interface SnapshotRestoreRequest {
  /** The database's name in the backup. */
  readonly source: string;
  readonly snapshotId: string;
  /** The server version the backup was taken from, if recorded. */
  readonly serverVersion?: string | null;
  /** copy only: the new database's name. */
  readonly targetName?: string;
}

export interface SnapshotRestoreOutcome {
  readonly restored: ReadonlyArray<{ readonly source: string; readonly target: string; readonly objects: number | null }>;
  readonly failed: ReadonlyArray<{ readonly database: string; readonly error: string }>;
  readonly skipped: readonly string[];
}

/** The default name of a copy: `<name>_restored_<yyyymmddhhmmss>`, from the allowed characters only. */
export function defaultCopyName(source: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let base = source.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(base)) base = `db_${base}`;
  return `${base.slice(0, 63 - '_restored_'.length - stamp.length)}_restored_${stamp}`;
}

/** The fetch side: one snapshot at a time into its pipe, once the restore side has made it. */
export function buildDatabaseFetchScript(): string {
  return [
    'set -u',
    `P=${PIPE_DIR}`,
    // A sidecar that exits is started again: after its work (or a failure it
    // reports), it waits to be stopped with the restore side — and stops
    // at once when asked.
    "trap 'exit 0' TERM",
    'idle() { while :; do sleep 3600 & wait $!; done; }',
    'fail() { printf "%s\\n" "$1" > $P/fetch-failed.tmp; mv $P/fetch-failed.tmp $P/fetch-failed; idle; }',
    // Started again after it died mid-run: what it was streaming is lost.
    '[ ! -e $P/fetch-started ] || fail "the backup reader stopped part-way (restarted)"',
    'touch $P/fetch-started',
    `C=${CREDS_MOUNT_PATH}`,
    'export RESTIC_PASSWORD="$(cat $C/restic_password)"',
    '[ -n "$RESTIC_PASSWORD" ] || fail "restic password missing"',
    'export RESTIC_REPOSITORY="$(cat $C/repo_uri)"',
    'if [ -f $C/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat $C/aws_access_key_id)"; fi',
    'if [ -f $C/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat $C/aws_secret_access_key)"; fi',
    'if [ -f $C/aws_region ]; then export AWS_DEFAULT_REGION="$(cat $C/aws_region)"; fi',
    'i=0',
    'while [ "$i" -lt "$COUNT" ]; do',
    '  eval "snap=\\${SNAP_$i}; file=\\${FILE_$i}"',
    '  w=0',
    '  while [ ! -e $P/$i.ready ]; do [ ! -e $P/abort ] || idle; sleep 1; w=$((w+1)); [ "$w" -lt 900 ] || fail "the restore side never asked for database $i"; done',
    '  touch $P/$i.opening',
    '  restic dump --no-cache "$snap" "/$file" > $P/$i.fifo 2>$P/$i.err',
    '  echo $? > $P/$i.rc.tmp; mv $P/$i.rc.tmp $P/$i.rc',
    '  i=$((i+1))',
    'done',
    'idle',
  ].join('\n');
}

/** The client a restore pipes the dump into, per engine. Reads `$target`, `$conn`, `$src`. */
function restoreParts(engine: Engine): { readonly prelude: string; readonly load: string; readonly count: string } {
  const noTool = (what: string) => `printf "DB_SETUP_FAILED nonce=%s no ${what} in this image\\n" "$NONCE"; exit 1`;
  switch (engine) {
    case 'mariadb':
    case 'mysql':
      return {
        prelude: [
          `printf '[client]\\nuser=%s\\npassword=%s\\nhost=%s\\nport=%s\\n' "$U" "$P" "$SVC_HOST" "$SVC_PORT" > /tmp/my.cnf; chmod 600 /tmp/my.cnf`,
          `CLI=$(command -v ${engine === 'mysql' ? 'mysql' : 'mariadb || command -v mysql'}) || { ${noTool('database client')}; }`,
        ].join('\n'),
        // The same rewrite as a tenant's own import (import-rewrite.ts).
        load: 'sed -E "$IMPORT_SED" | "$CLI" --defaults-extra-file=/tmp/my.cnf --database="$target"',
        count: `"$CLI" --defaults-extra-file=/tmp/my.cnf --database="$target" -N -B -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"`,
      };
    case 'postgresql':
      return {
        prelude: `export PGHOST="$SVC_HOST" PGPORT="$SVC_PORT" PGUSER="$U" PGPASSWORD="$P" PGCONNECT_TIMEOUT=30\ncommand -v pg_restore >/dev/null || { ${noTool('pg_restore')}; }`,
        // One transaction: all of it, or nothing changes. In place, objects
        // keep their owners (the app roles, of which the administrator is a
        // member); a copy or test belongs to the administrator ($OWNER_OPT):
        // the owners' grants on the new database do not exist yet.
        load: 'pg_restore $OWNER_OPT --clean --if-exists --single-transaction --exit-on-error -d "$conn"',
        count: `psql -X -tA -d "$conn" -c "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'"`,
      };
    case 'mongodb':
      return {
        prelude: `printf "password: '%s'\\n" "$P" > /tmp/mongo.yaml; chmod 600 /tmp/mongo.yaml\ncommand -v mongorestore >/dev/null || { ${noTool('mongorestore')}; }`,
        load: 'mongorestore --host "$SVC_HOST" --port "$SVC_PORT" -u "$U" --authenticationDatabase admin --config=/tmp/mongo.yaml --archive --gzip --drop --nsInclude="$src.*" --nsFrom="$src.*" --nsTo="$target.*"',
        count: `sed -n 's/^.*[[:space:]]\\([0-9][0-9]*\\) document(s) restored successfully.*$/\\1/p' /tmp/err | tail -n 1`,
      };
  }
}

/**
 * The restore side. Items come in as COUNT and TARGET_<i>, CONN_<i>, SRC_<i>
 * (read with `eval` on the variable NAME only). For each: make the pipe, say
 * it is ready, replay what arrives, then read how the fetch ended. One result
 * line per item, printed with printf and carrying the run's NONCE:
 * `DB_RESTORED nonce=<n> index=<i> objects=<n>` or
 * `DB_RESTORE_FAIL nonce=<n> index=<i> rc=<rc> reason=<text>`.
 */
export function buildDatabaseRestoreScript(engine: Engine): string {
  const { prelude, load, count } = restoreParts(engine);
  return [
    'set -u',
    `Q=${PIPE_DIR}`,
    'trap "touch $Q/abort" EXIT',
    `U="$(cat ${LOGIN_MOUNT_PATH}/username)"; P="$(cat ${LOGIN_MOUNT_PATH}/password)"`,
    prelude,
    'i=0',
    'while [ "$i" -lt "$COUNT" ]; do',
    '  eval "target=\\${TARGET_$i}; conn=\\${CONN_$i}; src=\\${SRC_$i}"',
    // The fetch is gone: every item left fails, at once.
    '  if [ -e $Q/fetch-failed ]; then why=$(cat $Q/fetch-failed)',
    `    printf 'DB_RESTORE_FAIL nonce=%s index=%s rc=%s reason=%s\\n' "$NONCE" "$i" "fetch" "${ONE_LINE_WHY}"; i=$((i+1)); continue; fi`,
    '  rm -f $Q/$i.fifo; mkfifo $Q/$i.fifo && touch $Q/$i.ready',
    // Opening the pipe waits for its writer: should the fetch fail before it
    // writes, an empty write of our own ends the wait.
    '  ( k=0; while [ ! -e $Q/$i.opening ]; do if [ -e $Q/fetch-failed ] || [ "$k" -ge 900 ]; then : > $Q/$i.fifo; exit 0; fi; sleep 1; k=$((k+1)); done ) &',
    '  dog=$!',
    // A group, so the pipe feeds the whole pipeline (MariaDB/MySQL: the
    // rewrite first), not only its last command.
    `  { ${load}; } < $Q/$i.fifo >/tmp/out 2>/tmp/err`,
    '  rc=$?',
    '  kill $dog 2>/dev/null; wait $dog 2>/dev/null',
    // The fetch ends right after the client read its end (or broke it off).
    '  w=0; while [ ! -e $Q/$i.rc ] && [ ! -e $Q/fetch-failed ] && [ "$w" -lt 300 ]; do sleep 1; w=$((w+1)); done',
    "  drc=$(cat $Q/$i.rc 2>/dev/null | tr -dc '0-9' | cut -c1-4); [ -n \"$drc\" ] || drc=fetch",
    '  if [ "$drc" = 0 ] && [ "$rc" = 0 ]; then',
    `    n=$(${count} 2>/dev/null | tr -dc '0-9' | cut -c1-12)`,
    `    printf 'DB_RESTORED nonce=%s index=%s objects=%s\\n' "$NONCE" "$i" "\${n:--}"`,
    '  else',
    // Whichever side failed first: a fetch that failed starves the client,
    // and a client that failed breaks the fetch's pipe ("broken pipe").
    '    fwhy=$(tail -n 3 $Q/$i.err 2>/dev/null); [ -n "$fwhy" ] || fwhy=$(cat $Q/fetch-failed 2>/dev/null)',
    '    cwhy=$(grep -iE "error|fail|denied" /tmp/err | tail -n 4); [ -n "$cwhy" ] || cwhy=$(tail -n 4 /tmp/err)',
    '    if [ "$drc" != 0 ] && [ -n "$fwhy" ] && ! printf "%s" "$fwhy" | grep -qi "broken pipe"; then why=$fwhy; else why=$cwhy; [ -n "$why" ] || why=$fwhy; fi',
    `    printf 'DB_RESTORE_FAIL nonce=%s index=%s rc=%s reason=%s\\n' "$NONCE" "$i" "$rc/$drc" "${ONE_LINE_WHY}"`,
    '  fi',
    '  i=$((i+1))',
    'done',
    `printf 'DB_ALL_DONE nonce=%s\\n' "$NONCE"`,
  ].join('\n');
}

export type RestoreLineResult =
  | { readonly kind: 'restored'; readonly objects: number | null }
  | { readonly kind: 'failed'; readonly error: string };

/** Only lines carrying this run's nonce, and the first per item. */
export function parseDatabaseRestoreLines(log: string, nonce: string): { readonly results: ReadonlyMap<number, RestoreLineResult>; readonly setupFailed: string | null } {
  const results = new Map<number, RestoreLineResult>();
  let setupFailed: string | null = null;
  const n = nonce.replace(/[^0-9a-f]/g, '');
  for (const line of log.split('\n')) {
    const ok = new RegExp(`^DB_RESTORED nonce=${n} index=(\\d+) objects=(\\d+|-)$`).exec(line);
    if (ok) { if (!results.has(Number(ok[1]))) results.set(Number(ok[1]), { kind: 'restored', objects: ok[2] === '-' ? null : Number(ok[2]) }); continue; }
    const failed = new RegExp(`^DB_RESTORE_FAIL nonce=${n} index=(\\d+) rc=(\\S+) reason=(.*)$`).exec(line);
    if (failed) { if (!results.has(Number(failed[1]))) results.set(Number(failed[1]), { kind: 'failed', error: (failed[3] ?? '').trim() || `the restore exited ${failed[2]}` }); continue; }
    const setup = new RegExp(`^DB_SETUP_FAILED nonce=${n} (.*)$`).exec(line);
    if (setup) setupFailed ??= setup[1]!.trim();
  }
  return { results, setupFailed };
}

export interface RestoreJobItem {
  readonly snapshotId: string;
  readonly fileName: string;
  readonly target: string;
  readonly source: string;
}

export interface DatabaseRestoreJobInput {
  readonly jobName: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly restoreId: string;
  readonly deploymentId: string;
  readonly engine: Engine;
  readonly image: string;
  readonly toolsImage: string;
  readonly serviceHost: string;
  readonly servicePort: number;
  readonly credsSecretName: string;
  readonly loginSecretName: string;
  readonly mode: DatabaseRestoreMode;
  readonly items: readonly RestoreJobItem[];
  readonly nonce: string;
  /** Node constraint and priority class (database-job.ts databaseJobPlacement). */
  readonly placement: Readonly<Record<string, unknown>>;
}

export function buildDatabaseRestoreJobSpec(input: DatabaseRestoreJobInput): Record<string, unknown> {
  const labels = {
    // The tenant's egress policy lets restore Jobs reach the backup store.
    'platform.io/component': RESTORE_COMPONENT_LABEL,
    'platform.io/tenant-id': input.tenantId,
    'platform.io/restore-id': input.restoreId.slice(0, 63),
    'platform.io/restore-databases': input.deploymentId,
  };
  const count = { name: 'COUNT', value: String(input.items.length) };
  const fetchEnv = [
    count,
    { name: 'HOME', value: '/tmp' },
    { name: 'TMPDIR', value: '/tmp' },
    ...input.items.flatMap((it, i) => [{ name: `SNAP_${i}`, value: it.snapshotId }, { name: `FILE_${i}`, value: it.fileName }]),
  ];
  const restoreEnv = [
    count,
    { name: 'SVC_HOST', value: input.serviceHost },
    { name: 'SVC_PORT', value: String(input.servicePort) },
    { name: 'NONCE', value: input.nonce },
    { name: 'IMPORT_SED', value: MYSQL_TENANT_IMPORT_SED },
    { name: 'OWNER_OPT', value: input.mode === 'replace' ? '' : '--no-owner' },
    { name: 'HOME', value: '/tmp' },
    { name: 'TMPDIR', value: '/tmp' },
    ...input.items.flatMap((it, i) => [
      { name: `TARGET_${i}`, value: it.target },
      { name: `CONN_${i}`, value: pgDbConnInfo(it.target) },
      { name: `SRC_${i}`, value: it.source },
    ]),
  ];
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.jobName, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: JOB_DEADLINE_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          // The tenant's node, outside the tenant's quota.
          ...input.placement,
          securityContext: UNPRIVILEGED_POD,
          // A native sidecar: stopped when the restore side is done, so a
          // restore side that died never leaves the fetch waiting on a pipe.
          initContainers: [{
            name: 'fetch',
            image: input.toolsImage,
            imagePullPolicy: 'IfNotPresent',
            restartPolicy: 'Always',
            command: ['sh', '-c', buildDatabaseFetchScript()],
            env: fetchEnv,
            securityContext: NARROW_CONTAINER,
            resources: { requests: { cpu: '20m', memory: '64Mi' }, limits: { memory: '512Mi' } },
            volumeMounts: [
              { name: 'pipe', mountPath: PIPE_DIR },
              { name: 'fetch-tmp', mountPath: '/tmp' },
              { name: 'restic-creds', mountPath: CREDS_MOUNT_PATH, readOnly: true },
            ],
          }],
          containers: [{
            name: 'restore',
            image: input.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', buildDatabaseRestoreScript(input.engine)],
            env: restoreEnv,
            securityContext: NARROW_CONTAINER,
            resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '1Gi' } },
            volumeMounts: [
              { name: 'pipe', mountPath: PIPE_DIR },
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'db-login', mountPath: LOGIN_MOUNT_PATH, readOnly: true },
            ],
          }],
          volumes: [
            { name: 'pipe', emptyDir: { sizeLimit: '16Mi' } },
            { name: 'fetch-tmp', emptyDir: { sizeLimit: '256Mi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
            { name: 'restic-creds', secret: { secretName: input.credsSecretName, defaultMode: 0o440 } },
            { name: 'db-login', secret: { secretName: input.loginSecretName, defaultMode: 0o440 } },
          ],
        },
      },
    },
  };
}

export interface RestoreInstanceArgs {
  readonly k8s: K8sClients;
  readonly ctx: DbManagerContext;
  readonly namespace: string;
  readonly tenantId: string;
  readonly restoreId: string;
  readonly deploymentId: string;
  readonly mode: DatabaseRestoreMode;
  readonly requests: readonly SnapshotRestoreRequest[];
  /** The tenant's administrator on this instance. */
  readonly login: { readonly username: string; readonly password: string };
  readonly toolsImage: string;
  /** restic credentials for the bundle's repository (buildResticCredsStringData). */
  readonly resticCreds: Readonly<Record<string, string>>;
  readonly placement: Readonly<Record<string, unknown>>;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

/**
 * The tables (collections) in `database`, counted as root: what a restore
 * reports comes from the server, not from the client that ran the dump. Null
 * when it cannot be read.
 */
async function countObjects(x: Exec, database: string): Promise<number | null> {
  const asCount = (out: string): number | null => {
    const n = out.trim().split('\n').pop()?.trim() ?? '';
    return /^\d+$/.test(n) ? Number(n) : null;
  };
  try {
    switch (x.ctx.engine) {
      case 'mariadb':
      case 'mysql':
        return asCount(await sh(x, mysqlRoot(x.ctx, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${mysqlString(database)}`)));
      case 'postgresql':
        return asCount(await sh(x, pgSuperuser(x.ctx,
          "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'",
          database)));
      case 'mongodb':
        return asCount(mongoResult(await sh(x, mongoRoot(x.ctx, `db.getSiblingDB(${JSON.stringify(database)}).getCollectionNames().length`))));
    }
  } catch {
    return null;
  }
}

/** Hands a database the platform created to the tenant's administrator (PostgreSQL owns by database; the others grant on create). */
async function handToTenantAdmin(x: Exec, database: string, admin: string): Promise<void> {
  if (x.ctx.engine !== 'postgresql') return;
  await sh(x, pgSuperuser(x.ctx, `ALTER DATABASE ${pgIdent(database)} OWNER TO ${pgIdent(admin)}`));
}

interface PreparedItem extends RestoreJobItem {
  /** The platform made the target for this restore: it goes again when the restore leaves nothing usable in it. */
  readonly created: boolean;
}

/** What each request restores into, and the targets the platform makes first. Never touches an original. */
async function prepareTargets(
  args: RestoreInstanceArgs,
  x: Exec,
  failed: Array<{ database: string; error: string }>,
  skipped: string[],
): Promise<PreparedItem[]> {
  const { ctx, mode } = args;
  const serverVersion = await readServerVersion(x).catch(() => '');
  const existing = new Set((await listDatabases(ctx)).map((d) => d.name));
  const items: PreparedItem[] = [];
  for (const r of args.requests) {
    if (r.serverVersion && serverVersion && dumpIsNewerThanServer(ctx.engine, r.serverVersion, serverVersion)) {
      failed.push({ database: r.source, error: `the backup is from ${r.serverVersion}, newer than this server (${serverVersion}): update the instance, then restore` });
      continue;
    }
    if (!/^[0-9a-f]{8,64}$/.test(r.snapshotId)) {
      failed.push({ database: r.source, error: 'the backup has no valid snapshot id' });
      continue;
    }
    if (ctx.engine === 'mongodb' && /[*\\]/.test(r.source)) {
      failed.push({ database: r.source, error: 'a MongoDB database whose name holds * or \\ cannot be restored by name' });
      continue;
    }
    const target = mode === 'replace' ? r.source : mode === 'copy' ? (r.targetName ?? defaultCopyName(r.source)) : `restoretest_${randomBytes(4).toString('hex')}`;
    try {
      // The engines' own databases hold the server's accounts: never a target.
      refuseReservedDatabaseName(ctx.engine, target);
    } catch {
      failed.push({ database: r.source, error: `${target} is one of the server's own databases and cannot be restored into` });
      continue;
    }
    if (mode !== 'replace' && existing.has(target)) {
      failed.push({ database: r.source, error: `a database named ${target} exists already: choose another name` });
      continue;
    }
    // MongoDB makes a database on its first write, so a target that is not
    // there yet is the restore's own all the same.
    let created = !existing.has(target) && ctx.engine === 'mongodb';
    if (!existing.has(target) && ctx.engine !== 'mongodb') {
      try {
        await createDatabase(ctx, target);
        created = true;
        await handToTenantAdmin(x, target, args.login.username);
      } catch (err) {
        if (created) await dropDatabase(ctx, target).catch(() => undefined);
        const why = (err as Error).message.slice(0, 200);
        if (mode === 'replace') skipped.push(`database '${r.source}' is gone and could not be created again (${why}): create it, then restore`);
        else failed.push({ database: r.source, error: `the database ${target} could not be created: ${why}` });
        continue;
      }
    }
    items.push({ snapshotId: r.snapshotId, fileName: dumpFileName(ctx.engine, r.source), target, source: r.source, created });
  }
  return items;
}

/** Restores the requested databases of one instance. Throws only on a setup error before any database was touched. */
export async function restoreInstanceFromSnapshots(args: RestoreInstanceArgs): Promise<SnapshotRestoreOutcome> {
  const { ctx, mode } = args;
  const x: Exec = { ctx, run: execInDbPod };
  const restored: Array<{ source: string; target: string; objects: number | null }> = [];
  const failed: Array<{ database: string; error: string }> = [];
  const skipped: string[] = [];
  const redact = (s: string): string => redactRepository(s, args.resticCreds.repo_uri);

  const items = await prepareTargets(args, x, failed, skipped);
  if (items.length === 0) return { restored, failed, skipped };
  // A dump's routines and triggers load as the tenant administrator.
  if (ctx.engine === 'mysql' || ctx.engine === 'mariadb') await trustRoutineCreators(x).catch(() => []);

  const short = `${args.restoreId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8)}-${args.deploymentId.replace(/-/g, '').slice(0, 8)}-${randomBytes(2).toString('hex')}`;
  const jobName = `rs-db-${short}`.slice(0, 63);
  const credsSecretName = `rs-db-creds-${short}`.slice(0, 63);
  const loginSecretName = `rs-db-login-${short}`.slice(0, 63);
  try {
    const [image, serviceHost] = await Promise.all([databaseImage(args.k8s, ctx), databaseServiceHost(args.k8s, ctx)]);
    const nonce = newRunNonce();
    if (args.onProgress) await args.onProgress(`restoring ${items.length} database(s) of ${ctx.podName.replace(/-[a-z0-9]+-[a-z0-9]+$/, '')}…`);
    const run = await runDatabaseJob({
      k8s: args.k8s,
      namespace: args.namespace,
      jobName,
      spec: buildDatabaseRestoreJobSpec({
        jobName, namespace: args.namespace, tenantId: args.tenantId, restoreId: args.restoreId, deploymentId: args.deploymentId,
        engine: ctx.engine, image, toolsImage: args.toolsImage, serviceHost, servicePort: ENGINE_CONFIG[ctx.engine].port,
        credsSecretName, loginSecretName, mode, items, nonce, placement: args.placement,
      }),
      secrets: [
        { name: credsSecretName, data: args.resticCreds },
        { name: loginSecretName, data: { username: args.login.username, password: args.login.password } },
      ],
      labels: { 'platform.io/component': RESTORE_COMPONENT_LABEL, 'platform.io/restore-id': args.restoreId.slice(0, 63) },
      container: 'restore',
      tailLines: Math.max(200, items.length * 4 + 50),
    });
    const parsed = parseDatabaseRestoreLines(run.log, nonce);
    for (const [i, it] of items.entries()) {
      const r = parsed.results.get(i);
      if (r?.kind === 'restored') restored.push({ source: it.source, target: it.target, objects: (await countObjects(x, it.target)) ?? r.objects });
      else failed.push({ database: it.source, error: redact(r?.kind === 'failed' ? r.error : parsed.setupFailed ?? (run.outcome === 'failed' ? 'the restore Job failed before this database' : 'no result for this database')) });
    }
  } catch (err) {
    for (const it of items) {
      if (!restored.some((r) => r.source === it.source) && !failed.some((f) => f.database === it.source)) failed.push({ database: it.source, error: redact((err as Error).message) });
    }
  } finally {
    await deleteSecret(args.k8s, args.namespace, credsSecretName);
    await deleteSecret(args.k8s, args.namespace, loginSecretName);
    // A test restore leaves nothing; a copy that failed leaves no half-made database.
    for (const it of items) {
      const failedCopy = mode === 'copy' && it.created && !restored.some((r) => r.target === it.target);
      if (mode !== 'test' && !failedCopy) continue;
      await dropDatabase(ctx, it.target).catch((err: Error) => {
        failed.push({ database: it.source, error: `the ${mode === 'test' ? 'scratch' : 'unfinished'} database ${it.target} could not be dropped (${err.message.slice(0, 160)}): drop it by hand` });
      });
    }
  }
  return { restored, failed, skipped };
}
