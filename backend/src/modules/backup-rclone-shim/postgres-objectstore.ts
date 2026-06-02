/**
 * Postgres ObjectStore + ScheduledBackup reconciler (R-X6).
 *
 * Wires the SYSTEM-class shim target binding into the CNPG
 * plugin-barman-cloud backup pipeline:
 *
 *      backup_target_assignments[system] → BACKUP_TARGET_KEY (HKDF)
 *                                       ↓
 *               platform/backup-rclone-shim-creds Secret
 *                  (access_key + secret_key — derived from BACKUP_TARGET_KEY)
 *                                       ↓
 *               platform/system-postgres-objectstore ObjectStore CR
 *                  (endpointURL = http://backup-rclone-shim.platform.svc:9000)
 *                                       ↓
 *           CNPG Cluster `system-db` spec.plugins[barman-cloud] (in DB manifest)
 *                                       ↓
 *               platform/system-db-scheduled-backup ScheduledBackup CR
 *                  (daily 03:00 — barman_object_store + cluster reference)
 *
 * Why one reconciler module per consumer (postgres / etcd / restic /
 * rclone-push): each consumer has a different CR schema and a
 * different cadence. Lumping them into one reconciler would couple
 * unrelated failure modes. Each lives in `backup-rclone-shim/` so
 * the operator-facing module boundary stays "everything backup-shim
 * is here."
 *
 * Failure semantics:
 *   - SYSTEM target unassigned → ScheduledBackup CR `spec.suspend: true`
 *     (CNPG already supports this — no Backup runs but the schedule
 *     stays in the API server for visibility).
 *   - BACKUP_TARGET_KEY missing → log + no-op (the periodic reconciler
 *     will retry once bootstrap.sh seeds the key).
 *   - Plugin Deployment not yet rolled out (404 on Cluster patch) →
 *     log warning; the periodic reconciler retries on next tick.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
  systemWalArchiveState,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from './crypto.js';
import {
  BACKUP_TARGET_KEY_SECRET_NAME,
  FIELD_MANAGER,
  SHIM_NAMESPACE,
  loadBackupTargetKey,
  ShimKeyMissingError,
} from './service.js';
import { readCircuitBreaker } from '../wal-archive-health/breaker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Namespace where the CNPG Cluster `system-db` lives. Same namespace
 *  hosts the ObjectStore + ScheduledBackup + creds Secret we own. */
export const POSTGRES_NAMESPACE = 'platform';

/** Cluster CR name. Mirrors k8s/base/database.yaml. */
export const POSTGRES_CLUSTER_NAME = 'system-db';

/** ObjectStore CR name — referenced by Cluster.spec.plugins[].parameters.barmanObjectName.
 *  Lives in the same namespace as the Cluster (CNPG plugin convention). */
export const POSTGRES_OBJECT_STORE_NAME = 'system-postgres-objectstore';

/** ScheduledBackup CR name. */
export const POSTGRES_SCHEDULED_BACKUP_NAME = 'system-db-scheduled-backup';

/** Secret holding the HKDF-derived shim S3 credentials. CNPG sidecar
 *  reads access_key / secret_key fields to authenticate to the shim. */
export const SHIM_S3_CREDS_SECRET_NAME = 'backup-rclone-shim-creds';

/** Shim ClusterIP endpoint. internalTrafficPolicy: Local routes the
 *  request to the same-node shim pod. The `http://` scheme + :9000
 *  port match the Service manifest (TLS is a follow-up). */
export const SHIM_S3_ENDPOINT_URL = `http://backup-rclone-shim.${SHIM_NAMESPACE}.svc.cluster.local:9000`;

/** Plugin name as registered by the upstream Deployment. */
export const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';

/** ObjectStore API group + version. */
export const OBJECTSTORE_API_GROUP = 'barmancloud.cnpg.io';
export const OBJECTSTORE_API_VERSION = 'v1';
export const OBJECTSTORE_PLURAL = 'objectstores';

