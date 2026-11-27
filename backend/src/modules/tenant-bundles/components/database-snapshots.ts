/**
 * Per-database restic snapshots (phase 4 of the database backup work).
 *
 * Replaces the pre-dumps that were written into each instance's folder on the
 * tenant volume and carried by the files snapshot. For every standalone
 * database instance the bundle runs one Job in the tenant's namespace:
 *
 *  - an init container copies restic from the backup-tools image into an
 *    emptyDir;
 *  - the main container is the instance's own image (so the dump client is the
 *    server's version) and, for each database, runs
 *    `restic backup --stdin-from-command -- <engine's dump>`: the dump streams
 *    straight into the repository, nothing is staged on the volume, and a dump
 *    that fails saves no snapshot at all. The dump client runs without the
 *    restic credentials in its environment;
 *  - it connects to the instance's Service over the network (tenant pods may)
 *    with a login minted for this run (deployments/backup-login.ts), dropped
 *    when the run ends.
 *
 * One snapshot per database, tagged with the tenant, bundle, deployment,
 * database (hex), engine and server version, recorded as a `databases`
 * component row per database (artifact `<deploymentId>:<database>`).
 */
import { eq, and, isNull, notInArray } from 'drizzle-orm';
import type { BackupDatabaseDumps } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { catalogEntries, deployments } from '../../../db/schema.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { buildDbContext, execInDbPod, listDatabases, ENGINE_CONFIG, type DbManagerContext, type Engine } from '../../deployments/db-manager.js';
import { dropBackupLogin, mintBackupLogin } from '../../deployments/backup-login.js';
import { pgDbConnInfo, type Exec } from '../../deployments/db-exec.js';
import {
  CREDS_MOUNT_PATH,
  LOGIN_MOUNT_PATH,
  NARROW_CONTAINER,
  ONE_LINE_WHY,
  RESTIC_ENV_SH,
  UNPRIVILEGED_POD,
  WITHOUT_RESTIC_ENV,
  JOB_DEADLINE_SECONDS,
  databaseImage,
  databaseServiceHost,
  deleteSecret,
  newRunNonce,
  redactRepository,
  runDatabaseJob,
} from './database-job.js';

export const DATABASE_JOB_COMPONENT_LABEL = 'backup-files';
/** Instances backed up at once per tenant. */
const PARALLEL_INSTANCES = 2;

export interface DatabaseSnapshotResult {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly namespace: string;
  readonly engine: Engine | null;
  readonly serverVersion: string | null;
  readonly databaseDumps: ReadonlyArray<{ readonly database: string; readonly snapshotId: string; readonly sizeBytes: number; readonly addedBytes?: number | null }>;
  readonly databaseFailures: ReadonlyArray<{ readonly database: string; readonly error: string; readonly benign: boolean }>;
  /** The instance as a whole could not be backed up (not running, login refused, Job failed to start…). */
  readonly error?: string;
  readonly durationMs: number;
}

/** A restic tag value: no comma (the tag separator) and nothing a shell or log line would trip over. */
export function tagValue(v: string): string {
  return v.replace(/[^A-Za-z0-9._+:-]/g, '_').slice(0, 120);
}

export function hexName(name: string): string {
  return Buffer.from(name, 'utf8').toString('hex');
}

/** The file name a database's dump has inside its snapshot. */
export function dumpFileName(engine: Engine, database: string): string {
  const ext = engine === 'postgresql' ? 'pgdump' : engine === 'mongodb' ? 'archive.gz' : 'sql';
  return `${hexName(database)}.${ext}`;
}

