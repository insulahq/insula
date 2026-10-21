/**
 * Apply a saved retention change straight away, instead of at the class's
 * next run.
 *
 * Each class already enforces its retention on its own cadence — the tenant
 * sweep every 5 minutes, the mail Job on its snapshot cron, the DR pass every
 * 5 minutes. This is the accelerator the schedule route calls after a save, so
 * the operator sees the result while still on the page: lowered limits remove
 * what no longer fits, raised ones simply stop removing. Every path here is the
 * same leased/gated code the cadence runs, so a failure only means the change
 * lands on the next tick; it is logged, never thrown at the request.
 *
 * Runs in the background: removing a few hundred bundles from a slow target
 * takes minutes, and the save must not wait for it.
 */
import type { FastifyInstance } from 'fastify';
import { DR_ARTEFACT_SUBSYSTEMS, type DrArtefactSubsystem } from './dr-artefact-retention.js';

export type RetentionNowRunner = (app: FastifyInstance, subsystem: string) => Promise<void>;

function k8sCore(app: FastifyInstance) {
  return import('../k8s-provisioner/k8s-client.js').then(({ createK8sClients }) => {
    const kubeconfigPath = (app.config as Record<string, unknown> | undefined)?.KUBECONFIG_PATH as string | undefined
      ?? process.env.KUBECONFIG_PATH;
    return createK8sClients(kubeconfigPath);
  });
}

async function tenantBundlesNow(app: FastifyInstance): Promise<void> {
  const { runRetentionSweepLeased } = await import('../tenant-bundles/retention.js');
  // The sweep drains in batches within its time budget; a backlog bigger than
  // one tick's budget carries on at the next tick.
  const swept = await runRetentionSweepLeased(app);
  if (!swept) {
    app.log.info('backup-schedules: tenant retention saved — another replica holds the sweep; its next tick applies it');
    return;
  }
  if (swept.expiredDeleted === 0) return;
  // The bundles are gone from the list; their restic data is reclaimed by the
  // restic sweep, normally every 6 hours. Run it now so the space comes back
  // with the change. Same run lock as the scheduled sweep and the manual one.
  const secretsKeyHex = (app.config as Record<string, unknown> | undefined)?.PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) return;
  const [{ runResticRetentionSweep, RESTIC_SWEEP_RUN_LOCK, RESTIC_SWEEP_RUN_TTL_MS }, { withSchedulerLease }, k8s] = await Promise.all([
    import('../tenant-bundles/restic-retention.js'),
    import('../../shared/scheduler-lease.js'),
    k8sCore(app),
  ]);
  const run = await withSchedulerLease(app.db, RESTIC_SWEEP_RUN_LOCK, RESTIC_SWEEP_RUN_TTL_MS, () => runResticRetentionSweep({
    db: app.db, k8s, secretsKeyHex, logger: app.log,
  }), { release: true, log: app.log });
  if (!run.ran) app.log.info('backup-schedules: a restic sweep is already running — it reclaims the expired bundles');
}

async function mailNow(app: FastifyInstance): Promise<void> {
  const [{ applyMailRetentionNow, createMailRetentionNowDeps }, k8s] = await Promise.all([
    import('../mail-admin/snapshot-forget.js'),
    k8sCore(app),
  ]);
  const result = await applyMailRetentionNow(await createMailRetentionNowDeps(app.db, k8s.core, app.log));
  app.log.info({ result }, 'backup-schedules: mail retention applied now');
}

async function drArtefactNow(app: FastifyInstance, subsystem: DrArtefactSubsystem): Promise<void> {
  const [{ runDrArtefactRetentionLeased, createDrArtefactRetentionDeps }, k8s] = await Promise.all([
    import('./dr-artefact-retention.js'),
    k8sCore(app),
  ]);
  const result = await runDrArtefactRetentionLeased(app.db, createDrArtefactRetentionDeps(app.db, k8s.core, app.log), [subsystem]);
  if (result === null) {
    app.log.info({ subsystem }, 'backup-schedules: retention saved — another replica holds the DR pass; its next tick applies it');
  }
}

/** The work for one subsystem; resolves when it is done (tests await it). */
export const runRetentionNow: RetentionNowRunner = async (app, subsystem) => {
  if (subsystem === 'tenant_bundle') return tenantBundlesNow(app);
  if (subsystem === 'mail') return mailNow(app);
  if ((DR_ARTEFACT_SUBSYSTEMS as readonly string[]).includes(subsystem)) {
    return drArtefactNow(app, subsystem as DrArtefactSubsystem);
  }
};

/** Fire and forget, for the route. */
export function applyRetentionNow(app: FastifyInstance, subsystem: string, run: RetentionNowRunner = runRetentionNow): void {
  void run(app, subsystem).catch((err: unknown) => {
    app.log.warn({ err: err instanceof Error ? err.message : String(err), subsystem },
      'backup-schedules: retention saved, but applying it now failed — the next scheduled pass applies it');
  });
}
