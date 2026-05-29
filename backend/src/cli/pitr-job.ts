/**
 * Postgres PITR Job entrypoint.
 *
 * Runs as a one-shot Kubernetes Job (created by the platform-api
 * route handler) instead of inside the platform-api process. This
 * decouples the orchestration from platform-api's lifecycle —
 * critical because during cutover (postgres briefly unreachable),
 * platform-api's pg connection pool retries saturate the Node event
 * loop, /healthz can't respond, and k8s liveness probe SIGKILLs the
 * pod mid-orchestration. Running in a dedicated Job pod with no
 * postgres-readiness dependencies survives that window cleanly.
 *
 * Inputs are passed as env vars (cleaner than CLI args, easier to
 * escape, and matches platform-api's config style):
 *
 *   PITR_CLUSTER_NAMESPACE      source CNPG cluster's namespace
 *   PITR_CLUSTER_NAME           source CNPG cluster's name
 *   PITR_SNAPSHOT_NAME          Longhorn snapshot CR name
 *   PITR_RECOVERY_TARGET_TIME   ISO-8601 timestamp (optional)
 *   PITR_ACTOR_USER_ID          user id of the operator who triggered
 *
 * Database connection: same DATABASE_URL as platform-api (mounted
 * from platform-config Secret). Kubeconfig: in-cluster service-account
 * token (no KUBECONFIG_PATH set).
 *
 * Exit codes:
 *   0 = orchestration completed successfully
 *   1 = orchestration failed (steps trace + admin notification already
 *       emitted by promotePostgresFromSnapshot's catch block)
 *   2 = setup error (missing env, DB connect failed)
 */

import { sql } from 'drizzle-orm';
import { loadConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/index.js';
import { createK8sClients } from '../modules/k8s-provisioner/k8s-client.js';
import { promotePostgresFromSnapshot, type PitrStep } from '../modules/postgres-restore/service.js';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`pitr-job: ${name} env var is required`);
    process.exit(2);
  }
  return v;
};

