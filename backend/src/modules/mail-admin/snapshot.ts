/**
 * Mail snapshot management — restic backup of the raw RocksDB DataStore
 * via the `stalwart-snapshot` CronJob.
 *
 * NOT `stalwart -e`. That's mechanism #2 (mail-admin/archive.ts), a
 * logical export operator-triggered from /email/operations. This module
 * is mechanism #1: continuous file-level backup of /var/lib/mail-stack/
 * to a restic repo on the configured BackupTarget.
 *
 * Why direct restic and not `stalwart -e`: `stalwart -e` opens RocksDB
 * which causes a LOCK conflict with the live Stalwart process. restic
 * just reads the immutable SST files, so it can run with the PVC mounted
 * RO while Stalwart keeps serving SMTP/IMAP.
 *
 * The CronJob (k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml)
 * runs every 2 minutes. This module manages + observes it, and can
 * trigger one-shot manual Jobs (used by the migration state machine's
 * pre-migration backup step).
 *
 * The companion `restore-state` initContainer in the Stalwart Deployment
 * runs `restic restore <id>` on a fresh PVC, where <id> is either
 * `latest` (default) or the snapshot pinned via the
 * `mail.platform/restore-snapshot-id` annotation (per-snapshot restore
 * flow from /backups/mail).
 *
 * GET  /admin/mail/snapshot-status
 * POST /admin/mail/snapshot/trigger
 * GET  /admin/mail/snapshot/jobs/:name
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailSnapshotStatusResponse,
  type MailSnapshotTriggerResponse,
  type MailSnapshotJobStatusResponse,
  mailSnapshotStatusResponseSchema,
  mailSnapshotTriggerResponseSchema,
  mailSnapshotJobStatusResponseSchema,
} from '@insula/api-contracts';

const MAIL_NAMESPACE = 'mail';
const SNAPSHOT_CRONJOB_NAME = 'stalwart-snapshot';
const SNAPSHOT_JOB_LABEL_KEY = 'app.kubernetes.io/component';
const SNAPSHOT_JOB_LABEL_VALUE = 'stalwart-snapshot';
const SNAPSHOT_JOB_MANUAL_PREFIX = 'stalwart-snapshot-manual-';
/** A snapshot is considered stale if its age exceeds this threshold. */
const SNAPSHOT_STALE_THRESHOLD_SECONDS = 300; // 5 minutes

const SETTINGS_ID = 'system';

export interface SnapshotOptions {
  readonly kubeconfigPath: string | undefined;
  readonly db?: Database;
}

interface K8sTenantsBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
  batch: import('@kubernetes/client-node').BatchV1Api;
}

async function loadK8sTenants(kubeconfigPath: string | undefined): Promise<K8sTenantsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
  };
}

function randomShort(): string {
  // Lowercase alnum 8 chars — fits in K8s name constraints.
  return Math.random().toString(36).slice(2, 10);
}

interface CronJobShape {
  spec?: {
    schedule?: string;
    suspend?: boolean;
    jobTemplate?: {
      spec?: Record<string, unknown>;
    };
  };
}

/**
 * Minimal Job shape consumed by snapshot.ts. Exported so callers
 * (notably the migration state machine) can declare a `readJob`
 * function for `waitForSnapshotJob` without re-deriving the type via
 * a conditional-type cast off `Parameters<typeof waitForSnapshotJob>`.
 * The real `@kubernetes/client-node` `V1Job` is a structural superset
 * of this — downcasting `V1Job → JobShape` is always safe.
 */
export interface JobShape {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  status?: {
    startTime?: string;
    completionTime?: string;
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: { type: string; status: string; message?: string }[];
  };
}

/**
 * Typed sentinel for cancel-from-operator. The outer migration state
 * machine catches this and routes to the cancel path (rather than the
 * "snapshot failed, warn-and-continue" path). Switching from a regex
 * match on the error message to a typed sentinel makes the contract
 * resilient against future error-message wording changes.
 */
