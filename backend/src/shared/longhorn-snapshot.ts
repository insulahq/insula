/**
 * Whether a Longhorn snapshot is one somebody asked for — a restore point —
 * as opposed to one Longhorn or a schedule took.
 *
 * Read from a real cluster (Longhorn v1.12), a snapshot's spec has `volume`,
 * `createSnapshot` and `labels`; who took it is in the STATUS:
 *
 *   - a snapshot taken through the platform (CSI):  status.userCreated true,
 *     labels { type: 'snap' };
 *   - Longhorn's marker on a volume expansion:       status.userCreated false,
 *     status.labels { 'replica-expansion': … };
 *   - a recurring job's snapshot:                    status.userCreated TRUE,
 *     labels { RecurringJob: <job> }.
 *
 * The third is why the flag alone is not enough. A schedule's snapshots are
 * rotated by the schedule, which only runs on an attached volume: on a volume
 * that has been released they are never removed, and counting them would keep
 * that volume "retained" — listed as a restore point, and out of the orphan
 * scan — for good.
 */
export interface LonghornSnapshotLike {
  readonly spec?: { readonly labels?: Readonly<Record<string, string>> | null };
  readonly status?: {
    readonly userCreated?: boolean;
    readonly labels?: Readonly<Record<string, string>> | null;
  };
}

/** The label a recurring job puts on its snapshots (longhorn-recurring-jobs/selection.ts). */
const RECURRING_JOB_LABEL = 'RecurringJob';

export function isSnapshotSomebodyTook(s: LonghornSnapshotLike): boolean {
  if (s.status?.userCreated !== true) return false;
  return !s.spec?.labels?.[RECURRING_JOB_LABEL] && !s.status?.labels?.[RECURRING_JOB_LABEL];
}