/** Per engine: write the client's credentials, and the dump command (reads `$db`). */
function engineParts(engine: Engine): { readonly prelude: string; readonly dump: string } {
  const noTool = 'printf "DB_SETUP_FAILED nonce=%s no dump tool in this image\\n" "$NONCE"; exit 1';
  switch (engine) {
    case 'mariadb':
    case 'mysql':
      return {
        prelude: [
          `printf '[client]\\nuser=%s\\npassword=%s\\nhost=%s\\nport=%s\\n' "$U" "$P" "$SVC_HOST" "$SVC_PORT" > /tmp/my.cnf; chmod 600 /tmp/my.cnf`,
          `DUMP=$(command -v ${engine === 'mysql' ? 'mysqldump' : 'mariadb-dump || command -v mysqldump'}) || { ${noTool}; }`,
        ].join('\n'),
        dump: `"$DUMP" --defaults-extra-file=/tmp/my.cnf --single-transaction --quick --routines --triggers --events --hex-blob --no-tablespaces${engine === 'mysql' ? ' --set-gtid-purged=OFF' : ''} -- "$db"`,
      };
    case 'postgresql':
      return {
        prelude: `export PGHOST="$SVC_HOST" PGPORT="$SVC_PORT" PGUSER="$U" PGPASSWORD="$P" PGCONNECT_TIMEOUT=30\ncommand -v pg_dump >/dev/null || { ${noTool}; }`,
        // The name as a quoted conninfo (DB_CONN_<i>), never a bare argument.
        dump: 'pg_dump -Fc -d "$conn"',
      };
    case 'mongodb':
      return {
        prelude: `printf "password: '%s'\\n" "$P" > /tmp/mongo.yaml; chmod 600 /tmp/mongo.yaml\ncommand -v mongodump >/dev/null || { ${noTool}; }`,
        dump: 'mongodump --quiet --host "$SVC_HOST" --port "$SVC_PORT" -u "$U" --authenticationDatabase admin --config=/tmp/mongo.yaml --db "$db" --archive --gzip',
      };
  }
}

/**
 * The Job's script. Databases come in as DB_COUNT and DB_<i> / DB_HEX_<i>
 * environment values (read with `eval` on the variable NAME only — a value is
 * never evaluated). One result line per database, printed with printf (no
 * escape in the text is expanded) and carrying the run's NONCE:
 * `DB_DONE nonce=<n> index=<i> snapshot=<id> bytes=<n>` or
 * `DB_FAIL nonce=<n> index=<i> rc=<rc> reason=<text>`.
 */
export function buildDatabaseBackupScript(engine: Engine): string {
  const { prelude, dump } = engineParts(engine);
  const ext = engine === 'postgresql' ? 'pgdump' : engine === 'mongodb' ? 'archive.gz' : 'sql';
  return [
    'set -u',
    RESTIC_ENV_SH,
    `U="$(cat ${LOGIN_MOUNT_PATH}/username)"; P="$(cat ${LOGIN_MOUNT_PATH}/password)"`,
    'R=/tools/restic',
    '"$R" version >/dev/null 2>&1 || { printf "DB_SETUP_FAILED nonce=%s restic cannot run in this image\\n" "$NONCE"; exit 1; }',
    prelude,
    'i=0',
    'while [ "$i" -lt "$DB_COUNT" ]; do',
    '  eval "db=\\${DB_$i}; hex=\\${DB_HEX_$i}; conn=\\${DB_CONN_$i}"',
    `  out=$("$R" backup --json --no-cache --host "$TENANT_ID" --compression auto --option s3.connections=5 --tag "$TAGS" --tag "deployment-id=$DEPLOYMENT_ID,db-hex=$hex,engine=$ENGINE,server-version=$SERVER_VERSION" --stdin-filename "$hex.${ext}" --stdin-from-command -- ${WITHOUT_RESTIC_ENV} ${dump} 2>/tmp/err)`,
    '  rc=$?',
    `  snap=$(printf '%s\\n' "$out" | grep '"message_type":"summary"' | sed -n 's/.*"snapshot_id":"\\([0-9a-f]*\\)".*/\\1/p' | tail -n 1)`,
    `  bytes=$(printf '%s\\n' "$out" | grep '"message_type":"summary"' | sed -n 's/.*"total_bytes_processed":\\([0-9]*\\).*/\\1/p' | tail -n 1)`,
    `  added=$(printf '%s\\n' "$out" | grep '"message_type":"summary"' | sed -n 's/.*"data_added_packed":\\([0-9]*\\).*/\\1/p' | tail -n 1)`,
    '  if [ "$rc" = 0 ] && [ -n "$snap" ]; then',
    `    printf 'DB_DONE nonce=%s index=%s snapshot=%s bytes=%s added=%s\\n' "$NONCE" "$i" "$snap" "\${bytes:-0}" "\${added:--}"`,
    '  else',
    '    why=$(tail -n 4 /tmp/err)',
    `    printf 'DB_FAIL nonce=%s index=%s rc=%s reason=%s\\n' "$NONCE" "$i" "$rc" "${ONE_LINE_WHY}"`,
    '  fi',
    '  i=$((i+1))',
    'done',
    `printf 'DB_ALL_DONE nonce=%s\\n' "$NONCE"`,
  ].join('\n');
}

