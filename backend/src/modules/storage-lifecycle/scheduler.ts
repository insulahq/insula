import { runExclusive } from '../../shared/exclusive-run.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveSnapshotStore } from './snapshot-store.js';
import { expireSnapshots, storageAuditReport } from './service.js';
import {
  sweepTenantsOnce,
  TENANT_AUTOMATION_INTERVAL_MS,
  TENANT_AUTOMATION_MAX_HOLD_MS,
} from '../tenant-lifecycle/automation/real.js';

/**
 * Storage-lifecycle housekeeping scheduler.
 *
 * Runs two periodic jobs:
 *   - snapshot-expiry: every 6 hours, reap any storage_snapshots past
 *     their expires_at timestamp. Frees disk on the snapshot store.
 *   - audit-report: every 7 days, compute provisioned-vs-used stats
 *     for all active tenants and log to stdout (future work:
 *     email operators or surface in the admin UI dashboard).
 *
 * Both jobs are best-effort — a failure in one cycle doesn't stop
 * the next. The scheduler stops cleanly when the returned Timeout
 * is cleared.
 */

const EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Issue 1 fix: every 30 minutes, sweep all provisioned tenants for missing
// PVC / RQ / NetPol and auto-repair. Cluster rebootstraps and DR restores
// can leave the namespace as a husk that the lifecycle module never fully
// rehydrated. 30 min is a reasonable detection bound — operators can also
// trigger a manual repair from the admin UI.
const INTEGRITY_INTERVAL_MS = 30 * 60 * 1000;
// Quiesce watchdog: reap abandoned mid-quiesce storage ops and restore
// workloads left at 0 replicas. 15 min
// bounds how long a stranded tenant site can stay down unnoticed.
const QUIESCE_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000;
// Workload-health reconciler: the only check that asks whether a tenant's
// workloads are actually RUNNING, auto-heals the ones that are not, and alerts
// the operator when it cannot. 5 min, because the failure it exists to catch ran
// for 18h38m unnoticed on production — every other check passed while the tenant
// was completely down. Detection is bounded by this interval plus the reconciler
// grace window, so ~13 min worst case instead of "until a human notices".
const WORKLOAD_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