export class SnapshotCancelledError extends Error {
  override readonly name = 'SnapshotCancelledError';
  constructor(jobName: string) {
    super(`snapshot Job ${jobName} wait cancelled by operator`);
  }
}

// Public API: also export the namespace constant + a label-safe
// validator so external callers don't have to re-derive either.
export { MAIL_NAMESPACE };

interface JobListShape {
  items?: JobShape[];
}

function jobStatusFromConditions(
  job: JobShape,
): MailSnapshotJobStatusResponse['status'] {
  const conds = job.status?.conditions ?? [];
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'succeeded';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'failed';
  if ((job.status?.active ?? 0) > 0) return 'running';
  if (job.status?.startTime) return 'running';
  return 'queued';
}

/**
 * GET /admin/mail/snapshot-status
 *
 * Returns the live state of the stalwart-snapshot CronJob + the most recent
 * Job it produced. Does NOT fetch pod logs (too expensive for a status poll).
 */
export async function getMailSnapshotStatus(
  opts: SnapshotOptions,
): Promise<MailSnapshotStatusResponse> {
  const { batch } = await loadK8sTenants(opts.kubeconfigPath);

  // ── 1. Read the CronJob to check enabled/schedule ──────────────────
  let cronJob: CronJobShape | null = null;
  try {
    cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as CronJobShape;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code !== 404) throw err;
    // CronJob does not exist → disabled
  }

  const enabled = cronJob != null && !cronJob.spec?.suspend;
  const scheduleExpression = cronJob?.spec?.schedule ?? '*/2 * * * *';

  // ── 2. List Jobs with the snapshot label ──────────────────────────
  let jobs: JobShape[] = [];
  try {
    const result = await batch.listNamespacedJob({
      namespace: MAIL_NAMESPACE,
      labelSelector: `${SNAPSHOT_JOB_LABEL_KEY}=${SNAPSHOT_JOB_LABEL_VALUE}`,
    } as unknown as Parameters<typeof batch.listNamespacedJob>[0]) as JobListShape;
    jobs = result.items ?? [];
  } catch {
    // Non-fatal — we'll just report no jobs
    jobs = [];
  }

  // Count only successfully completed Jobs — failed/running jobs are not
  // persisted snapshots. TTL-GC means the window is ~1h for automatic jobs.
  const snapshotCount = jobs.filter((j) =>
    (j.status?.conditions ?? []).some((c) => c.type === 'Complete' && c.status === 'True'),
  ).length;

  // ── 3. Find the most recently completed Job ────────────────────────
  const successfulJobs = jobs.filter((j) => {
    const conds = j.status?.conditions ?? [];
    return conds.some((c) => c.type === 'Complete' && c.status === 'True');
  });

  // Sort descending by completionTime to find the most recent.
  // The k8s tenant returns completionTime as a Date object at runtime
  // despite the interface typing it as string — use getTime() for comparison.
  successfulJobs.sort((a, b) => {
    const ta = a.status?.completionTime ? new Date(a.status.completionTime).getTime() : 0;
    const tb = b.status?.completionTime ? new Date(b.status.completionTime).getTime() : 0;
    return tb - ta;
  });

  const lastJob = successfulJobs[0] ?? null;
  const rawCompletionTime = lastJob?.status?.completionTime ?? null;
  const lastSnapshotAt = rawCompletionTime
    ? new Date(rawCompletionTime).toISOString()
    : null;

  // ── 4. Compute seconds since last snapshot ────────────────────────
  let secondsSinceLastSnapshot: number | null = null;
  if (lastSnapshotAt) {
    const elapsed = Math.floor(
      (Date.now() - new Date(lastSnapshotAt).getTime()) / 1000,
    );
    secondsSinceLastSnapshot = Math.max(0, elapsed);
  }

  // ── 5. Determine health ───────────────────────────────────────────
  // Healthy when: CronJob is enabled AND either no snapshot exists yet
  // (schedule hasn't fired yet) OR the last snapshot is fresh.
  const healthy = enabled && (
    lastSnapshotAt === null ||
    (secondsSinceLastSnapshot !== null &&
      secondsSinceLastSnapshot < SNAPSHOT_STALE_THRESHOLD_SECONDS)
  );

  // Read persisted stats + backup store from system_settings (best-effort).
  let backupStoreId: string | null = null;
  let totalSnapshotSizeBytes: number | null = null;
  let resticSnapshotCount: number | null = null;
  if (opts.db) {
    try {
      const [row] = await opts.db.select({
        backupStoreId: systemSettings.mailSnapshotBackupStoreId,
        lastRunStats: systemSettings.mailSnapshotLastRunStats,
      }).from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
      backupStoreId = row?.backupStoreId ?? null;
      if (row?.lastRunStats) {
        totalSnapshotSizeBytes = row.lastRunStats.totalSnapshotSizeBytes ?? null;
        resticSnapshotCount = row.lastRunStats.snapshotCount ?? null;
      }
    } catch {
      // Non-fatal — fall back to nulls.
    }
  }

  return mailSnapshotStatusResponseSchema.parse({
    enabled,
    scheduleExpression,
    lastSnapshotAt: lastSnapshotAt ?? null,
    lastSnapshotSizeBytes: null, // not available from Job metadata
    totalSnapshotSizeBytes,
    snapshotCount: resticSnapshotCount ?? snapshotCount,
    secondsSinceLastSnapshot,
    healthy,
    backupStoreId,
  });
}

