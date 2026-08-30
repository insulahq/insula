/**
 * Who hears about a finished tenant bundle.
 *
 * Extracted from the orchestrator's fan-out block so the rule is one
 * greppable, testable statement rather than a condition buried 700 lines into
 * a function that also runs backups.
 */

/** Who asked for this bundle run. `system` and `cluster` are both automated
 *  (cron / platform-wide sweeps) and carry no triggering user — orchestrator.ts
 *  documents them together, and routes.ts pairs them the same way. */
export type BundleInitiator = 'system' | 'cluster' | 'tenant' | 'admin' | undefined;

/** Automated runs: nobody asked, nobody is waiting. */
const AUTOMATED: ReadonlySet<string> = new Set(['system', 'cluster']);

/**
 * Should the TENANT's users be notified about this bundle's outcome?
 *
 * No, for scheduled runs — success or failure.
 *
 * A tenant did not ask for a scheduled run and cannot act on it: the schedule
 * is the platform's, the retention is the platform's, and the remedy for a
 * failure is the operator's. A nightly "Scheduled backup completed" trains
 * tenants to ignore the bell, which then hides the notifications that do need
 * them — the on-demand backup they just started, or a restore they ran.
 *
 * Operator visibility is unchanged: admins are still notified on failure by a
 * separate fan-out, and every outcome is recorded on the bundle either way.
 */
export function shouldNotifyTenant(initiator: BundleInitiator): boolean {
  return !(initiator !== undefined && AUTOMATED.has(initiator));
}

/**
 * Should platform admins be notified? Failures only, for any initiator —
 * including the automated ones, which is precisely when no tenant is watching.
 */
export function shouldNotifyAdmins(initiator: BundleInitiator, failed: boolean): boolean {
  void initiator;
  return failed;
}
