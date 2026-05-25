/**
 * DR safety: flip a backup target from read_only=true to read_only=false.
 *
 * The DR restore path inserts every backup_configurations row from the
 * bundle with read_only=true so the freshly restored cluster cannot
 * overwrite or prune the repo contents. The operator's single gesture
 * to "un-freeze" a target is this route — it carries the type-name
 * confirmation + the integrity acknowledgement, writes one audit_log
 * row, AND re-attaches CNPG WAL archiving for any cluster whose
 * system_wal_archive_state row points at this target. It also re-
 * triggers the mail-restic reconciler so any sidecar-driven retention
 * (which can't see the read_only flag directly) picks up the new
 * state on its next tick.
 *
 * Reserved for super_admin via the route layer — handler in routes.ts
 * enforces both auth + the type-name confirmation contract.
 */

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  backupConfigurations,
  backupTargetAssignments,
  systemWalArchiveState,
  auditLogs,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resumeCnpgArchiving } from '../system-backup/wal-suspend.js';

export interface MarkWritableInput {
  readonly db: Database;
  readonly k8s: K8sClients | undefined;
  readonly targetId: string;
  /** The operator-typed target name. This function — NOT the route
   *  layer — does the strict-equal verification against target.name,
   *  AND uses it in the UPDATE WHERE predicate so a concurrent rename
   *  between SELECT and UPDATE cannot let an attacker confirm one name
   *  while flipping a row that has since been renamed to something
   *  different. */
  readonly confirmation: string;
  readonly operatorUserId: string;
  readonly operatorIp: string | null;
  /** JWT `jti` (token id) — forensic attribution for the compromised-
   *  admin threat model. Two captured-token replays from the same IP
   *  are distinguishable by jti. Optional only so unit tests don't
   *  need to fake one. */
  readonly operatorJti?: string | null;
  /** User-Agent header — distinguishes browser sessions sharing an IP. */
  readonly operatorUserAgent?: string | null;
}

export interface MarkWritableResult {
  readonly targetId: string;
  readonly targetName: string;
  /**
   * One row per CNPG cluster whose WAL archive routed through this
   * target. The operator's UI surfaces these so they know archiving
   * has resumed alongside the flag flip.
   */
  readonly cnpgArchivingResumed: ReadonlyArray<{
    readonly namespace: string;
    readonly clusterName: string;
    readonly wasAlreadyAttached: boolean;
  }>;
  /** Set when the target is bound to the `mail` class; signals the
   *  reconciler tick will rematerialize the mail-restic Secret. */
  readonly mailReconcilerTriggered: boolean;
}

/**
 * Flip read_only=false in a single transaction with audit log; then
 * (outside the transaction, since k8s patches aren't transactional)
 * resume CNPG archiving for every cluster that was routing WAL through
 * this target. Returns the per-cluster resume outcomes so the caller
 * can surface them in the UI.
 */
