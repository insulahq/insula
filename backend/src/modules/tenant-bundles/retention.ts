/**
 * Tenant Backup retention sweeper.
 *
 * Two responsibilities:
 *   1. Delete bundles whose `expires_at` is in the past — call
 *      BackupStore.delete() on the off-site target, then flip the
 *      DB row's `status` to 'expired'.
 *   2. GC stuck `running` bundles older than 24h — set their
 *      status to 'failed' with a clear lastError so the operator
 *      can re-trigger.
 *
 * Idempotent: a half-completed sweep is safe to re-run. The store-
 * delete is idempotent at the BackupStore level (a missing remote
 * bundle returns success), so a crash between "delete on remote"
 * and "set status='expired'" is recovered on the next tick.
 *
 * Per-bundle errors are logged but do NOT stop the sweep — one
 * unreachable target shouldn't block expiry of bundles on a
 * working target.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and, lt, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { backupJobs, backupConfigurations, backupSchedules } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import { resolveShimFirstBackupStore } from './shim-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { finishByRef as finishTaskByRef } from '../tasks/service.js';
import { toSafeText } from '@insula/api-contracts';
import { reapStaleInFlight } from './cluster-concurrency.js';

// Lowered from the legacy 24h to 1h: the restic capture path's
// 95-percentile is ~5 min at the current 5.4 GiB tenant size, and
// Phase 1's `runResticBackup` has a 1h internal timeout (DEFAULT_BACKUP_TIMEOUT_MS).
// Anything still 'running' past 1h is a stuck row left behind by a
// platform-api OOMKill or pod eviction — the orchestrator process is
// gone, no progress is happening, and the chip would otherwise spin
// forever. Operator can re-trigger from the bundle list.
const STUCK_RUNNING_HOURS = Number.parseFloat(
  process.env.TENANT_BUNDLES_STUCK_RUNNING_HOURS ?? '1',
);

export interface RetentionSweepResult {
  /** Bundles brought forward by keep-last-N before the expiry pass ran. */
  readonly overCountMarked: number;
  readonly inFlightReaped: number;
  readonly expiredDeleted: number;
  readonly expiredFailed: number;
  readonly stuckMarkedFailed: number;
}

/**
 * Run one sweep tick. Returns counts so the scheduler can log
 * "swept N expired, M stuck → marked failed".
 */