/**
 * Optional tagging for snapshots spawned outside the routine CronJob
 * cadence (e.g. the migration state machine's pre-migration safety net).
 * Propagated to the Job's container env (`EXTRA_RESTIC_TAGS`) so
 * `snapshot-upload.sh` adds them as restic `--tag` args at backup time.
 * Also stamped as Job labels so the UI can filter without parsing tags.
 *
 * 2026-05-29: added to fix the operator-visibility gap where
 * pre-migration snapshots were indistinguishable from the every-two-min
 * routine snapshots in /backups/mail?tab=backups.
 */
export interface SnapshotPurposeOptions {
  /** Single-token classifier — currently `pre-migration` is the only caller. */
  readonly purpose?: string;
  /** Migration run id for cross-referencing in the UI. */
  readonly runId?: string;
}

/**
 * Label-safe charset enforcement for `purpose` + `runId`. Both end up
 * as Kubernetes label values (DNS-1123-derived: `[a-zA-Z0-9][-_.A-Za-z0-9]*`,
 * max 63 chars) AND as restic --tag args via shell word-splitting
 * inside snapshot-upload.sh. The intersection of "safe in k8s labels"
 * and "no shell meaning at all" is `[A-Za-z0-9._-]`. Reject anything
 * else at the API boundary so a future caller that exposes these to
 * operator input can't smuggle backticks/`;`/`$()` into either path.
 *
 * Today the only caller (migration.ts) passes the hard-coded literal
 * `'pre-migration'` plus a server-generated UUID — both pass — so this
 * is forward-looking defence-in-depth, not a live-exploit fix.
 */
const LABEL_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

function assertLabelSafe(value: string, field: string): void {
  if (!LABEL_SAFE_RE.test(value)) {
    throw new ApiError(
      'INVALID_SNAPSHOT_LABEL',
      `${field} must match [A-Za-z0-9][A-Za-z0-9._-]{0,62} — got '${value.slice(0, 50)}'`,
      400,
    );
  }
}

/**
 * POST /admin/mail/snapshot/trigger
 *
 * Spawns a one-shot Job based on the stalwart-snapshot CronJob template.
 * Returns immediately with the Job name. UI polls
 * GET /admin/mail/snapshot/jobs/:name for status.
 */