/** CNPG Cluster + ScheduledBackup API. */
export const CNPG_API_GROUP = 'postgresql.cnpg.io';
export const CNPG_API_VERSION = 'v1';
export const SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';
export const CLUSTER_PLURAL = 'clusters';

/** Default daily backup schedule. CNPG uses an extended-cron syntax —
 *  6 fields (seconds first). Operators can override via the future
 *  R-X10 UI; for now the schedule is fixed at 03:00 UTC. */
export const DEFAULT_BACKUP_SCHEDULE = '0 0 3 * * *';

/** Retention policy for barman-cloud (RFC §12 — 30 days). */
export const DEFAULT_RETENTION_POLICY = '30d';

/** Annotation on every reconciler-owned resource so operators can
 *  identify what platform-api manages. */
export const POSTGRES_FIELD_MANAGER = 'platform-api-postgres-objectstore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostgresObjectStoreClients {
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

export interface PostgresObjectStoreResult {
  readonly state: 'STATE_OK' | 'STATE_MISSING_KEY' | 'STATE_NO_SYSTEM_TARGET' | 'STATE_ERROR';
  readonly errorMessage: string;
  readonly objectStoreApplied: boolean;
  readonly scheduledBackupApplied: boolean;
  readonly scheduledBackupSuspended: boolean;
  readonly credentialsSecretApplied: boolean;
  /** Whether the barman-cloud plugin ENTRY is present on the CNPG
   *  Cluster CR (so WAL is really archived to the ObjectStore). `false`
   *  when SYSTEM is unassigned — the entry is REMOVED entirely. With no
   *  barman archiver attached, CNPG's `wal-archive` command no-op-succeeds
   *  (nothing to upload → exit 0), so Postgres recycles WAL instead of
   *  failing against the dead shim and filling the volume. (archive_mode
   *  itself stays on — verified on staging; project_wal_archive_runaway.) */
  readonly walArchiverEnabled: boolean;
}

interface SystemTargetView {
  readonly targetId: string;
  readonly storageType: string;
  readonly enabled: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * One reconcile pass. Idempotent — re-running with unchanged inputs
 * results in no apiserver mutations (server-side apply with the same
 * managed-field set is a no-op).
 *
 * Order matters: Secret first (creds the ObjectStore references must
 * exist before the plugin tries to use them), then ObjectStore, then
 * ScheduledBackup, then the Cluster's `spec.plugins[]` barman entry —
 * which this reconciler now OWNS (step 6): it ADDS the entry when a
 * SYSTEM target is bound (after the ObjectStore it references exists)
 * and REMOVES it otherwise. database.yaml no longer ships a static
 * entry — CNPG keeps archive_mode=on while the entry is present, so a
 * static entry would fill pg_wal on a targetless cluster
 * (project_wal_archive_runaway_2026_06_02).
 */
export async function reconcilePostgresObjectStore(
  db: Database,
  clients: PostgresObjectStoreClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<PostgresObjectStoreResult> {
  // ─── 1. Load BACKUP_TARGET_KEY ───────────────────────────────────
  let keyInput: { rawKey: Buffer; fingerprint: string };
  try {
    keyInput = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE, { log });
  } catch (err) {
    if (err instanceof ShimKeyMissingError) {
      log.warn(
        { err: err.message },
        'postgres-objectstore: BACKUP_TARGET_KEY missing — no-op (will retry)',
      );
      return {
        state: 'STATE_MISSING_KEY',
        errorMessage: err.message,
        objectStoreApplied: false,
        scheduledBackupApplied: false,
        scheduledBackupSuspended: false,
        credentialsSecretApplied: false,
        walArchiverEnabled: false,
      };
    }
    throw err;
  }

  // ─── 2. Load SYSTEM target binding + wal-archive ownership ────────
  const target = await loadSystemTarget(db);
  const suspended = target === null;
  // One DB query per reconcile pass; result used by both the
  // ScheduledBackup step (5) and the Cluster.spec.plugins step (6).
  const walArchiveOwns = await walArchiveOwnsCluster(db);

  // WAL-archive circuit-breaker (wal-archive-health). When tripped, the
  // operator's SYSTEM target is still bound but archiving was auto-disabled
  // because it was failing + pg_wal was filling the volume. Keep the plugin
  // ABSENT until an operator resets the breaker — otherwise we'd re-attach
  // the failing archiver every tick and the volume would fill again.
  const breaker = await readCircuitBreaker(db);

  // ─── 3. Materialise the shim creds Secret in the cluster ns ─────
  let credentialsSecretApplied = false;
  try {
    await materializeShimCredsSecret(
      clients.core,
      log,
      keyInput.rawKey,
    );
    credentialsSecretApplied = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'postgres-objectstore: shim creds Secret failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      objectStoreApplied: false,
      scheduledBackupApplied: false,
      scheduledBackupSuspended: false,
      credentialsSecretApplied: false,
      walArchiverEnabled: false,
    };
  }

