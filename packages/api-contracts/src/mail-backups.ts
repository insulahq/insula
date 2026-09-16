import { z } from 'zod';

/**
 * Mail offsite backup (restic snapshot) restore API.
 *
 * The stalwart-snapshot CronJob writes restic snapshots to the operator-
 * chosen BackupTarget every ~2 min. This API exposes them for inspection
 * and operator-triggered restore.
 *
 * Distinct from the rsync standby data on labelled nodes — that's the
 * live-failover hot path. Restic snapshots are the offsite DR fallback:
 * older retention (30+ days when configured), useful for point-in-time
 * recovery ('roll back the last 3 days of damage') that rsync standby
 * can't provide (standby is always live data).
 */

export const mailBackupSnapshotSchema = z.object({
  /** restic snapshot ID (short — first 8 hex chars). */
  id: z.string(),
  /** Full restic snapshot ID (64-char hex). Use for restore. */
  shortId: z.string(),
  /** ISO timestamp the snapshot was created. */
  time: z.string().datetime(),
  /** Hostname recorded by the restic backup (always 'stalwart-mail'). */
  hostname: z.string(),
  /** Restic tags (e.g. 'stalwart-snapshot', 'auto'). */
  tags: z.array(z.string()),
  /** Bytes of data + metadata in this snapshot (raw, before dedup). */
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export type MailBackupSnapshot = z.infer<typeof mailBackupSnapshotSchema>;

export const mailBackupListResponseSchema = z.object({
  snapshots: z.array(mailBackupSnapshotSchema),
  /**
   * True when the restic repo is reachable; false when the BackupTarget
   * is misconfigured / the shim is down / the operator hasn't set one.
   * UI shows a 'configure target' empty-state in that case.
   */
  repoReachable: z.boolean(),
  /** Operator-facing reason if !repoReachable. */
  reason: z.string().nullable(),
  /**
   * WHY the repo is not reachable, as a value rather than prose.
   *
   * `reason` is written for a human and gets reworded; deciding whether to
   * raise an alert by matching its text would break the first time someone
   * improved the wording. These are the cases, and only the last two are
   * faults:
   *
   *   not_configured — no mail BackupTarget assigned yet. Setup, not an
   *                    outage; alerting on it would fire forever on a fresh
   *                    install.
   *   provisioning   — credentials are still being materialised (resolves in
   *                    about a minute). Transient by construction.
   *   unreachable    — the listing ran and could not reach the repo.
   *   timed_out      — the listing pod did not finish in time.
   *
   * null when `repoReachable` is true.
   */
  unreachableCause: z
    .enum(['not_configured', 'provisioning', 'unreachable', 'timed_out'])
    .nullable(),
  /**
   * Currently-configured mail BackupTarget (target name from
   * backup_configurations). null when no target is assigned to the
   * 'mail' class.
   */
  targetName: z.string().nullable(),
  /**
   * Restic locks currently held on the repo.
   *
   * `repoReachable` alone is a LIE during the failure this exists for: the
   * listing pod runs `restic snapshots --no-lock`, so it reads a fully wedged
   * repo happily and reports true while every write — every scheduled snapshot,
   * every `forget` — fails with "unable to create lock". DEV spent 3 days 17
   * hours in exactly that state with this surface showing green.
   *
   * null means the lock listing could not be run (older image, or the repo was
   * unreachable anyway) — NOT that there are zero locks.
   */
  lockCount: z.number().int().nonnegative().nullable(),
});

export type MailBackupListResponse = z.infer<typeof mailBackupListResponseSchema>;

/**
 * Result of clearing stale restic locks on the mail repo.
 *
 * Counted before and after rather than echoing restic's own "successfully
 * removed N locks" line, so a lock that SURVIVES is visible. A surviving lock is
 * held by a process that is still alive, and that is precisely when an operator
 * must stop pulling the lever instead of escalating to a forced removal.
 */
export const mailResticUnlockResponseSchema = z.object({
  locksBefore: z.number().int().nonnegative(),
  locksAfter: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** restic's own output, surfaced verbatim for the operator. */
  output: z.string(),
  /** Operator-facing summary; always populated. */
  message: z.string(),
});

export type MailResticUnlockResponse = z.infer<typeof mailResticUnlockResponseSchema>;

/**
 * POST /admin/mail/backups/:shortId/restore — restore the chosen
 * snapshot to the chosen target node.
 *
 * The restore reuses the mail-migration state machine with an extra
 * argument: instead of restic-restore-latest (failover behaviour), the
 * restore-state init container runs restic-restore-<shortId>. All other
 * steps (preflight, scale-down, PVC swap, scale-up, verify) are
 * identical to a mail-migration.
 *
 * Operator MUST type the snapshot's shortId as confirmation — same
 * pattern as drift-recreate-empty. The route handler enforces this
 * server-side as a backstop to the UI's type-to-confirm.
 */
export const mailBackupRestoreRequestSchema = z.object({
  /** Target node where the restored PVC + Stalwart pod should land. */
  targetNode: z.string().min(1).max(253),
  /** Type-to-confirm — must match the snapshot shortId. */
  confirmShortId: z.string().min(1),
});
export type MailBackupRestoreRequest = z.infer<typeof mailBackupRestoreRequestSchema>;

export const mailBackupRestoreResponseSchema = z.object({
  /** Migration run ID — operator polls /admin/mail/migrate/:runId for progress. */
  runId: z.string().uuid(),
  /** Task-center id for chip-driven UX. */
  taskId: z.string().nullable(),
});
export type MailBackupRestoreResponse = z.infer<typeof mailBackupRestoreResponseSchema>;
