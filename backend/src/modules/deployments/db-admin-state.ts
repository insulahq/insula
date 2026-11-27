/**
 * The database-admin reconciler's bookkeeping (database_admin_state): what a
 * check leaves in the row, and when an incident is announced. Pure — no I/O
 * here; db-admin-reconciler.ts does the checks.
 */

import type { catalogEntries, databaseAdminState } from '../../db/schema.js';
import type { AdminAccessMode } from './db-admin-access.js';
import type { Engine } from './db-manager.js';

/** Every ten minutes: a drifted login is set back within that. */
export const DATABASE_ADMIN_TICK_MS = 10 * 60 * 1000;
/** A full check this often; the ticks between only prove the logins still work. */
export const SHAPE_INTERVAL_MS = 60 * 60 * 1000;
/** The pass over what a tenant could have left while it held root: first check, a new pod, then this often. */
export const HARDEN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A lockout is announced once it has lasted this long: a restart's few seconds without the socket are not one. */
export const LOCKOUT_ALERT_AFTER_MS = 5 * 60 * 1000;
/** A database that has not answered for this long is announced too: nothing manages it meanwhile. */
export const UNREACHABLE_ALERT_AFTER_MS = 60 * 60 * 1000;
/** A set-up (hardening pass) that has kept failing this long is announced: the tenant has no SQL Manager meanwhile. */
export const STUCK_ALERT_AFTER_MS = 6 * 60 * 60 * 1000;
/** Clocks of a row not checked for this long (a stopped instance) start again: its old incident is over. */
export const STALE_ROW_MS = 3 * 10 * 60 * 1000;
/** On-demand runs for one instance (the credentials view re-reads while its account is set up): at most this often. */
export const ON_DEMAND_MIN_INTERVAL_MS = 30 * 1000;

/** States the reconciler records beyond the modes of db-admin-access.ts. */
export type DatabaseAdminStateMode = AdminAccessMode
  /** MongoDB without authentication (an app stack's choice): no administrator login exists. */
  | 'open'
  /** The database did not answer (no pod, restarting): not checked this time. */
  | 'unreachable';

export const TARGET_MODES: ReadonlySet<DatabaseAdminStateMode> = new Set(['socket', 'trust', 'restricted', 'open']);
/** Modes in which the platform logs in — so it can keep the tenant administrator up. */
export const LOGGED_IN_MODES: ReadonlySet<DatabaseAdminStateMode> = new Set(['socket', 'trust', 'restricted', 'password']);

export interface ManagedDatabase {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly engine: Engine;
  readonly componentName: string;
  /** A standalone instance (catalog type `database`), not a component of an app stack. */
  readonly standalone: boolean;
  readonly entry: typeof catalogEntries.$inferSelect;
  readonly configuration: Record<string, unknown>;
  /** Extra mounts stored on the deployment (a standalone instance may have none — service.ts). */
  readonly extraMountCount: number;
}

export type StateRow = typeof databaseAdminState.$inferSelect;
/** The row a check writes: root_secret_cipher is the rotation's alone. */
export type StateValues = Omit<StateRow, 'rootSecretCipher'>;

export interface InstanceOutcome {
  readonly md: ManagedDatabase;
  readonly mode: DatabaseAdminStateMode;
  readonly changes: readonly string[];
  readonly detail?: string;
  /** A full check ran (not only the quick login proof). */
  readonly full?: boolean;
  /** The hardening pass ran to the end, without a failed step. */
  readonly hardened?: boolean;
  /** The set-up has not finished: a pass failed now, or one failed earlier and waits for its retry. */
  readonly stuck?: boolean;
  /** A hardening pass ran this time and did not finish. */
  readonly hardenTried?: boolean;
  /** The pod the check ran in. */
  readonly pod?: string;
  /** MongoDB root's password was replaced this run. */
  readonly rotated?: boolean;
}

/**
 * The state row an outcome leaves. An unreachable instance keeps what was
 * last known about its login and starts (or keeps) its unreachable clock; a
 * lockout keeps the incident's start and whether it alerted; anything else
 * ends both.
 */
