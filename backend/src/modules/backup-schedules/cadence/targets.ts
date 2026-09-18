/**
 * What each schedulable DR artefact is, and how its cadence can actually be
 * changed.
 *
 * The honest answer differs per object, because they are owned by different
 * things, and pretending otherwise is how an operator ends up editing a field
 * that silently does nothing:
 *
 *   `cronjob-owned`   The CronJob is NOT reconciled by Flux (it ships
 *                     `kustomize.toolkit.fluxcd.io/reconcile: disabled`), so
 *                     the platform owns every field and `spec.schedule` can
 *                     simply be patched. Only `etcd-snap-via-shim`.
 *
 *   `cronjob-flux`    Flux owns `spec.schedule` and reverts any patch within
 *                     its interval (1 minute on production), so the schedule
 *                     is NEVER patched. Instead: while the operator's cron
 *                     equals the manifest default the CronJob fires itself
 *                     (native); the moment it differs the CronJob is suspended
 *                     and the platform fires Jobs from its own template on the
 *                     operator's cron. This is the mail-snapshot design
 *                     (R17.1) — `/spec/suspend` is already stripped from
 *                     Flux's apply for these two by bootstrap.sh, so suspend
 *                     is ours to own.
 *
 *   `cnpg-backup`     A CNPG ScheduledBackup, created outside Flux, so its
 *                     schedule is patchable. Note its cron has SIX fields
 *                     (leading seconds) — a 5-field operator expression is
 *                     converted on write.
 *
 *   `read-only`       The cadence is compiled into a Flux-managed manifest and
 *                     the object has no suspend field, and platform-api holds
 *                     no RBAC for it. The card shows the live value and says
 *                     it cannot be changed here, rather than offering an edit
 *                     that Flux would undo a minute later.
 */

export type CadenceMechanism = 'cronjob-owned' | 'cronjob-flux' | 'cnpg-backup' | 'read-only';

export interface CadenceTarget {
  /** `backup_schedules.subsystem`. */
  readonly subsystem: string;
  readonly mechanism: CadenceMechanism;
  readonly namespace: string;
  readonly name: string;
  /**
   * The cadence compiled into the manifest. For `cronjob-flux` this is the
   * pivot: equal to it → the CronJob fires natively; different → the platform
   * takes over firing. Keep it in sync with the manifest, or a cluster running
   * the default will be needlessly moved onto platform firing.
   */
  readonly manifestDefault: string;
  /** Human label used in logs and operator-facing errors. */
  readonly label: string;
}

export const CADENCE_TARGETS: readonly CadenceTarget[] = [
  {
    subsystem: 'etcd_snapshot',
    mechanism: 'cronjob-owned',
    namespace: 'platform',
    name: 'etcd-snap-via-shim',
    manifestDefault: '0 * * * *',
    label: 'etcd snapshot upload',
  },
  {
    subsystem: 'secrets_bundle',
    mechanism: 'cronjob-flux',
    namespace: 'platform',
    name: 'platform-secrets-backup',
    manifestDefault: '15 3 * * *',
    label: 'secrets bundle',
  },
  {
    subsystem: 'cluster_state',
    mechanism: 'cronjob-flux',
    namespace: 'platform',
    name: 'platform-cluster-state-backup',
    manifestDefault: '0 3 * * *',
    label: 'cluster state dump',
  },
  // `system_pitr` is deliberately ABSENT.
  //
  // The Postgres base backup already has a purpose-built control — the
  // Postgres card on the Backups tab — which writes the ScheduledBackup
  // through `enableWalArchive` together with the retention policy and the WAL
  // archive timeout, validates them against each other, and records them in
  // `system_wal_archive_state`. Driving the same object from
  // `backup_schedules.system_pitr` as well would give an operator two cadence
  // fields, on two tabs, backed by two tables, writing one object: whichever
  // wrote last would win, and this reconciler's 5-minute tick would quietly
  // revert anything set on the Postgres card.
  //
  // The `system_pitr` ROW still exists (migration 0011, used by
  // switch-with-pause). It simply is not a cadence target, and the System
  // Backups page does not render a card for it.
  {
    subsystem: 'longhorn_recurring',
    mechanism: 'read-only',
    namespace: 'longhorn-system',
    name: 'hourly-snap',
    manifestDefault: '5 * * * *',
    label: 'Longhorn recurring snapshot',
  },
];

export function targetFor(subsystem: string): CadenceTarget | undefined {
  return CADENCE_TARGETS.find((t) => t.subsystem === subsystem);
}

/**
 * CNPG schedules are quartz-style with a leading SECONDS field; the operator
 * types the ordinary 5-field form everywhere else in this UI.
 *
 * Returns null for anything that is not a 5- or 6-field expression rather than
 * guessing — a malformed schedule on a ScheduledBackup is rejected by the CNPG
 * webhook and would leave the reconciler retrying forever.
 */
export function toCnpgCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length === 6) return fields.join(' ');
  if (fields.length === 5) return `0 ${fields.join(' ')}`;
  return null;
}

/** Inverse of {@link toCnpgCron}, for displaying a CNPG schedule to an operator. */
export function fromCnpgCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 6 ? fields.slice(1).join(' ') : fields.join(' ');
}
