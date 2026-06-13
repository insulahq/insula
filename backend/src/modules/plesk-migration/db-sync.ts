/**
 * Plesk migration — database sync leg (R1).
 *
 * For a discovered subscription's MySQL/MariaDB databases:
 *   1. ensure ONE per-subscription MariaDB deployment exists in the tenant
 *      namespace (created from the `mariadb` catalog entry, reused on retry),
 *   2. create each Plesk database in it (db-manager, idempotent),
 *   3. spawn a one-shot `migration-tools` Job that ssh's to the Plesk box,
 *      `mysqldump`s each database, and streams it straight into the tenant
 *      MariaDB Service (no intermediate file),
 *   4. parse the Job's per-database result lines into leg items.
 *
 * The Job runs in the TENANT namespace (so it can reach the in-namespace
 * MariaDB Service); tenant namespaces have Ingress-only NetworkPolicies, so
 * its egress to the Plesk box is permitted. A scoped egress netpol for the
 * Job is a hardening follow-up (tracked in the PR).
 *
 * Credentials handling: the Plesk SSH key and the tenant MariaDB root
 * password are delivered via a per-job Secret (deleted in a finally block);
 * the dump uses the Plesk MySQL admin password read ON the Plesk box (never
 * transferred). Database NAMES are validated before any interpolation.
 */

import { eq, and } from 'drizzle-orm';
import { tenants, deployments as deploymentsTable, pleskSources } from '../../db/schema.js';
import { getCatalogEntryByCode } from '../catalog/service.js';
import { createDeployment, getDeploymentById } from '../deployments/service.js';
import { buildDbContext, createDatabase } from '../deployments/db-manager.js';
import { decryptSourceKey, normalizePrivateKey } from './service.js';
import type { PleskSubscription } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { LegItem } from './provision.js';
import type { MigrationLogger } from './provision.js';

const MIGRATION_TOOLS_IMAGE =
  process.env.PLESK_MIGRATION_TOOLS_IMAGE ?? 'ghcr.io/insulahq/insula/migration-tools:latest';

// The per-subscription MariaDB deployment all the subscription's databases
// land in (one pod, N logical databases). DNS-name-safe.
const DB_DEPLOYMENT_NAME = 'plesk-databases';
const DBSYNC_BEGIN = '===DBSYNC-BEGIN===';
const DBSYNC_END = '===DBSYNC-END===';

/** MySQL/MariaDB database names this leg can handle (matches the Job's guard). */
export function isValidDbName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
}

/** Only MySQL/MariaDB Plesk DBs (Plesk can also host PostgreSQL — out of scope here). */
export function mysqlDatabasesOf(snapshot: PleskSubscription): string[] {
  return snapshot.databases
    .filter((d) => /mysql|maria/i.test(d.type ?? 'mysql'))
    .map((d) => d.name);
}

/**
 * Parse the Job log's `DBRESULT <db> ok|fail <msg>` lines (between sentinels)
 * into a map of db name → outcome.
 */
export function parseDbResults(log: string): Map<string, { ok: boolean; message: string }> {
  const out = new Map<string, { ok: boolean; message: string }>();
  const begin = log.indexOf(DBSYNC_BEGIN);
  const end = log.indexOf(DBSYNC_END);
  const block = begin >= 0 ? log.slice(begin + DBSYNC_BEGIN.length, end > begin ? end : undefined) : log;
  for (const line of block.split('\n')) {
    const m = line.match(/^DBRESULT\s+(\S+)\s+(ok|fail)\s*(.*)$/);
    if (m) out.set(m[1], { ok: m[2] === 'ok', message: (m[3] ?? '').trim() });
  }
  return out;
}

type SourceRow = typeof pleskSources.$inferSelect;