export type DatabaseLineResult =
  | { readonly kind: 'done'; readonly snapshotId: string; readonly sizeBytes: number; readonly addedBytes: number | null }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * Reads the Job's result lines — only those carrying this run's nonce, and
 * the first one per database. An index with no line has no result (the Job
 * died first).
 */
export function parseDatabaseBackupLines(log: string, nonce: string): { readonly results: ReadonlyMap<number, DatabaseLineResult>; readonly setupFailed: string | null; readonly finished: boolean } {
  const results = new Map<number, DatabaseLineResult>();
  let setupFailed: string | null = null;
  let finished = false;
  const n = nonce.replace(/[^0-9a-f]/g, '');
  for (const line of log.split('\n')) {
    const done = new RegExp(`^DB_DONE nonce=${n} index=(\\d+) snapshot=([0-9a-f]{8,64}) bytes=(\\d+) added=(\\d+|-)$`).exec(line);
    if (done) {
      if (!results.has(Number(done[1]))) results.set(Number(done[1]), { kind: 'done', snapshotId: done[2]!, sizeBytes: Number(done[3]), addedBytes: done[4] === '-' ? null : Number(done[4]) });
      continue;
    }
    const failed = new RegExp(`^DB_FAIL nonce=${n} index=(\\d+) rc=(\\d+) reason=(.*)$`).exec(line);
    if (failed) { if (!results.has(Number(failed[1]))) results.set(Number(failed[1]), { kind: 'failed', error: (failed[3] ?? '').trim() || `the dump exited ${failed[2]}` }); continue; }
    const setup = new RegExp(`^DB_SETUP_FAILED nonce=${n} (.*)$`).exec(line);
    if (setup) { setupFailed ??= setup[1]!.trim(); continue; }
    if (line.trim() === `DB_ALL_DONE nonce=${n}`) finished = true;
  }
  return { results, setupFailed, finished };
}

export interface DatabaseBackupJobInput {
  readonly jobName: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly bundleId: string;
  readonly deploymentId: string;
  readonly engine: Engine;
  readonly image: string;
  readonly toolsImage: string;
  readonly serviceHost: string;
  readonly servicePort: number;
  readonly credsSecretName: string;
  readonly loginSecretName: string;
  readonly databases: readonly string[];
  readonly tags: readonly string[];
  readonly serverVersion: string;
  readonly nonce: string;
  /** Node constraint and priority class (database-job.ts databaseJobPlacement). */
  readonly placement: Readonly<Record<string, unknown>>;
}