export async function runRetentionSweep(app: FastifyInstance): Promise<RetentionSweepResult> {
  let expiredDeleted = 0;
  let expiredFailed = 0;
  let stuckMarkedFailed = 0;

  // ── 0. Keep-last-N ────────────────────────────────────────────────
  //
  // `backup_schedules.tenant_bundle.retention_count` — the operator's
  // "Retention (keep last N)" — was written by the UI, stored in the DB and
  // read by NOTHING on this path. The scheduler passes only `retentionDays`,
  // so every bundle got `expires_at = created + days` and a tenant backed up
  // nightly accumulated `days` bundles, not `N`. Observed on production: N set
  // to 14, tenants holding 26 and climbing toward 30. The mail subsystem had
  // the identical defect and was fixed with a reconciler; this is the tenant
  // -bundle half.
  //
  // Enforced by bringing a bundle's `expires_at` FORWARD to now rather than by
  // deleting here, so the whole tested path below — frozen-target skip, remote
  // delete, status flip, and the restic reclamation that follows the DB — runs
  // unchanged. Days and count therefore compose as "whichever removes it
  // first": days still expires a bundle on its own schedule, and this cannot
  // push one out any later than days already would.
  const now = new Date();
  let overCountMarked = 0;
  const [schedule] = await app.db
    .select({ retentionCount: backupSchedules.retentionCount })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, 'tenant_bundle'))
    .limit(1);
  const keepLast = schedule?.retentionCount ?? null;
  if (keepLast !== null && keepLast > 0) {
    // Ranked over `completed`/`partial` only. A failed bundle holds no
    // restorable data, so counting it toward N would silently reduce the
    // tenant's real coverage — 14 kept, three of them empty. `running` rows
    // are excluded for the same reason and because they are still being
    // written.
    //
    // (created_at DESC, id DESC) matches the list's ordering, so "the newest
    // 14" means the same thing here as on screen even when two bundles share a
    // timestamp.
    const marked = await app.db.execute(sql`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY tenant_id ORDER BY created_at DESC, id DESC
               ) AS rn
          FROM backup_jobs
         WHERE status IN ('completed','partial')
      )
      UPDATE backup_jobs b
         SET expires_at = ${now}
        FROM ranked r
       WHERE b.id = r.id
         AND r.rn > ${keepLast}
         AND (b.expires_at IS NULL OR b.expires_at > ${now})
         -- Never pull a bundle out from under a restore that is still open.
         -- The cart holds the bundle id; deleting it mid-flight would fail the
         -- restore with a missing-artifact error the operator cannot act on.
         AND NOT EXISTS (
           SELECT 1
             FROM restore_items ri
             JOIN restore_jobs rj ON rj.id = ri.restore_job_id
            WHERE ri.bundle_id = b.id
              AND rj.status NOT IN ('done','failed')
         )
      RETURNING b.id
    `);
    overCountMarked = ((marked as unknown as { rows?: unknown[] }).rows ?? []).length;
    if (overCountMarked > 0) {
      app.log.info(
        { keepLast, marked: overCountMarked },
        'tenant-backup retention: bundles beyond keep-last-N brought forward for expiry',
      );
    }
  }

  // ── 1. Expired bundles ────────────────────────────────────────────
  // Lock candidate IDs first, then process outside any single
  // transaction so a slow remote delete doesn't hold a lock.
  // Cap at 50 per tick — a backlog catches up over multiple ticks
  // without overwhelming the target. Shares `now` with pass 0 so a bundle
  // marked there is picked up in this same tick.
  const expiredCandidates = await app.db
    .select({ id: backupJobs.id, targetConfigId: backupJobs.targetConfigId })
    .from(backupJobs)
    .where(
      and(
        lt(backupJobs.expiresAt, now),
        sql`${backupJobs.status} IN ('completed','partial','failed')`,
      ),
    )
    .limit(50);

  // DR safety: pre-fetch the set of frozen targets ONCE rather than
  // calling requireWritableTarget inside the per-bundle loop. A 50-row
  // batch hitting 5 targets used to issue 50 SELECTs; now it issues 1.
  const distinctTargetIds = Array.from(new Set(
    expiredCandidates.map((c) => c.targetConfigId).filter((t): t is string => Boolean(t)),
  ));
  const frozenTargets = new Map<string, string>(); // id -> name
  if (distinctTargetIds.length > 0) {
    const rows = await app.db
      .select({ id: backupConfigurations.id, name: backupConfigurations.name })
      .from(backupConfigurations)
      .where(and(
        eq(backupConfigurations.readOnly, true),
        inArray(backupConfigurations.id, distinctTargetIds),
      ));
    for (const r of rows) frozenTargets.set(r.id, r.name);
  }

  for (const { id, targetConfigId } of expiredCandidates) {
    if (!targetConfigId) {
      // Pre-D-redesign row with no target_config_id; can't reach
      // the remote bundle. Mark expired in DB anyway so the row
      // doesn't stay decorative forever.
      await app.db.update(backupJobs).set({ status: 'expired' }).where(eq(backupJobs.id, id));
      expiredDeleted++;
      continue;
    }
    // DR safety: skip frozen targets — the bundle row stays in its
    // current status so the next sweep re-evaluates after operator
    // unfreezes. Logged once at info so the skip is visible.
    const frozenName = frozenTargets.get(targetConfigId);
    if (frozenName !== undefined) {
      app.log.info({ bundleId: id, targetConfigId, targetName: frozenName }, 'tenant-backup retention: skipping delete on frozen target');
      expiredFailed++;
      continue;
    }
    try {
      const store = await resolveStoreForTarget(app, targetConfigId);
      const handle = await store.open(id);
      if (handle) {
        await store.delete(handle);
      }
      // (handle === null) → already gone on remote; still mark expired.
      await app.db.update(backupJobs).set({ status: 'expired' }).where(eq(backupJobs.id, id));
      expiredDeleted++;
    } catch (err) {
      app.log.error({ err, bundleId: id, targetConfigId }, 'tenant-backup retention: failed to delete expired bundle on remote — leaving status untouched for next-tick retry');
      expiredFailed++;
    }
  }

  // ── 2. Stuck `running` bundles older than STUCK_RUNNING_HOURS ─────
  // The orchestrator never crashes mid-bundle in normal operation
  // (it wraps each phase in try/catch and writes 'failed' on error).
  // But pod kills (OOM, eviction) leave 'running' rows behind forever
  // because the orchestrator process is gone. Mark them failed here so
  // the operator can re-trigger from the bundle list. Also clear the
  // user's task chip row (clearImmediately) and surface the failure on
  // the bell, matching the happy-path failure UX in `orchestrator.runBundle`.
  const cutoff = new Date(Date.now() - STUCK_RUNNING_HOURS * 60 * 60 * 1000);
  const stuckErr =
    `stuck in 'running' for >${STUCK_RUNNING_HOURS}h — orchestrator pod likely killed mid-bundle ` +
    `(check platform-api restarts + memory usage). Re-trigger from the bundle list.`;
  const stuckRes = await app.db.execute(sql`
    UPDATE backup_jobs
    SET status = 'failed',
        last_error = ${stuckErr},
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
    WHERE status = 'running'
      AND started_at < ${cutoff}
    RETURNING id, tenant_id
  `) as unknown as { rows: Array<{ id: string; tenant_id: string }> };
  stuckMarkedFailed = stuckRes.rows.length;
  if (stuckMarkedFailed > 0) {
    app.log.warn({ count: stuckMarkedFailed, ids: stuckRes.rows.map((r) => r.id) }, 'tenant-backup retention: marked stuck running bundles as failed');
    // Look up the originating user_id from the matching task row(s),
    // then close the chip + ring the bell. One DB hit per stuck bundle
    // — the count is bounded (sweep runs every 5 min, anyone but a
    // disaster scenario won't have more than a handful past the
    // cutoff).
    for (const { id: bundleId, tenant_id: tenantId } of stuckRes.rows) {
      try {
        const taskRow = await app.db.execute(sql`
          SELECT user_id FROM tasks WHERE kind = 'backup.bundle' AND ref_id = ${bundleId} LIMIT 1
        `) as unknown as { rows: Array<{ user_id: string | null }> };
        const userId = taskRow.rows[0]?.user_id ?? null;
        await finishTaskByRef(app.db, 'backup.bundle', bundleId, {
          status: 'failed',
          text: toSafeText('reaped'),
          error: stuckErr,
          clearImmediately: true,
        });
        // Dispatched to the TENANT, not poked at one user id. The legacy call
        // needed a userId to exist and wrote an in-app row only — no template,
        // no email, no delivery audit — so a tenant whose backup was reaped
        // learned nothing unless they opened the panel.
        const { notifyTenantBackupEvent } = await import('../notifications/events.js');
        await notifyTenantBackupEvent(app.db, tenantId, {
          subsystem: 'Backup bundle',
          objectLabel: bundleId,
          detail: `The bundle was stuck in 'running' past the ${STUCK_RUNNING_HOURS}h cutoff and has been reaped. ${stuckErr}`,
          severityLabel: 'reaped',
          recommendedAction: 'Re-run the backup from the Backups page.',
        }, `bundle-reaped:${bundleId}`);
      } catch (err) {
        app.log.warn({ err, bundleId }, 'tenant-backup retention: stuck-bundle UX cleanup failed');
      }
    }
  }

  // ── 3. Reap stale tenant_bundle_in_flight rows ─────────────────────
  // Rows older than 10 min (2× the cluster-gate stale threshold) are
  // orphans from a crashed pod whose heartbeat stopped. We hard-delete
  // them so the cluster-cap COUNT(*) check stays accurate over the
  // long run. Rows in the 5-10 min window are not counted toward the
  // cap by acquire() but kept around for diagnostics.
  let inFlightReaped = 0;
  try {
    inFlightReaped = await reapStaleInFlight(app.db);
    if (inFlightReaped > 0) {
      app.log.warn({ count: inFlightReaped }, 'tenant-backup retention: reaped stale tenant_bundle_in_flight rows');
    }
  } catch (err) {
    app.log.warn({ err }, 'tenant-backup retention: in-flight reap failed (non-fatal)');
  }

  return { overCountMarked, expiredDeleted, expiredFailed, stuckMarkedFailed, inFlightReaped };
}

