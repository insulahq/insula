/**
 * switch-with-pause — Phase 5 (2026-05-24)
 *
 * Pre-switch flow added in response to operator request: when an
 * operator switches the target for a shim class, the schedules
 * bound to that class + (for the system class) WAL streaming on
 * system-db are paused as part of the same operation. This avoids
 * silent "where did my schedule go" surprises where, post-switch,
 * the schedule fires against the OLD target's stale credentials
 * because the operator forgot to re-point it.
 *
 * Two functions:
 *   - `previewSwitchEffects` — what WOULD happen on a switch. The
 *     UI calls this BEFORE asking the operator to confirm, then
 *     renders the list of items that will be paused.
 *   - `switchTargetWithPause` — do the pause + invoke the existing
 *     applyShimAssignmentChange in one server-side step. The pause
 *     happens synchronously before the apply pipeline starts; if
 *     the apply itself fails the operator sees a half-applied state
 *     (schedules paused, target unchanged) which is recoverable.
 *
 * No new database tables. Uses existing backup_schedules.enabled +
 * the existing disableWalArchive helper from system-backup.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  backupSchedules,
  systemWalArchiveState,
  backupConfigurations,
} from '../../db/schema.js';
import type { BackupShimClass } from '@k8s-hosting/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { disableWalArchive } from '../system-backup/wal-archive.js';
import {
  applyShimAssignmentChange,
} from './apply-assignment.js';

// Subsystem ↔ shim-class mapping. Mirror of GATE_MAP in
// backup-schedules/service.ts (reversed). Kept module-local so a
// future split doesn't require coordinated edits — the truth is
// "which subsystems pause when class X is switched."
const SUBSYSTEMS_BY_CLASS: Record<BackupShimClass, ReadonlyArray<string>> = {
  system: ['system_pitr'],
  tenant: ['tenant_bundle'],
  mail: ['mail'],
};

// CNPG cluster reference for WAL pause. Today only the system class
// has an associated WAL stream (platform/system-db). Indexed by
// shim class so a future mail-db reintroduction wouldn't require
// editing the switch flow.
const WAL_CLUSTER_BY_CLASS: Partial<Record<BackupShimClass, {
  readonly namespace: string;
  readonly clusterName: string;
}>> = {
  system: { namespace: 'platform', clusterName: 'system-db' },
};

export interface SwitchPreview {
  /** Schedules that will be set to enabled=false. May be empty. */
  readonly schedulesToPause: ReadonlyArray<{
    readonly subsystem: string;
    readonly enabled: boolean;
    readonly cronExpression: string | null;
  }>;
  /** WAL archive state that will be disabled. Null when class has no
   *  associated CNPG cluster OR WAL is already off. */
  readonly walToDisable: {
    readonly clusterNamespace: string;
    readonly clusterName: string;
    readonly currentTargetName: string | null;
  } | null;
  /** New target name (resolved from id). Null on unbind. */
  readonly newTargetName: string | null;
}

export async function previewSwitchEffects(
  db: Database,
  className: BackupShimClass,
  newTargetId: string | null,
): Promise<SwitchPreview> {
  const subsystems = SUBSYSTEMS_BY_CLASS[className] ?? [];

  // Only surface ENABLED schedules — disabled rows are already paused.
  const schedRows = subsystems.length > 0
    ? await db
      .select({
        subsystem: backupSchedules.subsystem,
        enabled: backupSchedules.enabled,
        cronExpression: backupSchedules.cronExpression,
      })
      .from(backupSchedules)
      .where(and(
        inArray(backupSchedules.subsystem, [...subsystems]),
        eq(backupSchedules.enabled, true),
      ))
    : [];

  let walToDisable: SwitchPreview['walToDisable'] = null;
  const walRef = WAL_CLUSTER_BY_CLASS[className];
  if (walRef) {
    const [walRow] = await db
      .select({
        clusterNamespace: systemWalArchiveState.clusterNamespace,
        clusterName: systemWalArchiveState.clusterName,
        targetConfigId: systemWalArchiveState.targetConfigId,
      })
      .from(systemWalArchiveState)
      .where(and(
        eq(systemWalArchiveState.clusterNamespace, walRef.namespace),
        eq(systemWalArchiveState.clusterName, walRef.clusterName),
      ))
      .limit(1);
    if (walRow) {
      const [tgt] = walRow.targetConfigId
        ? await db
          .select({ name: backupConfigurations.name })
          .from(backupConfigurations)
          .where(eq(backupConfigurations.id, walRow.targetConfigId))
          .limit(1)
        : [];
      walToDisable = {
        clusterNamespace: walRow.clusterNamespace,
        clusterName: walRow.clusterName,
        currentTargetName: tgt?.name ?? null,
      };
    }
  }

  let newTargetName: string | null = null;
  if (newTargetId !== null) {
    const [tgt] = await db
      .select({ name: backupConfigurations.name, enabled: backupConfigurations.enabled })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, newTargetId))
      .limit(1);
    if (!tgt) {
      throw new ApiError('TARGET_NOT_FOUND', `backup_configurations row '${newTargetId}' not found`, 400);
    }
    if (tgt.enabled !== 1) {
      throw new ApiError('TARGET_DISABLED', `target '${tgt.name}' is disabled — enable it before binding`, 400);
    }
    newTargetName = tgt.name;
  }

  return {
    schedulesToPause: schedRows.map((r) => ({
      subsystem: r.subsystem,
      enabled: r.enabled,
      cronExpression: r.cronExpression,
    })),
    walToDisable,
    newTargetName,
  };
}

export interface SwitchWithPauseInput {
  readonly className: BackupShimClass;
  readonly newTargetId: string | null;
  readonly userId: string;
  readonly userIp: string | null;
}

