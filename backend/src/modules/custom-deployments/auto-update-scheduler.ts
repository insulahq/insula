// Hourly same-tag re-pull for custom single-container deployments.
//
// WHAT IT DOES, PRECISELY: for each deployment with `autoUpdate` on, ask the
// registry what digest the tenant's ALREADY-PINNED tag resolves to today. If
// that differs from the digest the pods are observed running, roll the pods.
// It never changes the tag, so it cannot move anyone across a version
// boundary — a genuinely new tag (1.27 → 1.28) is surfaced by the updates pill
// for the tenant to apply deliberately.
//
// ROLLBACK: the digest running before the roll is stashed in the spec. If the
// new pods do not reach Ready within ROLLOUT_TIMEOUT_MS, the deployment is
// pinned back to that exact digest (`repo@sha256:…`, not the tag — the tag now
// points at the broken image), auto-update is switched OFF so the next tick
// cannot re-break it, and the tenant is notified. Leaving auto-update on after
// an automated change broke a workload would reapply the same failure hourly.
//
// SAFETY PROPERTIES worth preserving:
//   • "cannot tell" is never "it changed" — an unreachable registry, a missing
//     digest header or a not-yet-observed running digest all mean SKIP. The
//     alternative is rolling every auto-update workload on the platform every
//     hour whenever a registry has a bad day.
//   • Compose stacks are skipped even if the flag somehow got set — N images,
//     N digests, no single meaningful event.
//   • Suspended/archived tenants are skipped: assertTenantActive is enforced
//     in the service layer, but checking here avoids a pointless registry call
//     and a confusing error per tick.

import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { parseImageReference } from './image-reference.js';
import { resolveTagDigest, digestChanged, extractDigest } from './image-digest.js';
import { getRunningDigest, pullAndRedeploy, setAutoUpdate } from './service.js';
import { loadDecryptedToken } from './pat-store.js';
import { notifyTenantCustomDeploymentRolledBack } from '../notifications/events.js';
import type { CustomDeploymentSpec } from './schema.js';

export interface AutoUpdateLog {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** How long a rolled deployment gets to report Ready before we roll it back. */
const ROLLOUT_TIMEOUT_MS = 5 * 60 * 1000;
const READY_POLL_MS = 10_000;

export interface AutoUpdateDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly log: AutoUpdateLog;
  readonly encryptionKey?: string;
  /** Test seam. */
  readonly now?: () => Date;
  /** Test seam — resolves the registry digest for a tag. */
  readonly resolveDigest?: typeof resolveTagDigest;
  /** Test seam — waits for the workload to become Ready. */
  readonly waitForReady?: (k8s: K8sClients, ns: string, name: string, timeoutMs: number) => Promise<boolean>;
}

/** One pass over every auto-update deployment. Never throws. */
export async function runAutoUpdateOnce(deps: AutoUpdateDeps): Promise<number> {
  const { db, log } = deps;
  const rows = await db.select().from(deployments)
    .where(eq(deployments.source, 'custom'));

  let rolled = 0;
  for (const row of rows) {
    const spec = row.customSpec as unknown as CustomDeploymentSpec | null;
    if (!spec?.autoUpdate) continue;
    // Belt and braces: setAutoUpdate rejects compose, but a spec restored from
    // an older bundle could carry the flag.
    if (spec.sourceMode === 'compose') continue;
    try {
      if (await processOne(deps, row, spec)) rolled += 1;
    } catch (err) {
      log.warn({ err, deploymentId: row.id }, 'auto-update: pass failed for deployment');
    }
  }
  if (rolled > 0) log.info({ rolled }, 'auto-update: rolled deployment(s) onto a new digest');
  return rolled;
}

async function processOne(
  deps: AutoUpdateDeps,
  row: typeof deployments.$inferSelect,
  spec: CustomDeploymentSpec,
): Promise<boolean> {
  const { db, k8s, log } = deps;
  const resolve = deps.resolveDigest ?? resolveTagDigest;

  const [tenant] = await db.select({ status: tenants.status, namespace: tenants.kubernetesNamespace })
    .from(tenants).where(eq(tenants.id, row.tenantId));
  if (!tenant || tenant.status !== 'active') return false;

  const serviceName = Object.keys(spec.services)[0];
  const service = serviceName ? spec.services[serviceName] : undefined;
  if (!service) return false;

  // A digest-pinned reference cannot move by definition — the whole point of
  // pinning. Skip rather than pointlessly querying the registry every hour.
  const parsed = parseImageReference(service.image);
  if (!parsed || !parsed.tag || extractDigest(service.image)) return false;

  const authCreds = await loadAuthCreds(deps, row.id);
  const { digest, reason } = await resolve(parsed, parsed.tag, { authCreds });
  if (!digest) {
    log.warn({ deploymentId: row.id, reason }, 'auto-update: could not resolve registry digest — skipping');
    return false;
  }

  const runningDigest = await getRunningDigest(db, row.id);
  if (!digestChanged(runningDigest, digest)) return false;

  log.info(
    { deploymentId: row.id, image: service.image, from: runningDigest, to: digest },
    'auto-update: tag republished — rolling',
  );

  // Stash the rollback target BEFORE mutating anything, so a crash between
  // here and the roll leaves a recoverable spec.
  await db.update(deployments)
    .set({ customSpec: { ...spec, rollbackDigest: runningDigest ?? undefined } as unknown as Record<string, unknown> })
    .where(eq(deployments.id, row.id));

  await pullAndRedeploy(db, k8s, row.tenantId, row.id, deps.now);

  const wait = deps.waitForReady ?? waitForDeploymentReady;
  const ready = await wait(k8s, tenant.namespace ?? '', row.name, ROLLOUT_TIMEOUT_MS);
  if (ready) {
    // Healthy on the new digest — drop the rollback target so a LATER failure
    // never restores a digest from several updates ago.
    const [fresh] = await db.select().from(deployments).where(eq(deployments.id, row.id));
    const freshSpec = fresh?.customSpec as unknown as CustomDeploymentSpec | undefined;
    if (freshSpec) {
      await db.update(deployments)
        .set({ customSpec: { ...freshSpec, rollbackDigest: undefined } as unknown as Record<string, unknown> })
        .where(eq(deployments.id, row.id));
    }
    return true;
  }

  await rollBack(deps, row, serviceName, runningDigest, digest);
  return false;
}