export function buildDatabaseBackupJobSpec(input: DatabaseBackupJobInput): Record<string, unknown> {
  const labels = {
    // Reuses the files Job's label: the tenant's egress policy lets exactly
    // these reach the backup store (allow-backup-jobs-egress).
    'platform.io/component': DATABASE_JOB_COMPONENT_LABEL,
    'platform.io/tenant-id': input.tenantId,
    'platform.io/backup-id': input.bundleId.slice(0, 63),
    'platform.io/backup-databases': input.deploymentId,
  };
  const env = [
    { name: 'TENANT_ID', value: input.tenantId },
    { name: 'DEPLOYMENT_ID', value: input.deploymentId },
    { name: 'ENGINE', value: input.engine },
    { name: 'SERVER_VERSION', value: tagValue(input.serverVersion) },
    { name: 'TAGS', value: input.tags.join(',') },
    { name: 'SVC_HOST', value: input.serviceHost },
    { name: 'SVC_PORT', value: String(input.servicePort) },
    { name: 'DB_COUNT', value: String(input.databases.length) },
    { name: 'NONCE', value: input.nonce },
    { name: 'HOME', value: '/tmp' },
    { name: 'TMPDIR', value: '/tmp' },
    ...input.databases.flatMap((d, i) => [{ name: `DB_${i}`, value: d }, { name: `DB_HEX_${i}`, value: hexName(d) }, { name: `DB_CONN_${i}`, value: pgDbConnInfo(d) }]),
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
          initContainers: [{
            name: 'restic',
            image: input.toolsImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', 'cp /usr/bin/restic /tools/restic.tmp && chmod 0555 /tools/restic.tmp && mv -f /tools/restic.tmp /tools/restic'],
            securityContext: NARROW_CONTAINER,
            resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '64Mi' } },
            volumeMounts: [{ name: 'tools', mountPath: '/tools' }],
          }],
          containers: [{
            name: 'dump',
            image: input.image,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', buildDatabaseBackupScript(input.engine)],
            env,
            securityContext: NARROW_CONTAINER,
            resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '1Gi' } },
            volumeMounts: [
              { name: 'tools', mountPath: '/tools', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
              { name: 'restic-creds', mountPath: CREDS_MOUNT_PATH, readOnly: true },
              { name: 'db-login', mountPath: LOGIN_MOUNT_PATH, readOnly: true },
            ],
          }],
          volumes: [
            { name: 'tools', emptyDir: { sizeLimit: '128Mi' } },
            // restic stages its packs in TMPDIR before upload (as the files Job does).
            { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } },
            { name: 'restic-creds', secret: { secretName: input.credsSecretName, defaultMode: 0o440 } },
            { name: 'db-login', secret: { secretName: input.loginSecretName, defaultMode: 0o440 } },
          ],
        },
      },
    },
  };
}

export interface SnapshotInstanceArgs {
  readonly k8s: K8sClients;
  readonly kubeconfigPath?: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly bundleId: string;
  readonly toolsImage: string;
  readonly tags: readonly string[];
  /** restic credentials for the Job (buildResticCredsStringData). */
  readonly resticCreds: Readonly<Record<string, string>>;
  readonly placement: Readonly<Record<string, unknown>>;
  /** Holds a cluster-wide backup slot while the Job runs. */
  readonly withSlot: <T>(run: () => Promise<T>) => Promise<T>;
}

export interface InstanceRow {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly catalogCode: string;
  readonly catalogRuntime: string | null;
  readonly configuration: Record<string, unknown>;
}

/** What the Job's lines say per database. */
function mapResults(
  databases: readonly string[],
  parsed: ReturnType<typeof parseDatabaseBackupLines>,
  outcome: 'complete' | 'failed',
  redact: (s: string) => string,
): { dumps: Array<{ database: string; snapshotId: string; sizeBytes: number; addedBytes: number | null }>; failures: Array<{ database: string; error: string; benign: boolean }> } {
  const dumps: Array<{ database: string; snapshotId: string; sizeBytes: number; addedBytes: number | null }> = [];
  const failures: Array<{ database: string; error: string; benign: boolean }> = [];
  databases.forEach((database, i) => {
    const r = parsed.results.get(i);
    if (r?.kind === 'done') dumps.push({ database, snapshotId: r.snapshotId, sizeBytes: r.sizeBytes, addedBytes: r.addedBytes });
    else failures.push({ database, benign: false, error: redact(r?.kind === 'failed' ? r.error : parsed.setupFailed ?? (outcome === 'failed' ? 'the backup Job failed before this database' : 'no result for this database')) });
  });
  return { dumps, failures };
}