  // ─── 4. Materialise ObjectStore CR ───────────────────────────────
  // Phase 8 (2026-05-25): defer this too when wal-archive owns. The
  // operator's retention setting (stored on the ObjectStore CR via
  // wal-archive) was being clobbered back to the 30d default on every
  // postgres-objectstore reconciliation. Now wal-archive has exclusive
  // ownership of all three CRs (ObjectStore + ScheduledBackup +
  // Cluster.spec.plugins) whenever a row in systemWalArchiveState
  // exists. The shim creds Secret above (step 3) is unaffected — it's
  // identical content regardless of who writes it.
  let objectStoreApplied = false;
  if (walArchiveOwns) {
    log.info(
      { cluster: `${POSTGRES_NAMESPACE}/${POSTGRES_CLUSTER_NAME}` },
      'postgres-objectstore: wal-archive owns ObjectStore — skipping reconciliation',
    );
  } else {
    try {
      await materializeObjectStore(clients.custom, log);
      objectStoreApplied = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'postgres-objectstore: ObjectStore apply failed');
      return {
        state: 'STATE_ERROR',
        errorMessage: msg,
        objectStoreApplied: false,
        scheduledBackupApplied: false,
        scheduledBackupSuspended: false,
        credentialsSecretApplied,
        walArchiverEnabled: false,
      };
    }
  }

  // ─── 5. Materialise ScheduledBackup CR (suspended when no target) ─
  // Phase 7a (2026-05-24): defer to wal-archive when the operator has
  // enabled scheduled backups via the UI. The WAL Archive tab now owns
  // the ScheduledBackup CR (operator-configured cadence). When
  // wal-archive is NOT active, this reconciler keeps the
  // hardcoded-default ScheduledBackup as a safety net so a cluster
  // with a SYSTEM target bound but no operator configuration still
  // gets daily base backups at 03:00.
  let scheduledBackupApplied = false;
  if (walArchiveOwns) {
    log.info(
      { cluster: `${POSTGRES_NAMESPACE}/${POSTGRES_CLUSTER_NAME}` },
      'postgres-objectstore: wal-archive owns ScheduledBackup — skipping reconciliation',
    );
  } else {
    try {
      await materializeScheduledBackup(clients.custom, log, { suspended });
      scheduledBackupApplied = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'postgres-objectstore: ScheduledBackup apply failed');
      return {
        state: 'STATE_ERROR',
        errorMessage: msg,
        objectStoreApplied,
        scheduledBackupApplied: false,
        scheduledBackupSuspended: false,
        credentialsSecretApplied,
        walArchiverEnabled: false,
      };
    }
  }

  // ─── 6. Reconcile the barman-cloud plugin's PRESENCE on the Cluster ─
  // WAL archiving is gated by the barman-cloud plugin ENTRY's presence in
  // spec.plugins — NOT by `isWALArchiver`. With the entry present + a SYSTEM
  // target, CNPG's archive_command (`/controller/manager wal-archive`)
  // really uploads each segment to the ObjectStore (via the shim). The old
  // isWALArchiver:false toggle left the entry present, so on a no-target
  // cluster the shim was unreachable and every archive FAILED — Postgres
  // can't recycle un-archived WAL, so pg_wal grew until CNPG halted Postgres
  // on a full volume (project_wal_archive_runaway_2026_06_02).
  //
  // So a no-target cluster must have the entry REMOVED entirely: with no
  // archiver attached, `wal-archive` no-op-SUCCEEDS (nothing to upload →
  // exit 0; archive_mode itself stays on — verified on staging), and
  // Postgres recycles WAL normally. database.yaml no longer ships a static
  // entry → a fresh cluster starts with no barman plugin → WAL recycles.
  // This reconciler ADDS the entry only once a SYSTEM target is bound
  // (after step 4 materialised the ObjectStore it references) and REMOVES
  // it when SYSTEM is unassigned. It is the sole owner of the entry (CI
  // guard ci-backup-rclone-shim-check.sh enforces no static one).
  //
  // present ⟺ a SYSTEM target is bound AND the circuit-breaker hasn't
  // auto-disabled archiving. The breaker gate is what makes an auto-disable
  // persist across reconcile ticks.
  //
  // Dual-reconciler guard (2026-05-24): when the operator enabled WAL
  // streaming via the UI, system-backup/wal-archive.ts owns the plugin entry
  // exclusively — normally skip here to avoid both reconcilers fighting.
  // EXCEPTION: a TRIPPED breaker overrides ownership — the breaker is a
  // safety override, so we actively REMOVE the plugin even in the
  // wal-archive-owned path (and even if the scheduler's immediate disable
  // failed). Otherwise a tripped breaker with UI WAL-streaming on would leave
  // the failing archiver attached and the volume would keep filling.
  const walArchiverEnabled = !suspended && !breaker.tripped;
  const breakerOverride = breaker.tripped && !suspended;
  if (walArchiveOwns && !breakerOverride) {
    log.info(
      { cluster: `${POSTGRES_NAMESPACE}/${POSTGRES_CLUSTER_NAME}` },
      'postgres-objectstore: wal-archive owns Cluster plugin entry — skipping plugin reconcile',
    );
  } else {
    try {
      if (breakerOverride) {
        log.warn(
          { cluster: `${POSTGRES_NAMESPACE}/${POSTGRES_CLUSTER_NAME}`, reason: breaker.reason, walArchiveOwns },
          'postgres-objectstore: WAL-archive circuit-breaker is TRIPPED — enforcing barman plugin removal (operator must reset to re-enable)',
        );
      }
      await ensureClusterBarmanPlugin(clients.custom, log, walArchiverEnabled);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'postgres-objectstore: Cluster barman-cloud plugin reconcile failed');
      return {
        state: 'STATE_ERROR',
        errorMessage: msg,
        objectStoreApplied,
        scheduledBackupApplied,
        scheduledBackupSuspended: suspended,
        credentialsSecretApplied,
        walArchiverEnabled: false,
      };
    }
  }

  return {
    state: target === null ? 'STATE_NO_SYSTEM_TARGET' : 'STATE_OK',
    errorMessage: '',
    objectStoreApplied,
    scheduledBackupApplied,
    scheduledBackupSuspended: suspended,
    credentialsSecretApplied,
    walArchiverEnabled,
  };
}

