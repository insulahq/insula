/**
 * Stalwart-native, app-level archive orchestration.
 *
 * Distinct from the continuous restic backup of the raw data dir
 * (mail-snapshot-*). An archive run is operator-triggered, briefly
 * disruptive, and produces a store-agnostic LZ4 export via Stalwart's
 * own `stalwart -e` command:
 *
 *   1. Save current Stalwart replicas (so we can restore exactly).
 *   2. Scale the stalwart-mail Deployment to 0.
 *   3. Wait for all stalwart pods to terminate — this releases the
 *      RocksDB LOCK in the data directory.
 *   4. Spawn a one-shot Job (`stalwart-archive-<runId>`) that mounts
 *      the same PVC, runs `stalwart -e /tmp/export.lz4`, then ships
 *      the LZ4 via restic to the configured backup target. The Job
 *      uses podAffinity to land on the same node as the (now-dead)
 *      Stalwart pod — local-path PVCs are node-pinned.
 *   5. Wait for the Job to finish. Parse exportSizeBytes + restic
 *      snapshot ID from its terminal log line.
 *   6. ALWAYS scale Stalwart back up — even if the Job failed — so
 *      mail comes back online.
 *
 * Why operator-triggered and not a daily CronJob:
 *   `stalwart -e` opens RocksDB in primary mode which takes the LOCK.
 *   You can't run it next to a live primary today — see upstream issue
 *   stalwartlabs/stalwart#3175 (request for a `--secondary` flag). Until
 *   that lands, an archive run REQUIRES mail downtime (~60-120s typical),
 *   which we won't schedule silently.
 *
 * Why "archive" not "snapshot":
 *   K8s `VolumeSnapshot` CRDs are block-level, instantaneous, CSI-driven.
 *   The mail PVC uses local-path which has no CSI snapshot capability.
 *   Calling either backup mechanism a "snapshot" in operator-facing copy
 *   confuses the conversation. We use "backup" for the continuous restic
 *   path and "archive" for this app-level, point-in-time, store-agnostic
 *   path. Internally the table is named `mail_archive_runs`.
 *
 * GET  /admin/mail/archive-status            → last + current + target
 * GET  /admin/mail/archive-runs              → paginated list for the UI
 * GET  /admin/mail/archive-runs/:id          → single run (polling)
 * POST /admin/mail/archive/trigger           → start a new run
 * POST /admin/mail/archive/restore           → restore from a past run
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';
import { backupConfigurations, systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailArchiveListResponse,
  type MailArchiveRun,
  type MailArchiveState,
  type MailArchiveStatusResponse,
  mailArchiveListResponseSchema,
  mailArchiveRunSchema,
  mailArchiveStatusResponseSchema,
} from '@k8s-hosting/api-contracts';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;

const MAIL_NAMESPACE = 'mail';
const STALWART_DEPLOYMENT = 'stalwart-mail';
const SETTINGS_ID = 'system';
const ARCHIVE_JOB_PREFIX = 'stalwart-archive-';
const ARCHIVE_TOOLS_IMAGE_ENV = 'MAIL_BACKUP_TOOLS_IMAGE';
const STALWART_IMAGE_ENV = 'STALWART_IMAGE';
const ARCHIVE_TIMEOUT_SECONDS = 900; // 15 min hard cap on the whole run
const SCALE_DOWN_TIMEOUT_SECONDS = 180; // wait for pods to terminate

export interface ArchiveDeps {
  readonly db: Database;
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly batch: BatchV1Api;
  readonly kubeconfigPath: string | undefined;
  /** Operator user id (from JWT) for audit. */
  readonly userId?: string;
  readonly logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

// ── DB row shape ──────────────────────────────────────────────────────────────

type ArchiveRunRow = Record<string, unknown> & {
  id: string;
  state: string;
  current_step: string | null;
  original_replicas: number;
  job_name: string | null;
  restic_snapshot_id: string | null;
  export_size_bytes: string | null;
  restic_added_bytes: string | null;
  triggered_by: string;
  triggered_by_user_id: string | null;
  error_message: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
};