export async function markBackupTargetWritable(
  input: MarkWritableInput,
): Promise<MarkWritableResult> {
  const { db, k8s, targetId, confirmation, operatorUserId, operatorIp,
    operatorJti, operatorUserAgent } = input;

  // Lookup target + verify the operator typed the right name. The
  // confirmation check IS the safety gate — every other field on the
  // request is informational.
  const [target] = await db
    .select()
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetId))
    .limit(1);
  if (!target) {
    throw new ApiError(
      'BACKUP_CONFIG_NOT_FOUND',
      `Backup target '${targetId}' not found`,
      404,
    );
  }
  if (confirmation !== target.name) {
    // Strict equal — leak nothing about the expected value. The UI's
    // modal already shows the name to the operator; if they typed it
    // wrong, they retype it.
    throw new ApiError(
      'CONFIRMATION_MISMATCH',
      'Confirmation does not match the target name',
      400,
    );
  }
  // Idempotent: target is already writable. Return without writing an
  // audit_log row (otherwise re-clicking the modal would spam the
  // audit trail with no-op entries that hide real flips). Still walk
  // the CNPG cluster list because manual detach can leave archiving
  // off even when the flag is false.
  if (!target.readOnly) {
    return {
      targetId,
      targetName: target.name,
      cnpgArchivingResumed: [],
      mailReconcilerTriggered: false,
    };
  }

  // Find every CNPG cluster whose WAL archive points at this target.
  // The system_wal_archive_state table is the canonical map; rows are
  // upserted by enableWalArchive / enableWalStreaming / enableScheduledBackups.
  const archivingClusters = await db
    .select({
      clusterNamespace: systemWalArchiveState.clusterNamespace,
      clusterName: systemWalArchiveState.clusterName,
    })
    .from(systemWalArchiveState)
    .where(eq(systemWalArchiveState.targetConfigId, targetId));

  // Flip the flag + write audit log in one transaction. The UPDATE
  // carries a WHERE predicate on BOTH id AND name=<confirmation>
  // so a concurrent PATCH that renames the row between our SELECT
  // and this UPDATE cannot let an attacker confirm one name while
  // flipping a row that is now called something different. We require
  // exactly one affected row; zero rows means a rename raced us.
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(backupConfigurations)
      .set({ readOnly: false, updatedAt: new Date() })
      .where(and(
        eq(backupConfigurations.id, targetId),
        eq(backupConfigurations.name, confirmation),
      ))
      .returning({ id: backupConfigurations.id });
    if (updated.length === 0) {
      // Either the row was deleted, or it was renamed between SELECT
      // and UPDATE. Treat as confirmation mismatch — leaks nothing
      // about the current name.
      throw new ApiError(
        'CONFIRMATION_MISMATCH',
        'Confirmation does not match the target name',
        400,
      );
    }
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'backup_target_mark_writable',
      resourceType: 'backup_configuration',
      resourceId: targetId,
      actorId: operatorUserId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: `/api/v1/admin/backup-configs/${targetId}/mark-writable`,
      httpStatus: 200,
      changes: {
        targetName: target.name,
        previousReadOnly: target.readOnly,
        clustersResuming: archivingClusters.map((c) => `${c.clusterNamespace}/${c.clusterName}`),
        operatorJti: operatorJti ?? null,
        operatorUserAgent: operatorUserAgent ?? null,
      },
      ipAddress: operatorIp,
    });
  });

  // CNPG resume happens AFTER the transaction commits — patching the
  // Cluster CR is not transactional, and if it fails we don't want to
  // roll back the read_only flag (the operator can retry the resume
  // independently from a UI button; archiving stalls are surfaced via
  // the existing wal-archive health checks).
  const cnpgArchivingResumed: Array<{ namespace: string; clusterName: string; wasAlreadyAttached: boolean }> = [];
  if (k8s && archivingClusters.length > 0) {
    for (const cluster of archivingClusters) {
      try {
        const flipped = await resumeCnpgArchiving(
          k8s,
          cluster.clusterNamespace,
          cluster.clusterName,
        );
        cnpgArchivingResumed.push({
          namespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
          wasAlreadyAttached: !flipped,
        });
      } catch {
        // Cluster CR may have been deleted out from under the row.
        // Don't fail the whole operation — operator can resume from
        // the WAL Archive admin page individually.
        cnpgArchivingResumed.push({
          namespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
          wasAlreadyAttached: false,
        });
      }
    }
  }

  // The mail-restic reconciler runs on a 5-minute cadence and re-
  // evaluates the mail class binding every tick. No explicit nudge
  // needed — surfaced in the response so the UI can tell the operator
  // "mail backups will resume on the next reconciler tick" when this
  // target carries the `mail` binding. Small fan-out (≤3 rows per
  // target by CHECK constraint).
  const bindings = await db
    .select({ backupClass: backupTargetAssignments.backupClass })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.targetId, targetId));
  const mailReconcilerTriggered = bindings.some((b) => b.backupClass === 'mail');

  return {
    targetId,
    targetName: target.name,
    cnpgArchivingResumed,
    mailReconcilerTriggered,
  };
}