/** Backs up every database of one instance; never throws (an error is in the result). */
export async function snapshotInstanceDatabases(args: SnapshotInstanceArgs, inst: InstanceRow): Promise<DatabaseSnapshotResult> {
  const started = Date.now();
  const base = { deploymentId: inst.deploymentId, deploymentName: inst.deploymentName, namespace: args.namespace };
  const result = (over: Partial<DatabaseSnapshotResult>): DatabaseSnapshotResult => ({
    ...base, engine: null, serverVersion: null, databaseDumps: [], databaseFailures: [], ...over, durationMs: Date.now() - started,
  });
  const redact = (s: string): string => redactRepository(s, args.resticCreds.repo_uri);
  let ctx: DbManagerContext;
  try {
    ctx = await buildDbContext(args.k8s, args.kubeconfigPath, args.namespace, inst.deploymentName,
      { runtime: inst.catalogRuntime, code: inst.catalogCode }, inst.configuration);
  } catch (err) {
    return result({ error: `the database could not be reached: ${(err as Error).message}` });
  }
  const engine = ctx.engine;
  const x: Exec = { ctx, run: execInDbPod };
  let databases: string[];
  try {
    databases = (await listDatabases(ctx)).map((d) => d.name);
  } catch (err) {
    return result({ engine, error: `its databases could not be listed: ${(err as Error).message}` });
  }
  if (databases.length === 0) return result({ engine });

  const short = `${args.bundleId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-10)}-${inst.deploymentId.replace(/-/g, '').slice(0, 10)}`;
  const jobName = `bk-db-${short}`.slice(0, 63);
  const credsSecretName = `bk-db-creds-${short}`.slice(0, 63);
  const loginSecretName = `bk-db-login-${short}`.slice(0, 63);
  let login: Awaited<ReturnType<typeof mintBackupLogin>> | null = null;
  try {
    const [image, serviceHost] = await Promise.all([databaseImage(args.k8s, ctx), databaseServiceHost(args.k8s, ctx)]);
    const nonce = newRunNonce();
    // The login lives only while a slot is held: its age stays within the Job's deadline.
    const run = await args.withSlot(async () => {
      login = await mintBackupLogin(x, databases);
      return runDatabaseJob({
        k8s: args.k8s,
        namespace: args.namespace,
        jobName,
        spec: buildDatabaseBackupJobSpec({
          jobName, namespace: args.namespace, tenantId: args.tenantId, bundleId: args.bundleId, deploymentId: inst.deploymentId,
          engine, image, toolsImage: args.toolsImage, serviceHost, servicePort: ENGINE_CONFIG[engine].port,
          credsSecretName, loginSecretName, databases, tags: args.tags, serverVersion: login.serverVersion, nonce, placement: args.placement,
        }),
        secrets: [
          { name: credsSecretName, data: args.resticCreds },
          { name: loginSecretName, data: { username: login.username, password: login.password } },
        ],
        labels: { 'platform.io/component': DATABASE_JOB_COMPONENT_LABEL, 'platform.io/backup-id': args.bundleId.slice(0, 63) },
        container: 'dump',
        tailLines: Math.max(200, databases.length * 4 + 50),
      });
    });
    const parsed = parseDatabaseBackupLines(run.log, nonce);
    const { dumps, failures } = mapResults(databases, parsed, run.outcome, redact);
    const serverVersion = (login as { serverVersion: string } | null)?.serverVersion ?? null;
    if (dumps.length === 0 && (parsed.setupFailed || run.outcome === 'failed')) {
      return result({ engine, serverVersion, databaseFailures: failures, error: redact(parsed.setupFailed ?? 'the backup Job failed') });
    }
    return result({ engine, serverVersion, databaseDumps: dumps, databaseFailures: failures });
  } catch (err) {
    return result({ engine, serverVersion: (login as { serverVersion: string } | null)?.serverVersion ?? null, error: redact((err as Error).message) });
  } finally {
    const minted = login as { username: string } | null;
    if (minted) await dropBackupLogin(x, minted.username).catch(() => false);
    await deleteSecret(args.k8s, args.namespace, credsSecretName);
    await deleteSecret(args.k8s, args.namespace, loginSecretName);
  }
}