/**
 * Schedule a periodic sweep. 5-min tick is plenty — bundles linger
 * on remote for 5 min past expiry which is well within any sensible
 * retention SLO. Returns the timer handle so callers can cancel
 * during graceful shutdown.
 */
export function startRetentionScheduler(app: FastifyInstance, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const r = await runRetentionSweep(app);
      if (r.expiredDeleted > 0 || r.stuckMarkedFailed > 0 || r.expiredFailed > 0 || r.inFlightReaped > 0) {
        app.log.info({ ...r }, 'tenant-backup retention: sweep complete');
      }
    } catch (err) {
      app.log.error({ err }, 'tenant-backup retention: sweep tick failed');
    }
  };
  // First tick fires immediately so a freshly-started platform-api
  // doesn't wait 5 min before sweeping.
  void tick();
  return setInterval(tick, intervalMs);
}

/**
 * Shim-FIRST, then the direct cfg-based resolver — the same routing
 * `backup-restore/shared.ts` uses, and for the same reason.
 *
 * Tenant bundles are WRITTEN through the backup-rclone-shim regardless of
 * upstream (S3/SFTP/CIFS/NFS). Retention DELETES those same objects, so it has
 * to read through the same path; resolving cfg-direct only ever worked for the
 * two kinds that happen to have a concrete BackupStore class. On staging every
 * sweep since the tenant class moved to CIFS logged
 *
 *   Unsupported storage type 'cifs' on target c59f7ba2-…
 *   "tenant-backup retention: failed to delete expired bundle on remote —
 *    leaving status untouched for next-tick retry"
 *
 * — i.e. expired bundles were never reclaimed and the sweep retried forever.
 * This is the identical failure shim-first was introduced to fix on the restore
 * side ("CIFS + NFS … blow up the restore cart with Store kind '<x>' not
 * supported"); retention was simply never migrated with it.
 */