export interface SwitchWithPauseResult {
  readonly assignment: Awaited<ReturnType<typeof applyShimAssignmentChange>>['assignment'];
  readonly taskId: string;
  readonly paused: {
    readonly schedulesPaused: ReadonlyArray<string>;
    readonly walDisabled: boolean;
  };
}

/**
 * `k8s` here is the FULL K8sClients (custom + core + apps + …) because
 * we need `custom` for the WAL disable path. `applyShimAssignmentChange`
 * itself only consumes `{ core, apps }` (ShimReconcileClients shape).
 */
export interface SwitchWithPauseDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly encryptionKey: string;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export async function switchTargetWithPause(
  deps: SwitchWithPauseDeps,
  input: SwitchWithPauseInput,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<SwitchWithPauseResult> {
  const { db, k8s } = deps;
  const subsystems = SUBSYSTEMS_BY_CLASS[input.className] ?? [];

  // Re-validate the new target BEFORE pausing anything. Closes the
  // preview-to-confirm race the typescript-reviewer flagged: an
  // operator (or concurrent session) could disable the target in
  // the window between the modal preview fetch and the operator
  // clicking Confirm. Without this check we'd pause schedules + WAL
  // and then fail downstream — leaving the partial-state mess.
  if (input.newTargetId !== null) {
    const [tgt] = await db
      .select({ id: backupConfigurations.id, name: backupConfigurations.name, enabled: backupConfigurations.enabled })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, input.newTargetId))
      .limit(1);
    if (!tgt) {
      throw new ApiError(
        'TARGET_NOT_FOUND',
        `backup_configurations row '${input.newTargetId}' not found`,
        400,
      );
    }
    if (tgt.enabled !== 1) {
      throw new ApiError(
        'TARGET_DISABLED',
        `target '${tgt.name}' was disabled between preview and confirm — re-open the picker and try again`,
        400,
      );
    }
  }

  // Pause schedules in a single statement. Returning the actual rows
  // touched so we know what we paused (vs what was already off).
  let paused: ReadonlyArray<string> = [];
  if (subsystems.length > 0) {
    const rows = await db
      .update(backupSchedules)
      .set({
        enabled: false,
        updatedAt: new Date(),
        updatedBy: input.userId,
      })
      .where(and(
        inArray(backupSchedules.subsystem, [...subsystems]),
        eq(backupSchedules.enabled, true),
      ))
      .returning({ subsystem: backupSchedules.subsystem });
    paused = rows.map((r) => r.subsystem);
    log?.info?.({
      msg: 'switch-with-pause: paused schedules',
      className: input.className,
      paused,
    });
  }

  // Disable WAL if currently active for this class. Best-effort —
  // if disable fails (e.g. plugin already gone), log + continue
  // because the assignment switch below still needs to run.
  let walDisabled = false;
  const walRef = WAL_CLUSTER_BY_CLASS[input.className];
  if (walRef) {
    const [walRow] = await db
      .select({ clusterNamespace: systemWalArchiveState.clusterNamespace })
      .from(systemWalArchiveState)
      .where(and(
        eq(systemWalArchiveState.clusterNamespace, walRef.namespace),
        eq(systemWalArchiveState.clusterName, walRef.clusterName),
      ))
      .limit(1);
    if (walRow) {
      try {
        await disableWalArchive({
          db, k8s,
          clusterNamespace: walRef.namespace,
          clusterName: walRef.clusterName,
          operatorUserId: input.userId,
          operatorIp: input.userIp,
        });
        walDisabled = true;
        log?.info?.({
          msg: 'switch-with-pause: disabled WAL archive',
          className: input.className,
          cluster: `${walRef.namespace}/${walRef.clusterName}`,
        });
      } catch (err) {
        // Don't block the target switch — the WAL state will be
        // re-derived once the operator re-enables WAL post-switch.
        log?.warn?.({
          msg: 'switch-with-pause: WAL disable failed (continuing)',
          err: (err as Error).message,
        });
      }
    }
  }

  // Finally, apply the target switch via the existing pipeline.
  // This returns immediately with a taskId; the frontend tracks
  // completion through task-center.
  //
  // applyShimAssignmentChange consumes only { core, apps } so we
  // narrow the full K8sClients via subset assignment.
  //
  // If this throws AFTER we've paused schedules / disabled WAL, surface
  // a structured PARTIAL_STATE error so the frontend can render an
  // explicit recovery instruction ("schedules X were paused and
  // remain off; re-enable them on the Routing tab") rather than a
  // generic "Switch failed" message that hides the side effects.
  let result: Awaited<ReturnType<typeof applyShimAssignmentChange>>;
  try {
    result = await applyShimAssignmentChange({
      db: deps.db,
      k8s: { core: deps.k8s.core, apps: deps.k8s.apps },
      encryptionKey: deps.encryptionKey,
      log: deps.log,
    }, {
      className: input.className,
      targetId: input.newTargetId,
      force: false,
      userId: input.userId,
    });
  } catch (err) {
    const sideEffects: string[] = [];
    if (paused.length > 0) sideEffects.push(`paused schedules: ${paused.join(', ')}`);
    if (walDisabled) sideEffects.push('WAL streaming disabled');
    const sideEffectMsg = sideEffects.length > 0
      ? `Side effects applied: ${sideEffects.join('; ')}. Re-enable manually on the Routing tab if needed. `
      : '';
    const inner = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      'SWITCH_FAILED_AFTER_PAUSE',
      `${sideEffectMsg}Target switch failed: ${inner}`,
      502,
      {
        schedulesPaused: paused,
        walDisabled,
        underlyingError: inner,
      },
    );
  }

  return {
    assignment: result.assignment,
    taskId: result.taskId,
    paused: {
      schedulesPaused: paused,
      walDisabled,
    },
  };
}
