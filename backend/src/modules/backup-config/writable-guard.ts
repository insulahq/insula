/**
 * DR safety guard: refuse platform-driven writes/deletes against a
 * backup target whose `read_only` flag is set.
 *
 * The DR restore path imports every `backup_configurations` row from
 * the bundle and forces `read_only = true` so a freshly restored
 * cluster cannot overwrite or prune the existing repo contents until
 * the operator confirms data integrity via
 * POST /admin/backup-configs/:id/mark-writable.
 *
 * Every backup write/delete callsite MUST call this helper before
 * touching the upstream repo. The CI guard
 * `scripts/ci-backup-target-ro-check.sh` enforces this by grepping each
 * known enforcement site for either a `requireWritableTarget(...)` call
 * or an explicit `// RO-EXEMPT: <reason>` annotation.
 *
 * Throws ApiError with code `TARGET_FROZEN` (HTTP 409) — operator-
 * friendly so the admin UI / task-center chip surfaces the right
 * message.
 */

import { eq } from 'drizzle-orm';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export class TargetFrozenError extends ApiError {
  constructor(targetId: string, targetName: string) {
    // Pass targetId + targetName through ApiError.details so the
    // global error handler surfaces them in the response envelope.
    // Admin UI / task-center chips can pull them out to render a
    // direct link to the frozen target without parsing the message.
    super(
      'TARGET_FROZEN',
      `Backup target '${targetName}' is read-only (frozen for DR safety). Mark it read-write from the admin UI before retrying.`,
      409,
      { targetId, targetName },
    );
    this.name = 'TargetFrozenError';
    this.targetId = targetId;
    this.targetName = targetName;
  }
  readonly targetId: string;
  readonly targetName: string;
}

/**
 * Throws TargetFrozenError when the target row has `read_only=true`.
 * Returns the target's name on success so callers can include it in
 * log lines without a second SELECT.
 *
 * Returns null when the target id is null/empty/sentinel — caller must
 * decide whether that's allowed (most enforcement sites should reject
 * a null target separately).
 */
export async function requireWritableTarget(
  db: Database,
  targetId: string | null | undefined,
): Promise<string | null> {
  if (!targetId) return null;
  const [row] = await db
    .select({
      name: backupConfigurations.name,
      readOnly: backupConfigurations.readOnly,
    })
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetId));
  if (!row) {
    throw new ApiError(
      'BACKUP_CONFIG_NOT_FOUND',
      `Backup configuration '${targetId}' not found`,
      404,
    );
  }
  if (row.readOnly) {
    throw new TargetFrozenError(targetId, row.name);
  }
  return row.name;
}