/** The tenant's standalone database instances that are meant to be running. */
export async function instancesToBackUp(db: Database, tenantId: string): Promise<InstanceRow[]> {
  const rows = await db
    .select({
      deploymentId: deployments.id, deploymentName: deployments.name, configuration: deployments.configuration,
      catalogCode: catalogEntries.code, catalogRuntime: catalogEntries.runtime,
    })
    .from(deployments)
    .innerJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .where(and(
      eq(deployments.tenantId, tenantId),
      eq(catalogEntries.type, 'database'),
      isNull(deployments.deletedAt),
      isNull(deployments.dataDetachedPath),
      notInArray(deployments.status, ['deleted', 'stopped']),
    ));
  return rows.map((r) => ({ ...r, configuration: (r.configuration ?? {}) as Record<string, unknown> }));
}

/** Every instance's databases, a few instances at a time. */
export async function runDatabaseSnapshots(args: SnapshotInstanceArgs, instances: readonly InstanceRow[]): Promise<DatabaseSnapshotResult[]> {
  const results: DatabaseSnapshotResult[] = new Array(instances.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < instances.length) {
      const i = next++;
      results[i] = await snapshotInstanceDatabases(args, instances[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_INSTANCES, instances.length) }, worker));
  return results;
}

/** The artifact name of a database's component row and its key in meta.json. */
export function databaseArtifactName(deploymentId: string, database: string): string {
  return `${deploymentId}:${database}`;
}

/** Splits an artifact name back; the deployment id is a uuid, so the first ':' separates. */
export function parseDatabaseArtifactName(name: string): { deploymentId: string; database: string } | null {
  const i = name.indexOf(':');
  if (i <= 0) return null;
  return { deploymentId: name.slice(0, i), database: name.slice(i + 1) };
}

/**
 * The bundle's database summary from per-database snapshots, plus the SQLite
 * entries that still ride on the files snapshot. Same statuses as before.
 */
export function buildDatabaseSnapshotsSummary(
  results: ReadonlyArray<DatabaseSnapshotResult>,
  extraDeployments: ReadonlyArray<BackupDatabaseDumps['deployments'][number]> = [],
): BackupDatabaseDumps {
  const fromResults = results.map((r) => {
    const databases: BackupDatabaseDumps['deployments'][number]['databases'] = [];
    for (const d of r.databaseDumps) {
      databases.push({ name: d.database, status: 'dumped', sizeBytes: d.sizeBytes, snapshotId: d.snapshotId, ...(r.serverVersion ? { serverVersion: r.serverVersion.slice(0, 200) } : {}) });
    }
    for (const f of r.databaseFailures) {
      databases.push({ name: f.database, status: f.benign ? 'degraded' : 'failed', sizeBytes: 0, error: f.error });
    }
    if (r.error) databases.push({ name: '(deployment)', status: 'failed', sizeBytes: 0, error: r.error });
    return { deploymentId: r.deploymentId, deploymentName: r.deploymentName, engine: r.engine as string | null, databases };
  });
  const deploymentsOut = [...fromResults, ...extraDeployments];
  const all = deploymentsOut.flatMap((d) => d.databases);
  const status: BackupDatabaseDumps['status'] = all.length === 0 ? 'none' : all.some((d) => d.status !== 'dumped') ? 'degraded' : 'ok';
  const remediation = status === 'degraded'
    ? 'One or more databases have no backup in this bundle. Resolve the reason shown for each database (the database not running, a full volume for a SQLite file, a missing dump tool in a bring-your-own image) and re-run the bundle.'
    : null;
  return { status, deployments: deploymentsOut, remediation };
}

/** The databases that came back as dumped, moved to failures with `error` — their snapshots are not recorded. */
export function withDumpsUnrecorded(results: ReadonlyArray<DatabaseSnapshotResult>, error: string): DatabaseSnapshotResult[] {
  return results.map((r) => ({
    ...r,
    databaseDumps: [],
    databaseFailures: [...r.databaseFailures, ...r.databaseDumps.map((d) => ({ database: d.database, error, benign: false }))],
  }));
}