export function stateValuesFor(o: InstanceOutcome, prevRow: StateRow | undefined, now: Date): StateValues {
  // A row nobody checked for a while (the instance was stopped): what it says
  // about an incident is old news, and its clocks start again.
  const prev = prevRow && now.getTime() - prevRow.checkedAt.getTime() > STALE_ROW_MS
    ? { ...prevRow, lockedSince: null, unreachableSince: null, stuckSince: null, alertedAt: null }
    : prevRow;
  if (o.mode === 'unreachable' && prev) {
    const kept: Partial<StateRow> = { ...prev };
    delete kept.rootSecretCipher;
    return {
      ...(kept as StateValues),
      checkedAt: now,
      detail: o.detail ? o.detail.slice(0, 1000) : prev.detail,
      unreachableSince: prev.unreachableSince ?? now,
    };
  }
  const locked = o.mode === 'locked';
  const unreachable = o.mode === 'unreachable';
  // A quick check proves the logins and says nothing about the set-up: it keeps what was known.
  const stuckSince = o.stuck ? (prev?.stuckSince ?? now) : o.full ? null : (prev?.stuckSince ?? null);
  return {
    deploymentId: o.md.deploymentId,
    tenantId: o.md.tenantId,
    engine: o.md.engine,
    mode: o.mode,
    // Tenant-influenced text (a client's error): capped for the row, the log and the alert.
    detail: o.detail ? o.detail.slice(0, 1000) : null,
    lastChanges: o.changes.length > 0 ? o.changes.join('; ') : (prev?.lastChanges ?? null),
    checkedAt: now,
    convertedAt: prev?.convertedAt ?? (TARGET_MODES.has(o.mode) ? now : null),
    lockedSince: locked ? (prev?.lockedSince ?? now) : null,
    unreachableSince: unreachable ? now : null,
    stuckSince,
    alertedAt: locked || unreachable || stuckSince ? (prev?.alertedAt ?? null) : null,
    shapedAt: o.full ? now : (prev?.shapedAt ?? null),
    hardenTriedAt: o.hardenTried ? now : o.hardened ? null : (prev?.hardenTriedAt ?? null),
    hardenedAt: o.hardened ? now : (prev?.hardenedAt ?? null),
    hardenedPod: o.hardened ? (o.pod ?? null) : (prev?.hardenedPod ?? null),
    rootRotatedAt: o.rotated ? now : (prev?.rootRotatedAt ?? null),
  };
}

/** What a check means for the incident: one to announce now, a recovery to announce, or neither. */
export function incidentTransition(
  mode: DatabaseAdminStateMode,
  before: StateRow | undefined,
  after: StateValues,
  now: Date,
): 'announce-lost' | 'announce-restored' | 'none' {
  // Announced already: still going (a logged-in mode clears alerted_at, below).
  if (after.alertedAt) return 'none';
  if (mode === 'locked' && after.lockedSince) {
    return now.getTime() - after.lockedSince.getTime() >= LOCKOUT_ALERT_AFTER_MS ? 'announce-lost' : 'none';
  }
  if (mode === 'unreachable' && after.unreachableSince) {
    return now.getTime() - after.unreachableSince.getTime() >= UNREACHABLE_ALERT_AFTER_MS ? 'announce-lost' : 'none';
  }
  if (after.stuckSince) {
    return now.getTime() - after.stuckSince.getTime() >= STUCK_ALERT_AFTER_MS ? 'announce-lost' : 'none';
  }
  if ((LOGGED_IN_MODES.has(mode) || mode === 'open') && before?.alertedAt && (before.lockedSince || before.unreachableSince || before.stuckSince)) {
    return 'announce-restored';
  }
  return 'none';
}

/** Why the instance is in an incident, for the notification's list item. */
export function incidentReason(row: StateValues): string {
  // The row keeps the last known mode while unreachable: the clocks say which incident it is.
  if (row.lockedSince) return `login refused — ${row.detail ?? 'no detail'}`;
  if (row.unreachableSince) return `no answer for over an hour — ${row.detail ?? 'no detail'}`;
  return `set-up has not finished for six hours, its tenant has no SQL Manager — ${row.detail ?? 'no detail'}`;
}
