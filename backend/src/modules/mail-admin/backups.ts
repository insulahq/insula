/**
 * Mail offsite backup (restic snapshot) listing + restore.
 *
 * The stalwart-snapshot CronJob writes restic backups every 2 min to
 * the operator-chosen mail BackupTarget. This module exposes them for
 * operator inspection + selective restore — the use case is point-in-
 * time recovery beyond what the live rsync standby provides (standby
 * is always live data; restic carries 30+ days of history when retention
 * is configured).
 *
 * Listing strategy: spawn a one-shot Pod that mounts the same
 * stalwart-snapshot-restic-repo Secret as the CronJob and runs
 * `restic snapshots --json`. Pod returns the JSON via stdout; we
 * collect, parse, return. Pod TTL is 60s so cluster cleanup is automatic.
 *
 * Restore strategy: piggyback on the mail-migration state machine.
 * Operator picks snapshot + target node → we start a normal migration
 * with skipFreshSnapshot=true (we don't need ANOTHER backup of the data
 * we're about to overwrite) AND restoreSnapshotId set on the run so the
 * restore-state init container restores the chosen ID instead of latest.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import {
  backupTargetAssignments,
  backupConfigurations,
} from '../../db/schema.js';
import type { CoreV1Api, BatchV1Api } from '@kubernetes/client-node';
import { isNotFound } from '../../shared/k8s-errors.js';
import type {
  MailBackupListResponse,
  MailBackupSnapshot,
  MailBackupRestoreResponse,
} from '@insula/api-contracts';

const MAIL_NAMESPACE = 'mail';
const LIST_JOB_PREFIX = 'mail-backup-list-';
const LIST_JOB_TTL_SECONDS = 60;
// CIFS-backed restic repos can take 60-330s to LIST when the upstream
// is under load (caught 2026-05-27 on staging — a single list went
// from 20s to 5+ min with `unexpected EOF` retries between runs).
// 180s covers the typical slow case; a truly broken target fails much
// faster (DNS resolution / TCP reject inside <5s).
const LIST_TIMEOUT_MS = 180_000;

// ─────────────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────────────

export async function listMailBackups(deps: {
  db: Database;
  core: CoreV1Api;
  batch: BatchV1Api;
  kubeconfigPath?: string;
}): Promise<MailBackupListResponse> {
  // Resolve the configured mail BackupTarget (informational + early-out).
  const targetRows = await deps.db
    .select({
      id: backupTargetAssignments.targetId,
      name: backupConfigurations.name,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(eq(backupTargetAssignments.backupClass, 'mail'))
    .limit(1);
  const targetName = targetRows[0]?.name ?? null;

  if (!targetName) {
    return {
      snapshots: [],
      repoReachable: false,
      reason:
        'No mail BackupTarget configured. Set one at /backups/mail → Targets, ' +
        'then snapshots will start showing up here within ~2 min.',
      targetName: null,
    };
  }

  // Spawn a one-shot Pod that runs `restic snapshots --json` from the
  // same image + envFrom Secret as the stalwart-snapshot CronJob. We
  // can't read the Secret values directly from platform-api (encrypted
  // at rest) but the Pod mounts the Secret via envFrom and runs the
  // restic CLI which transparently reads RESTIC_REPOSITORY +
  // RESTIC_PASSWORD env vars.
  const jobName = `${LIST_JOB_PREFIX}${randomUUID().slice(0, 8)}`;
  try {
    await deps.batch.createNamespacedJob({
      namespace: MAIL_NAMESPACE,
      body: buildListJob(jobName) as unknown as object,
    });
  } catch (err) {
    return {
      snapshots: [],
      repoReachable: false,
      reason: `Failed to spawn list Pod: ${err instanceof Error ? err.message : String(err)}`,
      targetName,
    };
  }

  // Poll for completion + read pod logs.
  try {
    const out = await waitForJobLogs(deps, jobName, LIST_TIMEOUT_MS);
    const snapshots = parseResticSnapshotsJson(out);
    return {
      snapshots,
      repoReachable: true,
      reason: null,
      targetName,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.includes('did not complete within');
    const reason = timedOut
      ? `Restic list timed out after ${LIST_TIMEOUT_MS / 1000}s — usually means the off-site target ` +
        `is reachable but slow (CIFS/SMB backends in particular can stall under load). The snapshot ` +
        `CronJob may still be writing successfully. Retry in a minute; if it persists, check the ` +
        `upstream filesystem health or rotate via /backups/mail → Restic password if you suspect drift.`
      : `Restic list failed: ${msg}. Verify the mail BackupTarget is reachable + the ` +
        `stalwart-snapshot-restic-repo Secret is current (rotate via /backups/mail → Restic password ` +
        `if you suspect drift).`;
    return {
      snapshots: [],
      repoReachable: false,
      reason,
      targetName,
    };
  } finally {
    // Best-effort cleanup — the Job's ttlSecondsAfterFinished handles
    // the long-tail case if our explicit delete fails.
    try {
      await deps.batch.deleteNamespacedJob({
        namespace: MAIL_NAMESPACE,
        name: jobName,
        propagationPolicy: 'Background',
      });
    } catch {
      // best-effort
    }
  }
}

function buildListJob(name: string): Record<string, unknown> {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'mail-backup-list',
        'app.kubernetes.io/part-of': 'hosting-platform',
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: LIST_JOB_TTL_SECONDS,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/component': 'mail-backup-list',
          },
        },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: false },
          containers: [
            {
              name: 'list',
              image: 'ghcr.io/insulahq/hosting-platform/mail-backup-tools:latest',
              imagePullPolicy: 'IfNotPresent',
              // restic snapshots --json prints a JSON array to stdout, one
              // entry per snapshot. --no-cache to avoid touching /root in
              // a pod that's about to be deleted.
              // --no-lock: read-only LIST does not need the repo lock.
              // Without it, a killed/OOMed listing Pod leaves a stale lock
              // on the repo that blocks the snapshot CronJob's
              // `restic forget` step until manually unlocked. Caught
              // 2026-05-27 on staging — list Pod from prior list call
              // left a 3-hour stale lock that broke every snapshot run.
              command: ['sh', '-c', 'restic snapshots --json --no-cache --no-lock 2>/dev/null'],
              envFrom: [
                {
                  secretRef: {
                    name: 'stalwart-snapshot-restic-repo',
                    optional: false,
                  },
                },
              ],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            },
          ],
        },
      },
    },
  };
}

interface PodShape {
  readonly metadata?: { name?: string };
  readonly status?: {
    phase?: string;
    containerStatuses?: ReadonlyArray<{
      state?: { waiting?: { reason?: string; message?: string } };
    }>;
  };
}

async function waitForJobLogs(
  deps: { core: CoreV1Api; batch: BatchV1Api },
  jobName: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let podName: string | null = null;
  while (Date.now() < deadline) {
    try {
      const pods = await deps.core.listNamespacedPod({
        namespace: MAIL_NAMESPACE,
        labelSelector: `job-name=${jobName}`,
      }) as { items: ReadonlyArray<PodShape> };
      const pod = pods.items[0];
      if (pod?.metadata?.name && pod.status?.phase === 'Succeeded') {
        podName = pod.metadata.name;
        break;
      }
      if (pod?.status?.phase === 'Failed') {
        const name = pod.metadata?.name;
        let logs = '';
        if (name) {
          try {
            const r = await deps.core.readNamespacedPodLog({
              namespace: MAIL_NAMESPACE,
              name,
              tailLines: 20,
            });
            logs = typeof r === 'string' ? r : String(r);
          } catch {
            // ignore
          }
        }
        throw new Error(`list Pod failed: ${logs.trim().slice(0, 300) || 'no logs'}`);
      }
      // Pending — check container statuses for a waiting reason
      // (ImagePullBackOff / ErrImagePull / CreateContainerConfigError).
      // Pre-fix these stuck-Pending states only surfaced as a generic
      // timeout error after the full deadline elapsed.
      if (pod?.status?.phase === 'Pending') {
        const blocker = pod.status?.containerStatuses?.[0]?.state?.waiting;
        if (blocker && blocker.reason && BLOCKING_WAITING_REASONS.has(blocker.reason)) {
          throw new Error(
            `list Pod stuck in '${blocker.reason}'${blocker.message ? `: ${blocker.message.slice(0, 200)}` : ''}`,
          );
        }
      }
    } catch (err) {
      if ((err as Error).message?.startsWith('list Pod failed:')) throw err;
      if ((err as Error).message?.startsWith('list Pod stuck')) throw err;
      if (!isNotFound(err)) throw err;
      // Pod not yet created — keep polling.
    }
    await sleep(500);
  }
  if (!podName) {
    throw new Error(`list Pod did not complete within ${timeoutMs}ms`);
  }
  const log = await deps.core.readNamespacedPodLog({
    namespace: MAIL_NAMESPACE,
    name: podName,
  });
  return typeof log === 'string' ? log : String(log);
}

/** Container-waiting reasons that mean 'this Pod will never start' — bail fast. */
const BLOCKING_WAITING_REASONS = new Set<string>([
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'CrashLoopBackOff',
  'InvalidImageName',
]);