export interface CaptureDatabaseSnapshotsArgs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly kubeconfigPath?: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly bundleId: string;
  readonly secretsKeyHex: string;
  readonly platformBaseDomain: string;
  readonly ingressBaseDomain: string;
  readonly platformVersion: string;
  readonly globalMaxInFlight: number;
}

/**
 * Sets the repository up (the tenant's restic repository, the same one files
 * and mailboxes use) and backs up every running standalone instance. Throws
 * only when nothing could be tried at all (no backup target, repository init).
 */
export async function captureDatabaseSnapshots(args: CaptureDatabaseSnapshotsArgs): Promise<ReadonlyArray<DatabaseSnapshotResult>> {
  const { resolveShimBackupTarget } = await import('../resolve-backup-target.js');
  const { deriveResticPassword, deriveRegionId, buildResticRepoUri, buildResticEnv, buildSnapshotTags, ensureResticRepoInitialised } = await import('../restic-driver.js');
  const { resolveBundleRepoLayout } = await import('../repo-layout.js');
  const { makeRepoInitSerialiser } = await import('../repo-init-lock.js');
  const { buildResticCredsStringData } = await import('./files.js');
  const { acquireGlobalSlot } = await import('../cluster-concurrency.js');
  const { resolvePlatformImage } = await import('../../../shared/platform-images.js');
  const { resolveBaseDomain } = await import('../../../config/domains.js');
  const { tenants, tenantBackupV2Settings } = await import('../../../db/schema.js');
  const { databaseJobPlacement } = await import('./database-job.js');

  const instances = await instancesToBackUp(args.db, args.tenantId);
  if (instances.length === 0) return [];
  const target = await resolveShimBackupTarget(args.k8s.core, 'tenant');
  const passwordHex = deriveResticPassword(args.secretsKeyHex, args.tenantId);
  const repoUri = buildResticRepoUri(target, args.tenantId, 'databases', await resolveBundleRepoLayout(args.db, args.bundleId));
  const env = buildResticEnv(target);
  const [tenant] = await args.db.select().from(tenants).where(eq(tenants.id, args.tenantId)).limit(1);
  if (!tenant) throw new Error(`databases: tenant ${args.tenantId} not found`);
  const [settings] = await args.db.select().from(tenantBackupV2Settings).limit(1);
  const regionId = deriveRegionId(
    resolveBaseDomain({ PLATFORM_BASE_DOMAIN: args.platformBaseDomain, INGRESS_BASE_DOMAIN: args.ingressBaseDomain }),
    settings?.regionIdOverride ?? '',
  );
  const tags = buildSnapshotTags({
    bundleId: args.bundleId, tenantId: args.tenantId, tenantSlug: tenant.kubernetesNamespace,
    component: 'databases', regionId, platformVersion: args.platformVersion,
  });
  const log = { warn: (msg: string): void => { console.warn(msg); } };
  await ensureResticRepoInitialised({ target, passwordHex, repoUri, serialise: makeRepoInitSerialiser(args.db, log), log });
  return runDatabaseSnapshots({
    k8s: args.k8s,
    kubeconfigPath: args.kubeconfigPath,
    namespace: args.namespace,
    tenantId: args.tenantId,
    bundleId: args.bundleId,
    toolsImage: resolvePlatformImage('tenant-backup-tools'),
    tags,
    resticCreds: buildResticCredsStringData({ passwordHex, repoUri, env }),
    placement: await databaseJobPlacement(args.db, args.tenantId, args.k8s),
    withSlot: async (run) => {
      const slot = await acquireGlobalSlot(args.db, { bundleId: args.bundleId, component: 'databases', podName: process.env.HOSTNAME, globalMaxInFlight: args.globalMaxInFlight });
      try { return await run(); } finally { await slot.release(); }
    },
  }, instances);
}