interface CoreApi {
  createNamespacedSecret: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
  listNamespacedPod: (a: { namespace: string; labelSelector: string; limit?: number }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
  readNamespacedPodLog: (a: { name: string; namespace: string; container?: string }) => Promise<string>;
}
interface BatchApi {
  createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{ status?: { succeeded?: number; failed?: number } }>;
  deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
}

/**
 * Run the DB leg. Returns one LegItem per database (plus a leg-level item if
 * the deployment can't be brought up). Empty array = no MySQL databases.
 */
export async function runDatabaseLeg(
  db: Database,
  k8s: K8sClients | undefined,
  kubeconfigPath: string | undefined,
  tenantId: string,
  source: SourceRow,
  snapshot: PleskSubscription,
  logger: MigrationLogger,
): Promise<LegItem[]> {
  const dbNames = mysqlDatabasesOf(snapshot);
  if (dbNames.length === 0) return [];
  if (!k8s) return dbNames.map((name) => ({ name, status: 'failed', message: 'no kubernetes client available' }));

  const [tenant] = await db.select({ namespace: tenants.kubernetesNamespace }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant?.namespace) return dbNames.map((name) => ({ name, status: 'failed', message: 'tenant namespace unknown' }));
  const namespace = tenant.namespace;

  // 1. Ensure the MariaDB deployment (reuse on retry).
  let deployment;
  try {
    deployment = await ensureMariaDbDeployment(db, k8s, tenantId, source.createdBy ?? 'plesk-migration', logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return dbNames.map((name) => ({ name, status: 'failed', message: `database server not ready: ${msg}` }));
  }

  // 2. Create each database (idempotent CREATE IF NOT EXISTS).
  const entry = await getCatalogEntryByCode(db, 'mariadb');
  const ctx = await buildDbContext(
    k8s, kubeconfigPath, namespace, deployment.name,
    { runtime: entry.runtime ?? 'mariadb', code: entry.code },
    (deployment.configuration ?? {}) as Record<string, unknown>,
    'mariadb',
  );
  const items: LegItem[] = [];
  const toSync: string[] = [];
  for (const name of dbNames) {
    if (!isValidDbName(name)) { items.push({ name, status: 'failed', message: 'invalid database name' }); continue; }
    try {
      await createDatabase(ctx, name);
      toSync.push(name);
    } catch (err) {
      items.push({ name, status: 'failed', message: `create database failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  if (toSync.length === 0) return items;

  // 3. Stream the data in via a migration-tools Job.
  const rootPassword = String((deployment.configuration as Record<string, unknown>)?.MARIADB_ROOT_PASSWORD ?? '');
  const dbHost = `${deployment.name}.${namespace}.svc.cluster.local`;
  const results = await spawnDbSyncJob({ k8s, namespace, source, dbHost, rootPassword, dbNames: toSync, logger });

  for (const name of toSync) {
    const r = results.get(name);
    if (r?.ok) items.push({ name, status: 'completed', message: `imported into ${deployment.name}` });
    else items.push({ name, status: 'failed', message: r?.message || 'sync job produced no result for this database' });
  }
  return items;
}

const RUNNING_TIMEOUT_MS = 6 * 60 * 1000; // mariadb pod pull + init

/** Find-or-create the per-subscription MariaDB deployment, then wait for Running. */
async function ensureMariaDbDeployment(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  actorId: string,
  logger: MigrationLogger,
) {
  const [existing] = await db
    .select()
    .from(deploymentsTable)
    .where(and(eq(deploymentsTable.tenantId, tenantId), eq(deploymentsTable.name, DB_DEPLOYMENT_NAME)));

  let deploymentId: string;
  if (existing) {
    deploymentId = existing.id;
  } else {
    const entry = await getCatalogEntryByCode(db, 'mariadb');
    const created = await createDeployment(
      db,
      tenantId,
      { catalog_entry_id: entry.id, name: DB_DEPLOYMENT_NAME, replica_count: 1, cpu_request: '0.25', memory_request: '512Mi', storage_mode: 'default' },
      actorId,
      k8s,
    );
    deploymentId = created.id;
    logger.info({ tenantId, deploymentId }, 'plesk migration: created MariaDB deployment for DB leg');
  }

  // Poll for Running. Pending/deploying/upgrading are transient (keep
  // waiting); stopped/failed/deleting/deleted are terminal-non-running and
  // would otherwise spin to the timeout with a confusing message — fail fast
  // with an actionable one (the operator starts/recreates the deployment and
  // retries the migration).
  const terminalNonRunning = new Set(['failed', 'stopped', 'deleting', 'deleted']);
  const deadline = Date.now() + RUNNING_TIMEOUT_MS;
  for (;;) {
    const row = await getDeploymentById(db, tenantId, deploymentId);
    if (row.status === 'running') return row;
    if (terminalNonRunning.has(row.status)) {
      throw new Error(`MariaDB deployment '${DB_DEPLOYMENT_NAME}' is '${row.status}'${row.lastError ? `: ${row.lastError}` : ''} — start (or delete) it, then retry the migration`);
    }
    if (Date.now() > deadline) throw new Error(`MariaDB deployment not Running after ${Math.round(RUNNING_TIMEOUT_MS / 1000)}s (status=${row.status})`);
    await sleep(5000);
  }
}

interface SpawnArgs {
  k8s: K8sClients;
  namespace: string;
  source: SourceRow;
  dbHost: string;
  rootPassword: string;
  dbNames: string[];
  logger: MigrationLogger;
}

/** Spawn the migration-tools Job, wait, parse per-db results, clean up. */
async function spawnDbSyncJob(args: SpawnArgs): Promise<Map<string, { ok: boolean; message: string }>> {
  const { k8s, namespace, source, dbHost, rootPassword, dbNames, logger } = args;
  const core = k8s.core as unknown as CoreApi;
  const batch = k8s.batch as unknown as BatchApi;
  const short = source.id.slice(0, 8);
  const stamp = dbNames.length.toString(36);
  const jobName = `plesk-dbsync-${short}-${stamp}`;
  const secretName = `plesk-dbsync-creds-${short}-${stamp}`;

  try {
    // backup-coverage: excluded:transient-migration-job
    // (operator SSH key + tenant DB root password for a short-lived sync
    //  Job; deleted in the finally block — nothing to back up.)
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name: secretName, namespace, labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'app.kubernetes.io/name': 'plesk-db-sync' } },
        type: 'Opaque',
        stringData: { 'id_rsa': normalizePrivateKey(decryptSourceKey(source)), 'root-password': rootPassword },
      },
    });
    await batch.createNamespacedJob({ namespace, body: buildDbSyncJob({ jobName, secretName, namespace, source, dbHost, dbNames }) });

    let succeeded = false;
    // DB dumps can be slow; allow ~30 min.
    for (let i = 0; i < 360; i++) {
      await sleep(5000);
      const st = await batch.readNamespacedJob({ name: jobName, namespace }).catch((): { status?: { succeeded?: number; failed?: number } } => ({ status: {} }));
      if (st.status?.succeeded && st.status.succeeded > 0) { succeeded = true; break; }
      if (st.status?.failed && st.status.failed > 0) break;
    }

    const log = await readFullJobLog(core, namespace, jobName);
    const results = parseDbResults(log ?? '');
    if (!succeeded && results.size === 0) {
      logger.warn({ namespace, jobName, tail: (log ?? '').slice(-800) }, 'plesk migration: db-sync job produced no results');
    }
    return results;
  } finally {
    await batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' }).catch(() => {});
    await core.deleteNamespacedSecret({ name: secretName, namespace }).catch(() => {});
  }
}

async function readFullJobLog(core: CoreApi, namespace: string, jobName: string): Promise<string | null> {
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}`, limit: 1 }).catch(() => ({ items: [] }));
  const podName = pods.items?.[0]?.metadata?.name;
  if (!podName) return null;
  return core.readNamespacedPodLog({ name: podName, namespace }).catch(() => null);
}

interface BuildJobArgs {
  jobName: string;
  secretName: string;
  namespace: string;
  source: SourceRow;
  dbHost: string;
  dbNames: string[];
}

export function buildDbSyncJob({ jobName, secretName, namespace, source, dbHost, dbNames }: BuildJobArgs): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace, labels: { 'app.kubernetes.io/name': 'plesk-db-sync', 'app.kubernetes.io/managed-by': 'platform-api' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 1800,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'plesk-db-sync' } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser: 65534, fsGroup: 65534, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'db-sync',
            image: MIGRATION_TOOLS_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['bash', '/usr/local/bin/plesk-db-sync.sh'],
            env: [
              { name: 'PLESK_HOST', value: source.hostname },
              { name: 'PLESK_PORT', value: String(source.sshPort) },
              { name: 'PLESK_USER', value: source.sshUser },
              { name: 'DB_HOST', value: dbHost },
              { name: 'DB_PORT', value: '3306' },
              { name: 'DB_NAMES', value: dbNames.join(' ') },
              { name: 'HOME', value: '/tmp' },
            ],
            volumeMounts: [
              { name: 'plesk-key', mountPath: '/etc/plesk-key', readOnly: true },
              { name: 'db-creds', mountPath: '/etc/db-creds', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
            ],
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          }],
          volumes: [
            { name: 'plesk-key', secret: { secretName, items: [{ key: 'id_rsa', path: 'id_rsa', mode: 0o600 }] } },
            { name: 'db-creds', secret: { secretName, items: [{ key: 'root-password', path: 'root-password' }] } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}