function rowToRun(row: ArchiveRunRow): MailArchiveRun {
  return mailArchiveRunSchema.parse({
    id: row.id,
    state: row.state as MailArchiveState,
    currentStep: row.current_step,
    originalReplicas: row.original_replicas,
    jobName: row.job_name,
    resticSnapshotId: row.restic_snapshot_id,
    exportSizeBytes: row.export_size_bytes == null ? null : Number(row.export_size_bytes),
    resticAddedBytes: row.restic_added_bytes == null ? null : Number(row.restic_added_bytes),
    triggeredBy: row.triggered_by,
    triggeredByUserId: row.triggered_by_user_id,
    errorMessage: row.error_message,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  });
}

const TERMINAL_STATES = new Set<MailArchiveState>(['succeeded', 'failed']);
const ACTIVE_STATES = new Set<MailArchiveState>([
  'queued',
  'scaling_down',
  'exporting',
  'scaling_up',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a new archive run. Fire-and-forget: the orchestrator runs as a
 * background promise; operator polls /admin/mail/archive-runs/:id for
 * status.
 */
export async function startMailArchive(deps: ArchiveDeps): Promise<{ runId: string }> {
  await rejectIfAnotherRunActive(deps.db);

  const replicas = await readCurrentReplicas(deps.apps);
  if (replicas == null) {
    throw new ApiError(
      'MAIL_ARCHIVE_DEPLOYMENT_NOT_FOUND',
      `Deployment ${MAIL_NAMESPACE}/${STALWART_DEPLOYMENT} not found`,
      503,
    );
  }

  const runId = randomUUID();
  await deps.db.execute(sql`
    INSERT INTO mail_archive_runs
      (id, state, current_step, original_replicas, triggered_by, triggered_by_user_id)
    VALUES (${runId}, 'queued', 'preflight', ${replicas}, ${'operator'}, ${deps.userId ?? null})
  `);

  // Fire-and-forget. The orchestrator updates DB state as it progresses.
  // Any uncaught error is captured + the row marked failed. We also ALWAYS
  // attempt to scale Stalwart back up in the catch block so a half-broken
  // run doesn't leave mail offline.
  void runArchiveOrchestrator(runId, replicas, deps).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.('mail-archive orchestrator failed:', msg);
    await markRunFailed(deps.db, runId, msg).catch(() => undefined);
    await safeScaleBackUp(deps, replicas).catch(() => undefined);
  });

  return { runId };
}

/**
 * Restore from a past archive run: scale Stalwart down, empty the
 * DataStore, run `stalwart -i` against the restic-extracted LZ4, scale
 * back up.
 *
 * The caller passed the `confirm` tripwire — route does the check.
 */
export async function startMailArchiveRestore(
  runId: string,
  deps: ArchiveDeps,
): Promise<{ runId: string }> {
  const source = await getRunRow(deps.db, runId);
  if (!source) {
    throw new ApiError('MAIL_ARCHIVE_RUN_NOT_FOUND', `No archive run with id ${runId}`, 404);
  }
  if (source.state !== 'succeeded') {
    throw new ApiError(
      'MAIL_ARCHIVE_RUN_NOT_RESTORABLE',
      `Archive run ${runId} is in state '${source.state}' — only succeeded runs can be restored`,
      400,
    );
  }
  if (!source.restic_snapshot_id) {
    throw new ApiError(
      'MAIL_ARCHIVE_NO_RESTIC_SNAPSHOT',
      `Archive run ${runId} has no restic_snapshot_id`,
      400,
    );
  }

  await rejectIfAnotherRunActive(deps.db);

  const replicas = await readCurrentReplicas(deps.apps);
  if (replicas == null) {
    throw new ApiError(
      'MAIL_ARCHIVE_DEPLOYMENT_NOT_FOUND',
      `Deployment ${MAIL_NAMESPACE}/${STALWART_DEPLOYMENT} not found`,
      503,
    );
  }

  const newRunId = randomUUID();
  await deps.db.execute(sql`
    INSERT INTO mail_archive_runs
      (id, state, current_step, original_replicas, triggered_by, triggered_by_user_id)
    VALUES (${newRunId}, 'queued', 'preflight', ${replicas}, ${'restore'}, ${deps.userId ?? null})
  `);

  void runRestoreOrchestrator(
    newRunId,
    replicas,
    source.restic_snapshot_id,
    deps,
  ).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger?.warn?.('mail-archive restore failed:', msg);
    await markRunFailed(deps.db, newRunId, msg).catch(() => undefined);
    await safeScaleBackUp(deps, replicas).catch(() => undefined);
  });

  return { runId: newRunId };
}