async function main(): Promise<void> {
  const clusterNamespace = required('PITR_CLUSTER_NAMESPACE');
  const clusterName = required('PITR_CLUSTER_NAME');
  const snapshotName = required('PITR_SNAPSHOT_NAME');
  const recoveryTargetTime = process.env.PITR_RECOVERY_TARGET_TIME ?? null;
  const actorUserId = process.env.PITR_ACTOR_USER_ID ?? null;

  const config = loadConfig();
  const db = getDb(config.DATABASE_URL);
  const k8s = createK8sClients(); // in-cluster

  console.log(JSON.stringify({
    msg: 'pitr-job starting',
    clusterNamespace, clusterName, snapshotName, recoveryTargetTime, actorUserId,
  }));

  // Wait briefly for the DB pool to settle. The Job pod doesn't go
  // through docker-entrypoint.sh's postgres-wait, so the first query
  // can race the pg pool's TCP+TLS handshake. A single SELECT 1 round
  // forces the pool to actually connect before we attempt the lock
  // read in promotePostgresFromSnapshot.
  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    console.error(JSON.stringify({
      msg: 'pitr-job db-connect failed',
      error: e.message,
      cause: e.cause?.message,
      databaseUrlMasked: config.DATABASE_URL.replace(/:[^@/]+@/, ':***@'),
    }));
    process.exit(2);
  }

  // The job's own name (set by createPitrJob) IS the task chip's refId.
  // pitr-job runs as `node dist/cli/pitr-job.js` inside a pod owned by a
  // Job named `pitr-<cluster>-<ts>`. JOB_NAME comes from the Downward
  // API or — when absent — we derive the pod name → strip the random
  // suffix. createPitrJob always sets JOB_NAME via the Job's pod template.
  const jobNameForChip = process.env.JOB_NAME ?? '';
  const isPromoteMode = process.env.BARMAN_PROMOTE_MODE === 'true';
  const chipKind = isPromoteMode ? 'postgres.barman-promote' : 'postgres.pitr';

  try {
    const result = await promotePostgresFromSnapshot(
      { k8s, db },
      { clusterNamespace, clusterName, snapshotName, recoveryTargetTime, actorUserId },
    );
    console.log(JSON.stringify({ msg: 'pitr-job complete', result }));

    // Phase 3.1 (2026-05-23): when invoked from barman-restore promote,
    // delete the side-by-side restored cluster after the PITR completes
    // successfully. Best-effort — failure here is non-fatal (source is
    // already swapped); surface as admin notification + exit 0 so the
    // task-center chip still goes green.
    if (isPromoteMode) {
      const restoredClusterName = process.env.BARMAN_PROMOTE_RESTORED_CLUSTER;
      if (!restoredClusterName) {
        // Misconfiguration: BARMAN_PROMOTE_MODE=true but the
        // restored-cluster env var is missing. createPitrJob always
        // sets both — this branch shouldn't fire — but log loudly
        // instead of silently skipping (review M-5 2026-05-23).
        console.warn(JSON.stringify({
          msg: 'pitr-job: BARMAN_PROMOTE_MODE=true but BARMAN_PROMOTE_RESTORED_CLUSTER env is missing — skipping cleanup',
        }));
      } else {
        try {
          await k8s.custom.deleteNamespacedCustomObject({
            group: 'postgresql.cnpg.io', version: 'v1', namespace: clusterNamespace,
            plural: 'clusters', name: restoredClusterName,
          } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
          console.log(JSON.stringify({
            msg: 'pitr-job barman-promote-cleanup ok',
            restoredClusterName,
            note: 'side-by-side cluster deleted; PVCs will be GCd by CNPG',
          }));
        } catch (cleanupErr) {
          const cleanupMsg = (cleanupErr as Error).message;
          console.error(JSON.stringify({
            msg: 'pitr-job barman-promote-cleanup failed (non-fatal — source already swapped)',
            restoredClusterName,
            error: cleanupMsg,
            manualCmd: `kubectl -n ${clusterNamespace} delete cluster ${restoredClusterName}`,
          }));
          // Emit an admin notification with the manual command so the
          // operator sees this in the UI without trawling Job logs.
          try {
            const { notifications, users } = await import('../db/schema.js');
            const { inArray } = await import('drizzle-orm');
            const cryptoMod = await import('node:crypto');
            const admins = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
            for (const a of admins) {
              await db.insert(notifications).values({
                id: cryptoMod.randomUUID(),
                userId: a.id,
                type: 'warning',
                title: 'Barman promote: side-by-side cluster cleanup failed',
                message: `Source ${clusterNamespace}/${clusterName} was promoted successfully, but the side-by-side cluster ${restoredClusterName} could not be deleted: ${cleanupMsg}. Run manually: kubectl -n ${clusterNamespace} delete cluster ${restoredClusterName}`,
                resourceType: 'postgres_barman_promote',
                resourceId: restoredClusterName,
              }).catch(() => undefined);
            }
          } catch { /* best-effort — never block exit 0 */ }
        }
      }
    }

    // Finalize the task-center chip — pre-existing PITR codepath
    // didn't do this, so chips stayed in `running` forever. Phase 3.1
    // closes that loop for both PITR and barman-promote.
    //
    // 2026-05-23 follow-up A: persist the FULL step timeline + final
    // outcome into tasks.details so the PitrProgressModal can render
    // the historical timeline when re-opened from the chip AFTER the
    // PersistedLock has been cleared (which is the moment promote
    // completes). Without this, clicking the green chip post-success
    // showed an empty modal — exactly what the operator reported.
    //
    // 2026-05-23 follow-up B: use finalizeByRef (INSERT-or-UPDATE)
    // instead of finishByRef (UPDATE-only). When a PITR rebuilds the
    // SAME cluster that holds the chip table (system-db restoring
    // system-db), the cutover replaces the live DB with a snapshot
    // that pre-dates the chip insert — `finishByRef` then updates 0
    // rows and the chip is LOST forever. finalizeByRef does an upsert
    // with all the metadata needed to recreate the row, so the chip
    // survives self-cluster PITR. Live regression caught on staging
    // 2026-05-23: after a system-db PITR completed, the chip simply
    // didn't exist in the post-cutover tasks table.
    if (jobNameForChip && actorUserId) {
      try {
        const tasksMod = await import('../modules/tasks/service.js');
        const { toSafeText } = await import('@insula/api-contracts');
        const label = isPromoteMode
          ? toSafeText(`Postgres barman-promote (${clusterNamespace}/${clusterName})`)
          : toSafeText(`Postgres PITR (${clusterNamespace}/${clusterName})`);
        await tasksMod.finalizeByRef(db, chipKind, jobNameForChip, {
          status: 'succeeded',
          detailsPatch: {
            steps: result.steps,
            finishedAtIso: new Date().toISOString(),
            mode: isPromoteMode ? 'barman-promote' : 'pitr',
            clusterName: result.clusterName,
            snapshotName: result.snapshotName,
          },
          recreate: {
            scope: 'admin' as const,
            userId: actorUserId,
            label,
            target: {
              type: 'modal' as const,
              modal: 'pitr-progress',
              modalProps: {
                jobName: jobNameForChip,
                clusterNamespace,
                clusterName,
              },
            },
            details: {
              clusterNamespace,
              clusterName,
              snapshotName,
            },
          },
        });
      } catch (chipErr) {
        console.warn(JSON.stringify({
          msg: 'pitr-job: chip finalize failed (non-fatal)',
          chipKind, refId: jobNameForChip,
          error: (chipErr as Error).message,
        }));
      }
    }

    await closeDb();
    process.exit(0);
  } catch (err) {
    const e = err as Error & { steps?: readonly PitrStep[]; code?: number; cause?: Error };
    console.error(JSON.stringify({
      msg: 'pitr-job failed',
      error: e.message,
      cause: e.cause?.message,
      code: e.code,
      steps: e.steps,
    }));
    // Finalize the chip as failed so the operator sees a red badge
    // instead of a forever-spinning one. Also persist whatever
    // step-timeline the orchestrator emitted before failing — the
    // modal needs this to show WHICH step failed when re-opened.
    // Same finalizeByRef upsert as the success path: handles the
    // case where the chip's home DB was rebuilt mid-orchestration.
    if (jobNameForChip && actorUserId) {
      try {
        const tasksMod = await import('../modules/tasks/service.js');
        const { toSafeText } = await import('@insula/api-contracts');
        const label = isPromoteMode
          ? toSafeText(`Postgres barman-promote (${clusterNamespace}/${clusterName})`)
          : toSafeText(`Postgres PITR (${clusterNamespace}/${clusterName})`);
        await tasksMod.finalizeByRef(db, chipKind, jobNameForChip, {
          status: 'failed',
          error: e.message,
          detailsPatch: {
            steps: e.steps ?? [],
            finishedAtIso: new Date().toISOString(),
            mode: isPromoteMode ? 'barman-promote' : 'pitr',
            failedAtStep: e.steps && e.steps.length > 0 ? e.steps[e.steps.length - 1]?.step : null,
          },
          recreate: {
            scope: 'admin' as const,
            userId: actorUserId,
            label,
            target: {
              type: 'modal' as const,
              modal: 'pitr-progress',
              modalProps: {
                jobName: jobNameForChip,
                clusterNamespace,
                clusterName,
              },
            },
            details: { clusterNamespace, clusterName, snapshotName },
          },
        });
      } catch { /* best-effort */ }
    }
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'pitr-job uncaught', error: (err as Error).message }));
  process.exit(2);
});