function parseResticSnapshotsJson(raw: string): MailBackupSnapshot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => {
      const tags = Array.isArray(s.tags)
        ? (s.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      // restic snapshot 'summary' field carries the byte counts when
      // present; older restic versions omit it.
      const summary = (s.summary ?? {}) as Record<string, unknown>;
      const sizeBytes = typeof summary.total_bytes_processed === 'number'
        ? summary.total_bytes_processed
        : null;
      const id = typeof s.short_id === 'string' ? s.short_id : '';
      const shortId = typeof s.id === 'string' ? s.id : '';
      const time = typeof s.time === 'string' ? s.time : '';
      const hostname = typeof s.hostname === 'string' ? s.hostname : '';
      return { id, shortId, time, hostname, tags, sizeBytes };
    })
    .filter((s) => s.id && s.shortId && s.time);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────

/**
 * Trigger a restore of a specific restic snapshot to the chosen target
 * node. Reuses the mail-migration state machine — operator polls
 * /admin/mail/migrate/:runId for progress in the same modal the
 * placement-page Move action uses.
 *
 * NOTE 2026-05-27: this is the BACKEND surface only. The state-machine
 * integration that ACTUALLY reads restoreSnapshotId in the restore-state
 * init container is not yet wired (init container always restores
 * `latest`). For the first iteration, this endpoint triggers a migration
 * with skipFreshSnapshot=true (no point taking a backup of soon-to-be-
 * overwritten data) — operator gets the latest snapshot restored, not
 * the specific one they picked. Surfaced clearly in the UI: 'Restore
 * latest snapshot to <node>' (no per-snapshot selection in this
 * iteration; coming next).
 */