/**
 * Restore the previous digest and stop auto-updating.
 *
 * Pins `repo@sha256:…` rather than the tag: the tag now resolves to the image
 * that just failed, so re-deploying the tag would reinstate the breakage.
 */
async function rollBack(
  deps: AutoUpdateDeps,
  row: typeof deployments.$inferSelect,
  serviceName: string,
  previousDigest: string | null,
  failedDigest: string,
): Promise<void> {
  const { db, k8s, log } = deps;
  log.warn(
    { deploymentId: row.id, previousDigest, failedDigest },
    'auto-update: new image did not become Ready — rolling back and disabling auto-update',
  );

  const [fresh] = await db.select().from(deployments).where(eq(deployments.id, row.id));
  const spec = fresh?.customSpec as unknown as CustomDeploymentSpec | undefined;
  const service = spec && serviceName ? spec.services[serviceName] : undefined;

  if (spec && service && previousDigest) {
    const parsed = parseImageReference(service.image);
    const repo = parsed ? `${parsed.registryHost === 'docker.io' ? '' : `${parsed.registryHost}/`}${parsed.repository}` : null;
    if (repo) {
      const pinned = `${repo}@${previousDigest}`;
      const restored: CustomDeploymentSpec = {
        ...spec,
        autoUpdate: false,
        rollbackDigest: undefined,
        services: { ...spec.services, [serviceName]: { ...service, image: pinned } },
      };
      await db.update(deployments)
        .set({ customSpec: restored as unknown as Record<string, unknown> })
        .where(eq(deployments.id, row.id));
      try {
        await pullAndRedeploy(db, k8s, row.tenantId, row.id, deps.now);
      } catch (err) {
        log.warn({ err, deploymentId: row.id }, 'auto-update: rollback redeploy failed');
      }
    }
  } else {
    // Nothing safe to roll back TO (the deployment never reported a digest).
    // Still disable auto-update — repeating an update that broke the workload
    // every hour is strictly worse than stopping.
    await setAutoUpdate(db, row.tenantId, row.id, false).catch(() => undefined);
  }

  try {
    await notifyTenantCustomDeploymentRolledBack(db, row.tenantId, {
      deploymentName: row.name,
      failedDigest,
      restoredDigest: previousDigest ?? 'none',
      // Dedupe per deployment per day: a tenant who ignores this does not need
      // it again in an hour, and the situation cannot recur automatically
      // anyway now that auto-update is off.
    }, `custom-deployment-rollback:${row.id}:${(deps.now ?? (() => new Date()))().toISOString().slice(0, 10)}`);
  } catch (err) {
    log.warn({ err, deploymentId: row.id }, 'auto-update: rollback notification failed');
  }
}

async function loadAuthCreds(
  deps: AutoUpdateDeps,
  deploymentId: string,
): Promise<{ username: string; password: string } | undefined> {
  if (!deps.encryptionKey) return undefined;
  try {
    const decrypted = await loadDecryptedToken(deps.db, deploymentId, deps.encryptionKey);
    if (!decrypted) return undefined;
    return { username: decrypted.username, password: decrypted.token };
  } catch {
    return undefined;
  }
}

/** Poll the Deployment until readyReplicas >= 1, or the timeout elapses. */
async function waitForDeploymentReady(
  k8s: K8sClients,
  namespace: string,
  name: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!namespace) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const dep = await k8s.apps.readNamespacedDeployment({ name, namespace } as never) as unknown as {
        status?: { readyReplicas?: number; updatedReplicas?: number };
      };
      // updatedReplicas guards against reading the OLD ReplicaSet as healthy
      // in the window before the rollout starts — the classic false pass.
      if ((dep.status?.readyReplicas ?? 0) >= 1 && (dep.status?.updatedReplicas ?? 0) >= 1) return true;
    } catch {
      // Deployment briefly absent mid-Recreate is normal; keep waiting.
    }
    await new Promise((r) => { const t = setTimeout(r, READY_POLL_MS); t.unref?.(); });
  }
  return false;
}

/**
 * Start the hourly watch. Returns a stop function for onClose.
 * First pass 5 min after boot — later than the other schedulers, because a
 * platform-api that has just started may be racing a cluster still settling,
 * and an auto-update is a mutating action.
 */
export function startAutoUpdateScheduler(
  db: Database,
  k8s: K8sClients,
  log: AutoUpdateLog,
  opts: { intervalMs?: number; encryptionKey?: string } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 3_600_000;
  const runOnce = (): void => {
    runAutoUpdateOnce({ db, k8s, log, encryptionKey: opts.encryptionKey })
      .catch((err: unknown) => log.warn({ err }, 'auto-update: pass failed'));
  };
  const bootKick = setTimeout(runOnce, 300_000);
  bootKick.unref?.();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(bootKick);
    clearInterval(timer);
  };
}