async function resolveStoreForTarget(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  return resolveShimFirstBackupStore(
    app, 'tenant',
    () => resolveDirectStoreForTarget(app, targetConfigId),
    'tenant-backup-retention',
  );
}

async function resolveDirectStoreForTarget(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new Error(`Backup target ${targetConfigId} not found`);
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_ENCRYPTION_KEY is not configured in production');
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch {
      throw new Error(`S3 credential decryption failed for target ${targetConfigId}`);
    }
    if (!accessKey || !secretKey) throw new Error(`S3 credentials missing on target ${targetConfigId}`);
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }
  if (cfg.storageType === 'ssh') {
    // Key OR password. Hetzner storageboxes authenticate by password, and the
    // DB enforces that at least one is present — demanding the key rejected
    // valid password-only targets with "missing required fields", which is what
    // staging's staging-ssh-storagebox hit on every retention tick. Same
    // condition as backup-restore/shared.ts.
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshPath || (!cfg.sshKeyEncrypted && !cfg.sshPasswordEncrypted)) {
      throw new Error(`SSH target ${targetConfigId} missing required fields (host, user, path, and a key or password)`);
    }
    let privateKey: string | undefined;
    let password: string | undefined;
    try {
      if (cfg.sshKeyEncrypted) privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
      if (cfg.sshPasswordEncrypted) password = decrypt(cfg.sshPasswordEncrypted, encKey);
    } catch {
      throw new Error(`SSH credential decryption failed for target ${targetConfigId}`);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      password,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  throw new Error(`Unsupported storage type '${cfg.storageType}' on target ${targetConfigId}`);
}