export async function triggerMailSnapshot(
  opts: SnapshotOptions & SnapshotPurposeOptions,
): Promise<MailSnapshotTriggerResponse> {
  // Enforce label-safe charset FIRST — before any k8s/DB calls. Without
  // this ordering, validation regressions would surface as a confusing
  // ENOENT / ECONNREFUSED from the kube-config step and operators
  // wouldn't realise the actual issue was an unsafe `purpose` token.
  if (opts.purpose !== undefined) assertLabelSafe(opts.purpose, 'purpose');
  if (opts.runId !== undefined) assertLabelSafe(opts.runId, 'runId');

  // DR safety: if the `mail` backup class is bound to a frozen target,
  // refuse the snapshot before we spawn the Job. Otherwise the Job
  // will fail mid-flight against the upstream that the shim refuses
  // to write through.
  if (opts.db) {
    const { eq, inArray } = await import('drizzle-orm');
    const { backupTargetAssignments, backupConfigurations } = await import('../../db/schema.js');
    const rows = await opts.db
      .select({ targetId: backupTargetAssignments.targetId })
      .from(backupTargetAssignments)
      .innerJoin(
        backupConfigurations,
        eq(backupConfigurations.id, backupTargetAssignments.targetId),
      )
      .where(inArray(backupTargetAssignments.backupClass, ['mail']))
      .orderBy(backupTargetAssignments.priority)
      .limit(1);
    if (rows[0]?.targetId) {
      const { requireWritableTarget } = await import('../backup-config/writable-guard.js');
      await requireWritableTarget(opts.db, rows[0].targetId);
    }
  }

  const { batch } = await loadK8sTenants(opts.kubeconfigPath);

  // Read the CronJob to get the job template
  let cronJob: CronJobShape | null = null;
  try {
    cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as CronJobShape;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError(
        'SNAPSHOT_CRONJOB_NOT_FOUND',
        'stalwart-snapshot CronJob does not exist — apply the manifest first',
        404,
      );
    }
    throw err;
  }

  const jobName = `${SNAPSHOT_JOB_MANUAL_PREFIX}${randomShort()}`;
  const startedAt = new Date().toISOString();

  const jobManifest = renderManualSnapshotJob(jobName, cronJob, {
    purpose: opts.purpose,
    runId: opts.runId,
  });

  try {
    await batch.createNamespacedJob({
      namespace: MAIL_NAMESPACE,
      body: jobManifest as unknown as object,
    });
  } catch (err) {
    throw new ApiError(
      'SNAPSHOT_JOB_CREATE_FAILED',
      `failed to create snapshot Job: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  return mailSnapshotTriggerResponseSchema.parse({
    jobName,
    startedAt,
  });
}

/**
 * GET /admin/mail/snapshot/jobs/:name
 *
 * Poll endpoint — the UI reads this every 3s while the Job is running.
 * Returns the Job status + last 50 lines of pod log.
 */
export async function getMailSnapshotJobStatus(
  jobName: string,
  opts: SnapshotOptions,
): Promise<MailSnapshotJobStatusResponse> {
  if (!/^stalwart-snapshot-(?:manual-|)[a-z0-9-]+$/.test(jobName)) {
    throw new ApiError(
      'SNAPSHOT_JOB_INVALID_NAME',
      'job name must match the stalwart-snapshot-* shape',
      400,
    );
  }

  const { core, batch } = await loadK8sTenants(opts.kubeconfigPath);

  const job = await batch.readNamespacedJob({
    namespace: MAIL_NAMESPACE,
    name: jobName,
  }).catch((err) => {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError('SNAPSHOT_JOB_NOT_FOUND', `job ${jobName} not found`, 404);
    }
    throw err;
  }) as JobShape;

  const status = jobStatusFromConditions(job);
  const rawStartTime = job.status?.startTime ?? null;
  const rawCompletionTime = job.status?.completionTime ?? null;
  const startedAt = rawStartTime ? new Date(rawStartTime).toISOString() : null;
  const completedAt = rawCompletionTime ? new Date(rawCompletionTime).toISOString() : null;
  const failureReason =
    (job.status?.conditions ?? []).find((c) => c.type === 'Failed')?.message ?? null;

  // Read Pod log (best-effort)
  let podLogTail: string | null = null;
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: `job-name=${jobName}`,
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as {
      items?: { metadata?: { name?: string } }[];
    };
    const podName = pods.items?.[0]?.metadata?.name;
    if (podName) {
      const log = await core.readNamespacedPodLog({
        namespace: MAIL_NAMESPACE,
        name: podName,
        tailLines: 50,
        // Read from the `snapshot` container.
        container: 'snapshot',
      });
      podLogTail =
        typeof log === 'string' ? log : (log as { body?: string }).body ?? null;
    }
  } catch {
    podLogTail = null;
  }

  return mailSnapshotJobStatusResponseSchema.parse({
    jobName,
    status,
    startedAt,
    completedAt,
    podLogTail,
    failureReason,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Render a one-shot Job from the CronJob's jobTemplate spec.
 * The Job is labelled with stalwart-snapshot so it shows up in
 * `getMailSnapshotStatus()` counts and the snapshot-status poll.
 *
 * When `opts.purpose` is set, the rendered Job carries:
 *   - Labels `mail.platform/snapshot-purpose=<purpose>` and (if runId)
 *     `mail.platform/migration-run-id=<runId>` for cheap filtering.
 *   - Container env `EXTRA_RESTIC_TAGS="<purpose> [run=<runId>]"` that
 *     `snapshot-upload.sh` picks up and passes to `restic backup --tag`.
 *
 * The combination lets the UI surface a "pre-migration" badge in the
 * /backups/mail?tab=backups list (via restic tags) without parsing
 * restic JSON in a hot path (label-based filtering on Job inventory
 * is enough for in-flight status).
 */
function renderManualSnapshotJob(
  jobName: string,
  cronJob: CronJobShape,
  opts: SnapshotPurposeOptions = {},
): unknown {
  const jobTemplateSpec = (cronJob.spec?.jobTemplate?.spec ?? {}) as Record<string, unknown>;

  const purposeTagTokens: string[] = [];
  if (opts.purpose) purposeTagTokens.push(opts.purpose);
  if (opts.runId) purposeTagTokens.push(`run=${opts.runId}`);
  const extraTagsValue = purposeTagTokens.join(' ');

  const purposeLabels: Record<string, string> = {};
  if (opts.purpose) purposeLabels['mail.platform/snapshot-purpose'] = opts.purpose;
  if (opts.runId) purposeLabels['mail.platform/migration-run-id'] = opts.runId;

  // Deep-clone the template's container[0] env to avoid mutating the
  // CronJob spec we just read. The CronJob template's first container
  // is the snapshot uploader (see snapshot-cronjob.yaml). If the
  // template ever changes shape, the safest no-op is to return the
  // job unchanged so a manifest evolution doesn't break this path.
  const podTemplate = (jobTemplateSpec.template as Record<string, unknown> | undefined) ?? {};
  const podSpec = (podTemplate.spec as Record<string, unknown> | undefined) ?? {};
  const containers = Array.isArray(podSpec.containers)
    ? (podSpec.containers as Array<Record<string, unknown>>)
    : [];

  let templateWithExtraTags = podTemplate;
  if (extraTagsValue && containers.length > 0) {
    const first = { ...containers[0] };
    const env = Array.isArray(first.env)
      ? [...(first.env as Array<{ name: string; value: string }>)]
      : [];
    // Replace any existing EXTRA_RESTIC_TAGS (idempotency).
    const filteredEnv = env.filter((e) => e?.name !== 'EXTRA_RESTIC_TAGS');
    filteredEnv.push({ name: 'EXTRA_RESTIC_TAGS', value: extraTagsValue });
    first.env = filteredEnv;
    const newContainers = [first, ...containers.slice(1)];
    templateWithExtraTags = {
      ...podTemplate,
      spec: { ...podSpec, containers: newContainers },
    };
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: MAIL_NAMESPACE,
      labels: {
        [SNAPSHOT_JOB_LABEL_KEY]: SNAPSHOT_JOB_LABEL_VALUE,
        'stalwart-snapshot-trigger': 'manual',
        ...purposeLabels,
      },
    },
    spec: {
      ...jobTemplateSpec,
      // Override ttlSecondsAfterFinished so manual jobs are visible for 1 hour
      ttlSecondsAfterFinished: 3600,
      template: {
        ...templateWithExtraTags,
        metadata: {
          labels: {
            [SNAPSHOT_JOB_LABEL_KEY]: SNAPSHOT_JOB_LABEL_VALUE,
            'job-name': jobName,
            'stalwart-snapshot-trigger': 'manual',
            ...purposeLabels,
          },
        },
      },
    },
  };
}

/**
 * Test-only export — exposes the rendering function so unit tests can
 * assert the Job manifest shape without spinning up k8s. The function
 * itself is private so external callers can't accidentally bypass
 * `triggerMailSnapshot`'s pre-flight checks (BackupTarget freeze
 * detection, CronJob 404 handling, etc.).
 */
export function renderManualSnapshotJobForTest(
  jobName: string,
  cronJob: CronJobShape,
  opts: SnapshotPurposeOptions = {},
): unknown {
  return renderManualSnapshotJob(jobName, cronJob, opts);
}

// ─────────────────────────────────────────────────────────────────────
// waitForSnapshotJob — replaces waitForFreshSnapshot in migration.ts.
//
// PRE-FIX BUG (2026-05-29): migration's "snapshotting" step polled
// `CronJob.status.lastSuccessfulTime` which is only populated by Jobs
// the CronJob CONTROLLER spawned. Manually-created Jobs (which
// triggerMailSnapshot creates) do NOT update lastSuccessfulTime even
// when they succeed.
//
// Result: the migration's snapshotting step blocked until the next
// every-two-min CronJob fire happened to update lastSuccessfulTime
// (up to ~2 min of dead wait time on top of the manual Job's actual
// 4-10 s completion). Operators saw "Taking pre-migration mail
// backup" sit on the same label for an unreasonable duration even
// when the underlying restic backup was already done.
//
// Fix: poll the specific Job we just spawned by jobName.
// ─────────────────────────────────────────────────────────────────────

export interface WaitForSnapshotJobOptions {
  readonly jobName: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  /** Indirection for tests — production caller passes the real k8s client. */
  readonly readJob: (jobName: string) => Promise<JobShape>;
  /** Optional cancel hook — if it returns true, throws an "operator cancelled" error. */
  readonly isCancelRequested?: () => Promise<boolean>;
}

export async function waitForSnapshotJob(opts: WaitForSnapshotJobOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    // Use a try/catch around isCancelRequested so a transient DB error
    // doesn't propagate to the caller as a non-cancel error (which the
    // outer migration would log as "snapshot failed" and silently
    // proceed past the cancel). Treat any error from the cancel hook
    // as "not cancelled this tick" — the real cancel will resurface
    // on the next poll once the DB recovers.
    let isCancelled = false;
    if (opts.isCancelRequested) {
      try {
        isCancelled = await opts.isCancelRequested();
      } catch {
        isCancelled = false;
      }
    }
    if (isCancelled) {
      throw new SnapshotCancelledError(opts.jobName);
    }
    let job: JobShape | null = null;
    try {
      job = await opts.readJob(opts.jobName);
    } catch {
      // ENOENT / transient — keep polling until the deadline.
    }
    const succeeded = (job?.status?.succeeded ?? 0) >= 1;
    if (succeeded) return;
    const failed = (job?.status?.failed ?? 0) >= 1;
    if (failed) {
      const condMsg =
        (job?.status?.conditions ?? []).find((c) => c.type === 'Failed')?.message ?? null;
      throw new Error(
        `snapshot Job ${opts.jobName} failed${condMsg ? `: ${condMsg}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
  throw new Error(
    `snapshot Job ${opts.jobName} timed out after ${opts.timeoutMs}ms (deadline exceeded)`,
  );
}