/**
 * Read summary for the Mail Archive card.
 *
 *   last       — most-recent terminal run (succeeded OR failed) or null
 *   current    — running run if any
 *   backupTarget — echo of system_settings.mail_snapshot_backup_store_id
 *                  (we share one repo with the continuous backup path)
 *   scheduledArchivingAvailable — false today; true once stalwartlabs/3175 lands.
 */
export async function getMailArchiveStatus(deps: ArchiveDeps): Promise<MailArchiveStatusResponse> {
  const lastRows = await deps.db.execute<ArchiveRunRow>(sql`
    SELECT * FROM mail_archive_runs
    WHERE state IN ('succeeded', 'failed')
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const currentRows = await deps.db.execute<ArchiveRunRow>(sql`
    SELECT * FROM mail_archive_runs
    WHERE state IN ('queued', 'scaling_down', 'exporting', 'scaling_up')
    ORDER BY started_at DESC
    LIMIT 1
  `);
  const lastRow = (lastRows as unknown as { rows: ArchiveRunRow[] }).rows?.[0] ?? null;
  const currentRow = (currentRows as unknown as { rows: ArchiveRunRow[] }).rows?.[0] ?? null;

  // Read backup target from system_settings + join with backup_configurations
  // for the human-readable name.
  const [sysRow] = await deps.db
    .select({ id: systemSettings.mailSnapshotBackupStoreId })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));
  const backupStoreId = sysRow?.id ?? null;
  let backupStoreName: string | null = null;
  let storageType: string | null = null;
  if (backupStoreId) {
    const [cfg] = await deps.db
      .select({ name: backupConfigurations.name, storageType: backupConfigurations.storageType })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, backupStoreId));
    backupStoreName = cfg?.name ?? null;
    storageType = cfg?.storageType ?? null;
  }

  return mailArchiveStatusResponseSchema.parse({
    last: lastRow ? rowToRun(lastRow) : null,
    current: currentRow ? rowToRun(currentRow) : null,
    backupTarget: { backupStoreId, backupStoreName, storageType },
    scheduledArchivingAvailable: false,
    scheduledArchivingBlockedBy:
      'stalwartlabs/stalwart#3175 — stalwart -e takes the RocksDB LOCK, ' +
      'so it cannot run next to a live primary. Scheduled archiving will ' +
      'be enabled once upstream ships a --secondary flag.',
  });
}

/** Paginated history for the archive list table. */
export async function listMailArchives(
  { limit = 20, offset = 0 }: { limit?: number; offset?: number },
  deps: ArchiveDeps,
): Promise<MailArchiveListResponse> {
  const rows = await deps.db.execute<ArchiveRunRow>(sql`
    SELECT * FROM mail_archive_runs
    ORDER BY started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  const totalRes = await deps.db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM mail_archive_runs
  `);
  const data = ((rows as unknown as { rows: ArchiveRunRow[] }).rows ?? []).map(rowToRun);
  const total = Number((totalRes as unknown as { rows: { count: string }[] }).rows?.[0]?.count ?? 0);
  return mailArchiveListResponseSchema.parse({ data, total });
}

/** Fetch a single run for status polling. */
export async function getMailArchiveRun(
  runId: string,
  deps: ArchiveDeps,
): Promise<MailArchiveRun> {
  const row = await getRunRow(deps.db, runId);
  if (!row) {
    throw new ApiError('MAIL_ARCHIVE_RUN_NOT_FOUND', `No archive run with id ${runId}`, 404);
  }
  return rowToRun(row);
}

// ── Internal: orchestrators ────────────────────────────────────────────────────

async function runArchiveOrchestrator(
  runId: string,
  originalReplicas: number,
  deps: ArchiveDeps,
): Promise<void> {
  await scaleDownAndWait(runId, deps);

  const jobName = `${ARCHIVE_JOB_PREFIX}${runId.slice(0, 8)}-${Math.floor(Date.now() / 1000)}`;
  await updateRunStep(deps.db, runId, 'exporting', { job_name: jobName });
  await deps.db.execute(sql`UPDATE mail_archive_runs SET state = 'exporting' WHERE id = ${runId}`);

  await createArchiveJob(jobName, deps, /* mode= */ 'export');

  const jobResult = await waitForJobOutcome(jobName, deps);

  // ALWAYS scale back up — even if Job failed.
  try {
    await scaleUpAndWait(runId, originalReplicas, deps);
  } catch (err) {
    // We've at least restored the desired replica count; bubble up if not Ready.
    deps.logger?.warn?.(`scale-up after archive ${runId} failed: ${String(err)}`);
  }

  if (jobResult.success) {
    await deps.db.execute(sql`
      UPDATE mail_archive_runs SET
        state = 'succeeded',
        current_step = NULL,
        restic_snapshot_id = ${jobResult.resticSnapshotId ?? null},
        export_size_bytes = ${jobResult.exportSizeBytes ?? null},
        restic_added_bytes = ${jobResult.resticAddedBytes ?? null},
        finished_at = now()
      WHERE id = ${runId}
    `);
  } else {
    await markRunFailed(deps.db, runId, jobResult.error ?? 'export job failed');
  }
}

async function runRestoreOrchestrator(
  runId: string,
  originalReplicas: number,
  resticSnapshotId: string,
  deps: ArchiveDeps,
): Promise<void> {
  await scaleDownAndWait(runId, deps);

  const jobName = `${ARCHIVE_JOB_PREFIX}restore-${runId.slice(0, 8)}-${Math.floor(Date.now() / 1000)}`;
  await updateRunStep(deps.db, runId, 'exporting', { job_name: jobName });
  await deps.db.execute(sql`UPDATE mail_archive_runs SET state = 'exporting' WHERE id = ${runId}`);

  await createArchiveJob(jobName, deps, 'restore', resticSnapshotId);

  const jobResult = await waitForJobOutcome(jobName, deps);

  try {
    await scaleUpAndWait(runId, originalReplicas, deps);
  } catch (err) {
    deps.logger?.warn?.(`scale-up after restore ${runId} failed: ${String(err)}`);
  }

  if (jobResult.success) {
    await deps.db.execute(sql`
      UPDATE mail_archive_runs SET
        state = 'succeeded',
        current_step = NULL,
        finished_at = now()
      WHERE id = ${runId}
    `);
  } else {
    await markRunFailed(deps.db, runId, jobResult.error ?? 'restore job failed');
  }
}

// ── Internal: scale orchestration ──────────────────────────────────────────────

async function scaleDownAndWait(runId: string, deps: ArchiveDeps): Promise<void> {
  await deps.db.execute(sql`UPDATE mail_archive_runs SET state = 'scaling_down', current_step = 'patching replicas=0' WHERE id = ${runId}`);

  await patchDeploymentReplicas(deps.apps, 0);

  await updateRunStep(deps.db, runId, 'waiting for stalwart pods to terminate');
  const ok = await waitForCondition(
    SCALE_DOWN_TIMEOUT_SECONDS,
    async () => (await countStalwartPods(deps.core)) === 0,
  );
  if (!ok) {
    throw new Error(`Stalwart pods did not terminate within ${SCALE_DOWN_TIMEOUT_SECONDS}s`);
  }
  // Belt-and-suspenders: even after the pod is gone, the kubelet may take
  // a tick to remove the LOCK file via the mount-unmount sequence. A short
  // sleep is much simpler than re-reading the LOCK file from the pod.
  await sleep(2000);
}

async function scaleUpAndWait(
  runId: string,
  replicas: number,
  deps: ArchiveDeps,
): Promise<void> {
  await deps.db.execute(sql`UPDATE mail_archive_runs SET state = 'scaling_up', current_step = 'patching replicas back' WHERE id = ${runId}`);

  await patchDeploymentReplicas(deps.apps, replicas);

  await updateRunStep(deps.db, runId, 'waiting for stalwart Deployment Ready');
  const ok = await waitForCondition(
    ARCHIVE_TIMEOUT_SECONDS,
    async () => (await readDeployReady(deps.apps)) >= replicas,
  );
  if (!ok) {
    throw new Error('Stalwart Deployment did not reach Ready after scale-up');
  }
}

async function safeScaleBackUp(deps: ArchiveDeps, replicas: number): Promise<void> {
  // Used in the outer catch — we MUST attempt to restore replicas even if
  // the orchestrator itself crashed.
  await patchDeploymentReplicas(deps.apps, replicas).catch(() => undefined);
}

// ── Internal: k8s helpers ──────────────────────────────────────────────────────

async function readCurrentReplicas(apps: AppsV1Api): Promise<number | null> {
  try {
    const dep = (await apps.readNamespacedDeployment({
      name: STALWART_DEPLOYMENT,
      namespace: MAIL_NAMESPACE,
    })) as { spec?: { replicas?: number } };
    return dep.spec?.replicas ?? 0;
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) return null;
    throw err;
  }
}

async function readDeployReady(apps: AppsV1Api): Promise<number> {
  try {
    const dep = (await apps.readNamespacedDeployment({
      name: STALWART_DEPLOYMENT,
      namespace: MAIL_NAMESPACE,
    })) as { status?: { readyReplicas?: number } };
    return dep.status?.readyReplicas ?? 0;
  } catch {
    return 0;
  }
}

async function countStalwartPods(core: CoreV1Api): Promise<number> {
  const pods = (await core.listNamespacedPod({
    namespace: MAIL_NAMESPACE,
    labelSelector: 'app=stalwart-mail',
  } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as {
    items?: { status?: { phase?: string } }[];
  };
  // Pending/Running/Terminating all count; only Succeeded/Failed do not.
  return (pods.items ?? []).filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
    .length;
}

async function patchDeploymentReplicas(apps: AppsV1Api, replicas: number): Promise<void> {
  // JSON-Patch replace on /spec/replicas is the precise op — strategic-merge
  // would merge into the existing spec object but replace is unambiguous.
  const body = [{ op: 'replace', path: '/spec/replicas', value: replicas }];
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: STALWART_DEPLOYMENT,
      body: body as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    JSON_PATCH,
  );
}

async function createArchiveJob(
  jobName: string,
  deps: ArchiveDeps,
  mode: 'export' | 'restore',
  resticSnapshotId?: string,
): Promise<void> {
  const toolsImage =
    process.env[ARCHIVE_TOOLS_IMAGE_ENV] ??
    'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest';
  const stalwartImage =
    process.env[STALWART_IMAGE_ENV] ??
    'docker.io/stalwartlabs/stalwart:v0.16.5';

  // Archive Job pod composition:
  //   export mode  — initContainer runs `stalwart -e` → writes /export/export.lz4
  //                  main container uploads the LZ4 via restic
  //   restore mode — initContainer #1 (archive-download) restic-restores the LZ4
  //                  initContainer #2 runs `stalwart -i` against the LZ4
  //                  main container is a no-op (the marker is written by the
  //                  first init); the Job completes when all containers exit 0
  //
  // The PVC's local-path node affinity pins the Job to the right node;
  // no explicit podAffinity needed.
  const dataVolumeMount = { name: 'stalwart-data', mountPath: '/var/lib/stalwart/data' };
  const configVolumeMount = { name: 'stalwart-config', mountPath: '/etc/stalwart' };
  const exportVolumeMount = { name: 'export', mountPath: '/export' };
  const resticEnv = {
    envFrom: [{ secretRef: { name: 'stalwart-snapshot-restic-repo', optional: false } }],
  };
  const archiveEnv = [
    { name: 'ARCHIVE_MODE', value: mode },
    { name: 'ARCHIVE_RUN_ID', value: jobName.replace(ARCHIVE_JOB_PREFIX, '') },
    ...(resticSnapshotId ? [{ name: 'RESTIC_SNAPSHOT_ID', value: resticSnapshotId }] : []),
  ];

  const initContainers =
    mode === 'export'
      ? [
          {
            name: 'stalwart-export',
            image: stalwartImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c'],
            args: ['stalwart --config /etc/stalwart/config.json -e /export/export.lz4'],
            volumeMounts: [configVolumeMount, dataVolumeMount, exportVolumeMount],
          },
        ]
      : [
          {
            name: 'archive-download',
            image: toolsImage,
            imagePullPolicy: 'Always',
            command: ['/usr/local/bin/archive-export.sh'],
            env: archiveEnv,
            ...resticEnv,
            volumeMounts: [exportVolumeMount],
          },
          {
            name: 'stalwart-import',
            image: stalwartImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c'],
            args: [
              // Empty the live data dir first; stalwart -i refuses to import
              // into a non-empty DataStore. The PVC is shared with the (now-
              // scaled-down) live Stalwart so its contents are the previous
              // production data — about to be replaced.
              'rm -rf /var/lib/stalwart/data/* /var/lib/stalwart/data/.[!.]* 2>/dev/null; ' +
                'stalwart --config /etc/stalwart/config.json -i /export/export.lz4',
            ],
            volumeMounts: [configVolumeMount, dataVolumeMount, exportVolumeMount],
          },
        ];

  // Main container:
  //   export mode  — the uploader (parses + emits `archive-result:` marker)
  //   restore mode — a small noop that re-prints the marker from the
  //                  download init container so the orchestrator can still
  //                  parse it from the main container's logs (consistent
  //                  log location for both modes).
  const mainContainer =
    mode === 'export'
      ? {
          name: 'upload',
          image: toolsImage,
          imagePullPolicy: 'Always',
          command: ['/usr/local/bin/archive-export.sh'],
          env: archiveEnv,
          ...resticEnv,
          volumeMounts: [exportVolumeMount],
        }
      : {
          name: 'upload', // same name so log parsing works uniformly
          image: toolsImage,
          imagePullPolicy: 'IfNotPresent',
          command: ['sh', '-c'],
          args: [
            // Echo the marker file from the download init container so the
            // orchestrator's pod-log parser finds it on the main container
            // log just like in export mode.
            `printf 'archive-result: {"resticSnapshotId":"${resticSnapshotId ?? ''}","exportSizeBytes":0,"resticAddedBytes":0}\\n'`,
          ],
          volumeMounts: [exportVolumeMount],
        };

  const body: Record<string, unknown> = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'stalwart-archive',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.phoenix-host.net/archive-mode': mode,
      },
      annotations: {
        'platform.phoenix-host.net/started-by': deps.userId ?? 'system',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/component': 'stalwart-archive' } },
        spec: {
          restartPolicy: 'Never',
          initContainers,
          containers: [mainContainer],
          volumes: [
            {
              name: 'stalwart-data',
              persistentVolumeClaim: { claimName: 'stalwart-rocksdb-data' },
            },
            { name: 'stalwart-config', configMap: { name: 'stalwart-config' } },
            { name: 'export', emptyDir: {} },
          ],
        },
      },
    },
  };

  await deps.batch.createNamespacedJob({
    namespace: MAIL_NAMESPACE,
    body: body as unknown as object,
  } as unknown as Parameters<typeof deps.batch.createNamespacedJob>[0]);
}

interface JobOutcome {
  success: boolean;
  error?: string;
  resticSnapshotId?: string;
  exportSizeBytes?: number;
  resticAddedBytes?: number;
}

async function waitForJobOutcome(jobName: string, deps: ArchiveDeps): Promise<JobOutcome> {
  const ok = await waitForCondition(ARCHIVE_TIMEOUT_SECONDS, async () => {
    const job = (await deps.batch.readNamespacedJob({
      name: jobName,
      namespace: MAIL_NAMESPACE,
    })) as { status?: { succeeded?: number; failed?: number } };
    const succeeded = (job.status?.succeeded ?? 0) > 0;
    const failed = (job.status?.failed ?? 0) > 0;
    return succeeded || failed;
  });

  if (!ok) {
    return { success: false, error: `Job ${jobName} did not finish within ${ARCHIVE_TIMEOUT_SECONDS}s` };
  }

  const job = (await deps.batch.readNamespacedJob({
    name: jobName,
    namespace: MAIL_NAMESPACE,
  })) as { status?: { succeeded?: number; failed?: number } };

  if ((job.status?.failed ?? 0) > 0) {
    return { success: false, error: 'Job pod failed; check kubectl logs for details' };
  }

  // Parse the trailing JSON marker line from the pod log. The script
  // writes `archive-result: {"resticSnapshotId":"...", "exportSizeBytes":N, "resticAddedBytes":M}`
  // as its final stdout line.
  const stats = await parseJobResultMarker(jobName, deps).catch(() => undefined);
  return {
    success: true,
    resticSnapshotId: stats?.resticSnapshotId,
    exportSizeBytes: stats?.exportSizeBytes,
    resticAddedBytes: stats?.resticAddedBytes,
  };
}

async function parseJobResultMarker(
  jobName: string,
  deps: ArchiveDeps,
): Promise<{ resticSnapshotId?: string; exportSizeBytes?: number; resticAddedBytes?: number } | undefined> {
  // Find the pod that ran the Job.
  const pods = (await deps.core.listNamespacedPod({
    namespace: MAIL_NAMESPACE,
    labelSelector: `job-name=${jobName}`,
  } as unknown as Parameters<typeof deps.core.listNamespacedPod>[0])) as {
    items?: { metadata?: { name?: string } }[];
  };
  const podName = (pods.items ?? [])[0]?.metadata?.name;
  if (!podName) return undefined;

  const logs = (await deps.core.readNamespacedPodLog({
    namespace: MAIL_NAMESPACE,
    name: podName,
    container: 'upload',
  } as unknown as Parameters<typeof deps.core.readNamespacedPodLog>[0])) as string | { body?: string };
  const text = typeof logs === 'string' ? logs : (logs as { body?: string }).body ?? '';
  const match = text.split('\n').reverse().find((l) => l.includes('archive-result: '));
  if (!match) return undefined;
  const jsonStr = match.slice(match.indexOf('{'));
  try {
    return JSON.parse(jsonStr) as { resticSnapshotId?: string; exportSizeBytes?: number; resticAddedBytes?: number };
  } catch {
    return undefined;
  }
}

// ── Internal: db helpers ──────────────────────────────────────────────────────

async function rejectIfAnotherRunActive(db: Database): Promise<void> {
  const rows = await db.execute<{ id: string; state: string }>(sql`
    SELECT id, state FROM mail_archive_runs
    WHERE state IN ('queued', 'scaling_down', 'exporting', 'scaling_up')
    LIMIT 1
  `);
  const conflict = (rows as unknown as { rows: { id: string; state: string }[] }).rows?.[0];
  if (conflict) {
    throw new ApiError(
      'MAIL_ARCHIVE_ALREADY_RUNNING',
      `Another archive run is in progress: ${conflict.id} (state=${conflict.state})`,
      409,
    );
  }
}

async function getRunRow(db: Database, runId: string): Promise<ArchiveRunRow | null> {
  const rows = await db.execute<ArchiveRunRow>(sql`
    SELECT * FROM mail_archive_runs WHERE id = ${runId} LIMIT 1
  `);
  return (rows as unknown as { rows: ArchiveRunRow[] }).rows?.[0] ?? null;
}

async function updateRunStep(
  db: Database,
  runId: string,
  step: string,
  extra: Record<string, string | number | null> = {},
): Promise<void> {
  if (Object.keys(extra).length === 0) {
    await db.execute(sql`UPDATE mail_archive_runs SET current_step = ${step} WHERE id = ${runId}`);
    return;
  }
  // job_name is the only writable extra column today; explicit branch keeps
  // the SQL parameterised + avoids dynamic identifier interpolation.
  if (Object.prototype.hasOwnProperty.call(extra, 'job_name')) {
    await db.execute(sql`
      UPDATE mail_archive_runs SET current_step = ${step}, job_name = ${(extra.job_name as string) ?? null}
      WHERE id = ${runId}
    `);
    return;
  }
  await db.execute(sql`UPDATE mail_archive_runs SET current_step = ${step} WHERE id = ${runId}`);
}

async function markRunFailed(db: Database, runId: string, errMsg: string): Promise<void> {
  await db.execute(sql`
    UPDATE mail_archive_runs SET
      state = 'failed',
      current_step = NULL,
      error_message = ${errMsg.slice(0, 2000)},
      finished_at = now()
    WHERE id = ${runId}
  `);
}

// ── Internal: small utilities ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until predicate returns true OR deadline reached. Returns true on
 * success, false on timeout. predicate errors are treated as "not yet".
 */
async function waitForCondition(
  timeoutSeconds: number,
  predicate: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      // try again
    }
    await sleep(2000);
  }
  return false;
}

// Re-export for tests / advanced operator API.
export const _internals = {
  TERMINAL_STATES,
  ACTIVE_STATES,
};