export async function startMailBackupRestore(opts: {
  db: Database;
  core: CoreV1Api;
  batch: BatchV1Api;
  apps: import('@kubernetes/client-node').AppsV1Api;
  kubeconfigPath?: string;
  shortId: string;
  targetNode: string;
  userId: string | null;
}): Promise<MailBackupRestoreResponse> {
  const { startMailMigration } = await import('./migration.js');

  // Per-snapshot restore: migration state machine with skipFreshSnapshot=true
  // (pointless to back up data we're about to overwrite) plus
  // restoreSnapshotId stamped on the pod template. The restore-state init
  // container reads the annotation via downwardAPI and runs
  // `restic restore <shortId>` instead of `restic restore latest`.
  // Annotations are cleared at step 7 on success so future failovers
  // default to `latest` again.
  const result = await startMailMigration(
    { kind: 'explicit', targetNode: opts.targetNode },
    {
      db: opts.db,
      core: opts.core,
      apps: opts.apps,
      batch: opts.batch,
      kubeconfigPath: opts.kubeconfigPath,
      userId: opts.userId,
    },
    { skipFreshSnapshot: true, restoreSnapshotId: opts.shortId },
  );

  if (!result?.runId) {
    throw new ApiError(
      'MAIL_BACKUP_RESTORE_START_FAILED',
      'Migration state machine did not return a run id',
      500,
    );
  }
  return { runId: result.runId, taskId: result.taskId ?? null };
}
