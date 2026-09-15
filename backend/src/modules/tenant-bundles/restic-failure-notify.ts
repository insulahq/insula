/**
 * Turn an in-process restic failure into an operator notification.
 *
 * Tenant and bundle backups run INSIDE platform-api, not as Kubernetes Jobs.
 * The backup-health Job watcher structurally cannot see them: a `bk-files`
 * capture that dies takes its failure with it, and every operator surface stays
 * green. These are the call sites that close that gap.
 *
 * ## `lockCleared` is a different message, not a quieter one
 *
 * The driver self-heals: forget / prune / init clear a stale lock and retry
 * once, and backup clears the lock and fails (its stdin is a one-shot Readable,
 * so retrying would push a truncated payload and record it as a success —
 * strictly worse than failing). Either way the repository ends up unwedged.
 *
 * So `lockCleared: true` means: this operation failed, AND the thing that would
 * have blocked the next one is gone. Saying "your backup is broken" there sends
 * an operator to fix something that has already fixed itself. It is still
 * reported — the run really did fail — but it leads with the recovery.
 */
import { ResticCommandError } from './restic-driver.js';
import { notifyAdminBackupFailed } from '../notifications/events.js';
import type { Database } from '../../db/index.js';

/** Enough stderr to diagnose, not enough to fill an inbox. */
const MAX_STDERR = 400;

export interface ResticFailureContext {
  /** What was being attempted: 'backup', 'forget', 'prune', 'repo init'. */
  readonly operation: string;
  /** Which repo/scope this was for, e.g. "tenant acme / files". */
  readonly scope: string;
  /** Stable key for dedupe — usually the tenant/bundle/component id. */
  readonly dedupeScope: string;
}

/**
 * Build the operator-facing wording. Pure and exported so the two branches can
 * be asserted without a database — the distinction between "broken" and
 * "recovered itself" is the whole point of this module.
 */
export function describeResticFailure(
  ctx: ResticFailureContext,
  err: ResticCommandError,
): { backupName: string; errorMessage: string } {
  const stderr = err.stderr.trim().slice(0, MAX_STDERR);
  const base = `restic ${ctx.operation} exited ${err.exitCode}.`;
  const errorMessage = err.lockCleared
    ? `A stale lock was found and cleared, so the repository is no longer wedged and the `
      + `next scheduled run should succeed without intervention. The run itself still `
      + `failed: ${base} ${stderr}`
    : `${base} ${stderr}`;
  return { backupName: ctx.scope, errorMessage };
}

/**
 * Report a restic failure, or do nothing if it is not one.
 *
 * NEVER throws and never rethrows: these calls sit in the error path of a
 * backup that has already failed, and a notification problem must not replace
 * the original error with its own.
 */
export async function notifyResticFailure(
  db: Database,
  ctx: ResticFailureContext,
  err: unknown,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  if (!(err instanceof ResticCommandError)) return;
  try {
    const { backupName, errorMessage } = describeResticFailure(ctx, err);
    // Keyed on the scope AND the exit code: a repo failing the same way every
    // sweep should not re-notify, but a NEW failure mode on the same repo is
    // genuinely new information.
    await notifyAdminBackupFailed(
      db,
      { backupName, errorMessage },
      `restic-${ctx.operation}:${ctx.dedupeScope}:${err.exitCode}`,
    );
  } catch (notifyErr) {
    log?.warn({ err: notifyErr, scope: ctx.scope }, 'restic failure notification failed');
  }
}