// ---------------------------------------------------------------------------
// DB query — SYSTEM target binding
// ---------------------------------------------------------------------------

/**
 * Phase 6 (2026-05-24) — dual-reconciler ownership guard.
 * Phase 7c (2026-05-24) — extended to ScheduledBackup CR ownership too.
 *
 * Returns true when system-backup/wal-archive.ts owns ANY part of the
 * Cluster.spec / CR set for `platform/system-db` — either WAL streaming
 * is on, or scheduled backups are on, or both. The presence of a row
 * in `system_wal_archive_state` is the canonical signal: enableWalStreaming
 * and enableScheduledBackups both insert/upsert the row;
 * disableWalStreaming / disableScheduledBackups delete it ONLY when the
 * OTHER feature is also off.
 *
 * Implication: as long as either feature is active, this reconciler
 * defers BOTH the ScheduledBackup CR and the Cluster.spec.plugins patch
 * to wal-archive. The shim creds Secret + ObjectStore CR continue to be
 * reconciled (harmless additions — wal-archive also writes them, last
 * writer wins on identical content).
 */
async function walArchiveOwnsCluster(db: Database): Promise<boolean> {
  const rows = await db
    .select({ ns: systemWalArchiveState.clusterNamespace })
    .from(systemWalArchiveState)
    .where(and(
      eq(systemWalArchiveState.clusterNamespace, POSTGRES_NAMESPACE),
      eq(systemWalArchiveState.clusterName, POSTGRES_CLUSTER_NAME),
    ))
    .limit(1);
  return rows.length > 0;
}