export function startStorageLifecycleScheduler(
  db: Database,
  k8s: K8sClients,
  config: Record<string, unknown>,
): { stop: () => void } {
  console.log('[storage-lifecycle-scheduler] Starting (snapshot expiry + audit reports)');

  // Re-resolve the store each tick so an operator rotating S3 keys /
  // swapping backends in the admin UI picks up on the next cycle
  // without a backend restart. `loadStorageLifecycleSettings` already
  // caches at the DB layer (60s TTL) so this is cheap.
  //
  // `buildCtx` is the legacy/read-only path used by expireSnapshots and
  // storageAuditReport — neither writes a new snapshot row, so the
  // single-active-target fallback is fine for them.
  const buildCtx = async () => ({
    db,
    k8s,
    store: await resolveSnapshotStore(db, config as Record<string, string | undefined>),
    platformNamespace: (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform',
  });

  let expiryTimer: NodeJS.Timeout | null = null;
  let auditTimer: NodeJS.Timeout | null = null;
  let lifecycleTimer: NodeJS.Timeout | null = null;
  let integrityTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const runExpiry = async () => {
    if (stopped) return;
    try {
      // One replica expires: a snapshot on an SSH or CIFS target is deleted by a
      // one-shot Job, and two replicas each started one for the same snapshot.
      const leased = await withSchedulerLease(db, 'storage-snapshot-expiry', EXPIRY_INTERVAL_MS * 1.5,
        async () => expireSnapshots(await buildCtx()));
      const reaped = leased.ran ? leased.value : 0;
      if (reaped > 0) console.log(`[storage-lifecycle-scheduler] Reaped ${reaped} expired snapshot(s)`);
    } catch (err) {
      console.error('[storage-lifecycle-scheduler] expireSnapshots failed:', (err as Error).message);
    }
    if (!stopped) expiryTimer = setTimeout(runExpiry, EXPIRY_INTERVAL_MS);
  };

  const runAudit = async () => {
    if (stopped) return;
    try {
      // One replica audits: the report measures every tenant's volume from
      // inside its file manager.
      await withSchedulerLease(db, 'storage-audit', AUDIT_INTERVAL_MS * 1.5, async () => {
        const report = await storageAuditReport(await buildCtx());
        const totalWasteGi = report.reduce((sum, r) => {
          const provisioned = r.provisionedGi * 1024 * 1024 * 1024;
          return sum + Math.max(0, (provisioned - r.usedBytes) / (1024 ** 3));
        }, 0);
        console.log(`[storage-lifecycle-scheduler] Audit: ${report.length} tenants, ${totalWasteGi.toFixed(1)} GiB provisioned-not-used`);
      });
    } catch (err) {
      console.error('[storage-lifecycle-scheduler] audit failed:', (err as Error).message);
    }
    if (!stopped) auditTimer = setTimeout(runAudit, AUDIT_INTERVAL_MS);
  };

  /**
   * Automatic archive and delete (tenant-lifecycle/automation): tenants
   * suspended, or archived, for longer than the admin's limits. Both steps are
   * off until switched on under Platform → Tenant Lifecycle Hooks.
   */
  const runLifecycle = async () => {
    if (stopped) return;
    // One replica sweeps, and one sweep runs at a time: the admin's "Run now"
    // takes the same run lock. The reschedule below runs whether or not this
    // replica held the lease.
    try {
      await withSchedulerLease(db, 'storage-auto-archive', TENANT_AUTOMATION_INTERVAL_MS * 1.5, async () => {
        // Skipped when a sweep is under way already — that is what this tick wanted.
        await runExclusive(db, 'storage-auto-archive', () => sweepTenantsOnce({ db, k8s, config }, 'schedule'), {
          maxHoldMs: TENANT_AUTOMATION_MAX_HOLD_MS,
        });
      });
    } catch (err) {
      console.error('[tenant-automation] sweep failed:', (err as Error).message);
    }
    if (!stopped) lifecycleTimer = setTimeout(runLifecycle, TENANT_AUTOMATION_INTERVAL_MS);
  };

  // Issue 1 fix: namespace integrity sweep. Repairs missing PVC / RQ /
  // NetPol on provisioned tenants (post-rebootstrap drift). Self-heals
  // without operator action; emits notifications when something is
  // repaired or fails.
  const runIntegrity = async () => {
    if (stopped) return;
    try {
      // One replica repairs: a repair is followed by an alert deduplicated by
      // a lookup only, and a replica losing the repair race reports a partial
      // failure for what the other one repaired.
      await withSchedulerLease(db, 'namespace-integrity', INTEGRITY_INTERVAL_MS * 1.5, async () => {
        const { sweepFleetIntegrity } = await import('../namespace-integrity/service.js');
        // The run lock keeps this sweep off one an operator has started.
        const run = await runExclusive(db, 'namespace-integrity', () => sweepFleetIntegrity(db, k8s));
        if (!run.ran) return;
        const result = run.value;
        if (result.repaired > 0 || result.errored > 0) {
          console.log(`[namespace-integrity] sweep: checked=${result.checked} repaired=${result.repaired} errored=${result.errored}`);
        }
      });
    } catch (err) {
      console.error('[namespace-integrity] sweep failed:', (err as Error).message);
    }
    if (!stopped) integrityTimer = setTimeout(runIntegrity, INTEGRITY_INTERVAL_MS);
  };

  // Phase 12: orphan-Secret reaper.
  //
  // Streaming Jobs (snapshot / restore / speedtest / cifs-oneshot) create
  // an ephemeral credentials Secret BEFORE the Job, then patch
  // ownerReferences AFTER the Job is created so cascade GC fires on
  // TTL expiry. If the orchestrator crashes between those two steps,
  // a Secret can be orphaned (no owner → no cascade). This sweep finds
  // them by label + age and deletes them.
  //
  // Frequency: every 1h. Threshold: 2× the longest Job
  // activeDeadlineSeconds (6h streaming Jobs → 12h cutoff) so we never
  // delete a Secret a slow Job still needs.
  const ORPHAN_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
  const ORPHAN_SECRET_MIN_AGE_MS = 12 * 60 * 60 * 1000; // 12h
  let orphanSecretTimer: NodeJS.Timeout | null = null;

  const runOrphanSecretSweep = async () => {
    if (stopped) return;
    try {
      const platformNamespace = (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
      const { RCLONE_CREDS_LABEL_SELECTOR } = await import('./streaming-store.js');
      const list = await (k8s.core as unknown as {
        listNamespacedSecret: (args: { namespace: string; labelSelector?: string }) => Promise<{
          items: Array<{
            metadata?: { name?: string; ownerReferences?: unknown[]; creationTimestamp?: string };
          }>;
        }>;
      }).listNamespacedSecret({ namespace: platformNamespace, labelSelector: RCLONE_CREDS_LABEL_SELECTOR });
      const now = Date.now();
      let reaped = 0;
      for (const sec of list.items ?? []) {
        const name = sec.metadata?.name;
        if (!name) continue;
        const hasOwner = (sec.metadata?.ownerReferences ?? []).length > 0;
        if (hasOwner) continue; // cascade GC will handle it
        const created = sec.metadata?.creationTimestamp ? new Date(sec.metadata.creationTimestamp).getTime() : 0;
        if (created === 0 || now - created < ORPHAN_SECRET_MIN_AGE_MS) continue;
        try {
          await (k8s.core as unknown as {
            deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<unknown>;
          }).deleteNamespacedSecret({ name, namespace: platformNamespace });
          reaped += 1;
        } catch (err) {
          console.warn(`[orphan-secret-sweep] delete failed for ${name}: ${(err as Error).message}`);
        }
      }
      if (reaped > 0) {
        console.log(`[orphan-secret-sweep] reaped ${reaped} orphan rclone-creds Secret(s)`);
      }
    } catch (err) {
      console.error('[orphan-secret-sweep] cycle failed:', (err as Error).message);
    }
    if (!stopped) orphanSecretTimer = setTimeout(runOrphanSecretSweep, ORPHAN_SWEEP_INTERVAL_MS);
  };

  // Quiesce watchdog — restores tenants stranded at 0 replicas by an
  // abandoned/crashed storage op. See quiesce-watchdog.ts.
  let quiesceWatchdogTimer: NodeJS.Timeout | null = null;
  const runQuiesceWatchdog = async () => {
    if (stopped) return;
    try {
      // One replica recovers: an abandoned operation is not claimed, so two
      // replicas ran the same recovery — one re-pinning the workloads while
      // the other scaled them up.
      await withSchedulerLease(db, 'storage-quiesce-watchdog', QUIESCE_WATCHDOG_INTERVAL_MS * 1.5, async () => {
        // First the archives a restart cut off: they are started again, not failed.
        const { resumeInterruptedArchives } = await import('./archive-resume.js');
        await resumeInterruptedArchives(db, k8s, config).catch((err: unknown) => {
          console.error('[archive-resume] failed:', err instanceof Error ? err.message : String(err));
        });
        const { sweepAbandonedQuiesce } = await import('./quiesce-watchdog.js');
        const result = await sweepAbandonedQuiesce(db, k8s);
        if (result.abandonedOps > 0 || result.recoveredNamespaces > 0) {
          console.log(`[quiesce-watchdog] abandonedOps=${result.abandonedOps} recoveredNamespaces=${result.recoveredNamespaces}`);
        }
      });
    } catch (err) {
      console.error('[quiesce-watchdog] sweep failed:', (err as Error).message);
    }
    if (!stopped) quiesceWatchdogTimer = setTimeout(runQuiesceWatchdog, QUIESCE_WATCHDOG_INTERVAL_MS);
  };

  // Workload-health reconciler — detect tenants whose workloads are not
  // running, re-stage the volume to heal them, alert when that fails.
  // See workload-health.ts.
  let workloadHealthTimer: NodeJS.Timeout | null = null;
  const runWorkloadHealth = async () => {
    if (stopped) return;
    try {
      const { reconcileTenantWorkloadHealth } = await import('./workload-health.js');
      // One replica heals (lease) — two re-staging the same volume at once race.
      const leased = await withSchedulerLease(db, 'tenant-workload-health', WORKLOAD_HEALTH_INTERVAL_MS * 1.5,
        () => reconcileTenantWorkloadHealth(db, k8s));
      const r = leased.ran ? leased.value : null;
      // Log only when something happened — a quiet fleet must stay quiet, or the
      // one tick that matters is invisible in the noise.
      if (r && (r.observedDown > 0 || r.episodesCleared > 0 || r.alerted > 0)) {
        console.log(
          `[workload-health] down=${r.observedDown} opened=${r.episodesOpened} cleared=${r.episodesCleared} `
          + `healAttempted=${r.healAttempted} healed=${r.healed} alerted=${r.alerted}`,
        );
      }
    } catch (err) {
      console.error('[workload-health] reconcile failed:', (err as Error).message);
    }
    if (!stopped) workloadHealthTimer = setTimeout(runWorkloadHealth, WORKLOAD_HEALTH_INTERVAL_MS);
  };

  expiryTimer = setTimeout(runExpiry, INITIAL_DELAY_MS);
  auditTimer = setTimeout(runAudit, INITIAL_DELAY_MS + 30_000);
  lifecycleTimer = setTimeout(runLifecycle, INITIAL_DELAY_MS + 60_000);
  integrityTimer = setTimeout(runIntegrity, INITIAL_DELAY_MS + 90_000);
  orphanSecretTimer = setTimeout(runOrphanSecretSweep, INITIAL_DELAY_MS + 120_000);
  quiesceWatchdogTimer = setTimeout(runQuiesceWatchdog, INITIAL_DELAY_MS + 150_000);
  workloadHealthTimer = setTimeout(runWorkloadHealth, INITIAL_DELAY_MS + 180_000);

  return {
    stop: () => {
      stopped = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (auditTimer) clearTimeout(auditTimer);
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      if (integrityTimer) clearTimeout(integrityTimer);
      if (orphanSecretTimer) clearTimeout(orphanSecretTimer);
      if (quiesceWatchdogTimer) clearTimeout(quiesceWatchdogTimer);
      if (workloadHealthTimer) clearTimeout(workloadHealthTimer);
    },
  };
}