async function loadSystemTarget(db: Database): Promise<SystemTargetView | null> {
  const rows = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      storageType: backupConfigurations.storageType,
      enabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(
      inArray(backupTargetAssignments.backupClass, ['system']),
    )
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.enabled !== 1) return null;
  return {
    targetId: row.targetId,
    storageType: row.storageType,
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Shim creds Secret (in cluster ns)
// ---------------------------------------------------------------------------

async function materializeShimCredsSecret(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
  rawKey: Buffer,
): Promise<void> {
  const accessKey = deriveShimAccessKey(rawKey);
  const secretKey = deriveShimSecretKey(rawKey);
  const dataB64 = {
    access_key: Buffer.from(accessKey, 'utf8').toString('base64'),
    secret_key: Buffer.from(secretKey, 'utf8').toString('base64'),
  };

  let exists = false;
  try {
    await core.readNamespacedSecret({
      name: SHIM_S3_CREDS_SECRET_NAME,
      namespace: POSTGRES_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    try {
      // backup-coverage: excluded:cluster-infrastructure
      // CNPG shim S3-creds Secret in the `postgres` namespace —
      // deterministically derived from BACKUP_TARGET_KEY at boot.
      // Not tenant data; recreated on restore.
      await core.createNamespacedSecret({
        namespace: POSTGRES_NAMESPACE,
        body: {
          metadata: {
            name: SHIM_S3_CREDS_SECRET_NAME,
            namespace: POSTGRES_NAMESPACE,
            labels: {
              app: 'backup-rclone-shim',
              'app.kubernetes.io/part-of': 'hosting-platform',
              'app.kubernetes.io/component': 'backup',
              'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
            },
          },
          type: 'Opaque',
          data: dataB64,
        },
      } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
      log.info(
        { name: SHIM_S3_CREDS_SECRET_NAME },
        'postgres-objectstore: shim creds Secret created',
      );
      return;
    } catch (err) {
      const code = (err as { statusCode?: number; code?: number })?.statusCode
        ?? (err as { code?: number })?.code;
      // 409 → concurrent creator won the create race (startup
      // setImmediate + manual trigger overlap). Treat as success and
      // fall through to patch so data converges. Without this guard
      // the second reconciler crashes with an opaque STATE_ERROR.
      if (code !== 409) throw err;
      log.info(
        { name: SHIM_S3_CREDS_SECRET_NAME },
        'postgres-objectstore: shim creds Secret 409 on create — concurrent creator won; falling through to patch',
      );
    }
  }

  // Merge-patch `data` rather than JSON-Patch replace because:
  //   - replace fails 422 if the Secret was somehow created without
  //     a `data` field (operator hand-edit)
  //   - merge with the full data map still atomically replaces every
  //     key we manage, and absent-from-manifest keys are left alone
  //     (intentional — the Secret is reconciler-owned, no operator
  //     additions are expected, but the path stays safe under weird
  //     starting states).
  await core.patchNamespacedSecret(
    {
      name: SHIM_S3_CREDS_SECRET_NAME,
      namespace: POSTGRES_NAMESPACE,
      body: { data: dataB64 },
    } as unknown as Parameters<typeof core.patchNamespacedSecret>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// ObjectStore CR
// ---------------------------------------------------------------------------

function buildObjectStoreSpec(): Record<string, unknown> {
  return {
    configuration: {
      destinationPath: 's3://system/postgres',
      endpointURL: SHIM_S3_ENDPOINT_URL,
      // The shim's HKDF-derived creds — host application reads them
      // from the Secret we just materialised.
      s3Credentials: {
        accessKeyId: {
          name: SHIM_S3_CREDS_SECRET_NAME,
          key: 'access_key',
        },
        secretAccessKey: {
          name: SHIM_S3_CREDS_SECRET_NAME,
          key: 'secret_key',
        },
      },
      // gzip compression — plugin-barman-cloud v0.12.0's ObjectStore
      // CRD only accepts 'bzip2' | 'gzip' | 'snappy' on
      // spec.configuration.{data,wal}.compression. The original R-X6
      // RFC named zstd but the upstream CRD has NOT shipped zstd
      // support yet (validation error: "Unsupported value: zstd").
      // gzip is the best balance of compatibility + ratio in v0.12.0.
      // Surfaced during staging E2E round-trip test 2026-05-20.
      // maxParallel: 2 (was 8). plugin-barman-cloud spawns ONE Python
      // subprocess per concurrent WAL-archive call; each subprocess
      // sits at ~80Mi RSS just from CPython + boto3 imports before
      // touching a byte. 8-way parallelism cost ~640Mi of baseline
      // memory — enough to OOM the sidecar mid-base-backup even
      // though the data being moved was tiny. WAL segments are 16Mi
      // and arrive every few seconds; 2-way is plenty for throughput
      // and the 4× memory savings keep peak RSS well below the
      // sidecar's resource limit. Surfaced 2026-05-20 during staging
      // E2E destructive round-trip.
      wal: { compression: 'gzip', maxParallel: 2 },
      data: { compression: 'gzip' },
    },
    // Bump the sidecar memory ceiling. The default 384Mi limit OOM-kills
    // the barman-cloud sidecar mid-base-backup: it streams the cluster's
    // pgdata through Python boto3 multipart uploads (16Mi parts × upload
    // concurrency) PLUS holds compression buffers PLUS plugin gRPC server
    // state — peak RSS ~700-900Mi on a 1Gi-PGDATA cluster. 1Gi gives
    // headroom for ~5Gi PGDATA before hitting the next ceiling.
    // Surfaced during staging E2E round-trip 2026-05-20:
    //   `kubectl describe pod` → Last State: Terminated  Reason: OOMKilled
    //   `kubectl logs` →
    //     "Backup failed uploading data (NoSuchUpload)" - the multipart
    //     upload got abandoned when the sidecar was killed mid-stream.
    instanceSidecarConfiguration: {
      resources: {
        requests: { cpu: '50m', memory: '128Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
    },
    // 30-day rolling retention (RFC §12).
    retentionPolicy: DEFAULT_RETENTION_POLICY,
  };
}

async function materializeObjectStore(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const spec = buildObjectStoreSpec();
  const body = {
    apiVersion: `${OBJECTSTORE_API_GROUP}/${OBJECTSTORE_API_VERSION}`,
    kind: 'ObjectStore',
    metadata: {
      name: POSTGRES_OBJECT_STORE_NAME,
      namespace: POSTGRES_NAMESPACE,
      labels: {
        app: 'backup-rclone-shim',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'backup',
        'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
      },
    },
    spec,
  };

  let exists = false;
  try {
    await custom.getNamespacedCustomObject({
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      name: POSTGRES_OBJECT_STORE_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    await custom.createNamespacedCustomObject({
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
    log.info(
      { name: POSTGRES_OBJECT_STORE_NAME },
      'postgres-objectstore: ObjectStore CR created',
    );
    return;
  }

  // Update via merge-patch on spec only. We don't replace the whole
  // CR because that would clobber operator-added annotations on the
  // managed object.
  await custom.patchNamespacedCustomObject(
    {
      group: OBJECTSTORE_API_GROUP,
      version: OBJECTSTORE_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: OBJECTSTORE_PLURAL,
      name: POSTGRES_OBJECT_STORE_NAME,
      body: { spec },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// ScheduledBackup CR
// ---------------------------------------------------------------------------

interface ScheduledBackupOpts {
  readonly suspended: boolean;
}

function buildScheduledBackupSpec(opts: ScheduledBackupOpts): Record<string, unknown> {
  return {
    schedule: DEFAULT_BACKUP_SCHEDULE,
    backupOwnerReference: 'self',
    immediate: false,
    cluster: {
      name: POSTGRES_CLUSTER_NAME,
    },
    // method=plugin tells CNPG to delegate to plugin-barman-cloud;
    // the pluginConfiguration field points at our ObjectStore CR.
    method: 'plugin',
    pluginConfiguration: {
      name: BARMAN_PLUGIN_NAME,
      parameters: {
        barmanObjectName: POSTGRES_OBJECT_STORE_NAME,
      },
    },
    // When the operator unassigns the SYSTEM target, suspend the
    // schedule instead of deleting the CR — keeps the operator
    // surface alive for observability + makes re-enabling trivial.
    suspend: opts.suspended,
  };
}

async function materializeScheduledBackup(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
  opts: ScheduledBackupOpts,
): Promise<void> {
  const spec = buildScheduledBackupSpec(opts);
  const body = {
    apiVersion: `${CNPG_API_GROUP}/${CNPG_API_VERSION}`,
    kind: 'ScheduledBackup',
    metadata: {
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
      namespace: POSTGRES_NAMESPACE,
      labels: {
        app: 'backup-rclone-shim',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'backup',
        'app.kubernetes.io/managed-by': POSTGRES_FIELD_MANAGER,
      },
    },
    spec,
  };

  let exists = false;
  try {
    await custom.getNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    await custom.createNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
    log.info(
      { name: POSTGRES_SCHEDULED_BACKUP_NAME, suspended: opts.suspended },
      'postgres-objectstore: ScheduledBackup CR created',
    );
    return;
  }

  await custom.patchNamespacedCustomObject(
    {
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: SCHEDULED_BACKUP_PLURAL,
      name: POSTGRES_SCHEDULED_BACKUP_NAME,
      body: { spec },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// Cluster CR — barman-cloud plugin PRESENCE reconcile
// ---------------------------------------------------------------------------

interface ClusterPluginEntry {
  name?: string;
  isWALArchiver?: boolean;
  parameters?: Record<string, string>;
}

interface ClusterCRView {
  spec?: {
    plugins?: ClusterPluginEntry[];
  };
}

/**
 * Reconcile whether the barman-cloud plugin ENTRY exists in the CNPG
 * Cluster's `spec.plugins[]`.
 *
 * The entry's PRESENCE — not `isWALArchiver` — is what gates real WAL
 * archiving. With the entry present, CNPG's archive_command really uploads
 * each segment to the ObjectStore (→ shim). Flipping `isWALArchiver:false`
 * leaves the entry present, so a no-target cluster keeps trying to upload to
 * the unreachable shim — every archive FAILS, Postgres can't recycle the
 * un-archived WAL, and pg_wal fills the volume until CNPG halts Postgres
 * (project_wal_archive_runaway_2026_06_02). So:
 *
 *   present=true  → ensure the entry exists (isWALArchiver:true,
 *                   barmanObjectName → the ObjectStore step 4 materialised).
 *   present=false → REMOVE the entry. With no archiver attached, CNPG's
 *                   `wal-archive` no-op-SUCCEEDS (exit 0; archive_mode stays
 *                   on) so Postgres recycles WAL normally. Verified on staging.
 *
 * Read-modify-write of the whole plugins array via merge-patch (mirrors
 * system-backup/wal-archive.ts) so any OTHER plugins the operator added
 * survive. Idempotent: skips the apiserver call when already at the
 * desired state. A 404 (Cluster CR not yet applied) logs + returns — the
 * next reconciler tick converges.
 */
export async function ensureClusterBarmanPlugin(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
  present: boolean,
): Promise<void> {
  let cluster: ClusterCRView;
  try {
    cluster = (await custom.getNamespacedCustomObject({
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: CLUSTER_PLURAL,
      name: POSTGRES_CLUSTER_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as ClusterCRView;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      log.warn(
        { name: POSTGRES_CLUSTER_NAME, present },
        'postgres-objectstore: Cluster CR not yet applied — skipping plugin reconcile',
      );
      return;
    }
    throw err;
  }

  const existing = cluster.spec?.plugins ?? [];
  const current = existing.find((p) => p.name === BARMAN_PLUGIN_NAME);

  // Idempotency: skip the apiserver call when already at desired state.
  if (present) {
    if (
      current
      && current.isWALArchiver === true
      && current.parameters?.barmanObjectName === POSTGRES_OBJECT_STORE_NAME
    ) {
      return;
    }
  } else if (!current) {
    return;
  }

  // Detaching the archiver triggers a CNPG-managed rolling Postgres restart
  // (it reloads the plugin sidecar config). Warn so an operator who sees the
  // restart knows it's expected. After it, `wal-archive` no-op-succeeds and
  // pg_wal recycles. Any WAL segment mid-archive at this instant just fails +
  // stays local (no loss — there's no target to archive to anyway).
  if (!present && current) {
    log.warn(
      { name: POSTGRES_CLUSTER_NAME },
      'postgres-objectstore: removing barman-cloud plugin — CNPG will roll-restart Postgres (expected); afterward wal-archive no-op-succeeds and pg_wal recycles',
    );
  }

  // Rebuild the array: preserve non-barman plugins, then append our entry
  // (present) or omit it (absent). Merge-patch replaces the array wholesale.
  const otherPlugins = existing.filter((p) => p.name !== BARMAN_PLUGIN_NAME);
  const merged: ClusterPluginEntry[] = present
    ? [...otherPlugins, {
        name: BARMAN_PLUGIN_NAME,
        isWALArchiver: true,
        parameters: { barmanObjectName: POSTGRES_OBJECT_STORE_NAME },
      }]
    : otherPlugins;

  await custom.patchNamespacedCustomObject(
    {
      group: CNPG_API_GROUP,
      version: CNPG_API_VERSION,
      namespace: POSTGRES_NAMESPACE,
      plural: CLUSTER_PLURAL,
      name: POSTGRES_CLUSTER_NAME,
      body: { spec: { plugins: merged } },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
  log.info(
    { name: POSTGRES_CLUSTER_NAME, present },
    present
      ? 'postgres-objectstore: barman-cloud plugin ensured present (WAL archiving on)'
      : 'postgres-objectstore: barman-cloud plugin removed (no SYSTEM target — wal-archive no-op-succeeds so pg_wal recycles)',
  );
}

// ---------------------------------------------------------------------------
// Re-exports for the scheduler / tests
// ---------------------------------------------------------------------------

export {
  BACKUP_TARGET_KEY_SECRET_NAME,
  loadBackupTargetKey,
};
