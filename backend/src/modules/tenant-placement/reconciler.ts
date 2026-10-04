/**
 * Tenant placement reconciler — every minute, on every replica.
 *
 * One cluster read for the whole fleet (tenant-health/collect.ts, shared with
 * the outage view and HA auto-repin), then:
 *   1. record Longhorn salvages of tenant volumes not seen before, and notify
 *      them — once per pass, listing every tenant (a node-wide storage stall
 *      salvages many volumes at once);
 *   2. persist each tenant's placement (placed / misplaced / unpinned);
 *   3. notify tenants that have stayed off their primary node for
 *      MISPLACED_NOTIFY_AFTER_MS, once per misplacement episode;
 *   4. start the one-shot pin repair, if it has not run on this cluster.
 *
 * Read-only towards the cluster except for step 4. Never moves a tenant.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { finishDataRelocations } from './relocate.js';
import { tenants } from '../../db/schema.js';
import { safeTick } from '../../shared/safe-tick.js';
import { collectFacts, type CollectedFacts } from '../tenant-health/collect.js';
import { notifyAdminTenantMisplaced, notifyAdminTenantStorageFailover } from '../notifications/events.js';
import { computePlacements, observeStorageFailovers, type TenantPlacementObservation } from './compute.js';
import { failoverMessage, misplacedMessage, type NamedFailover, type NamedPlacement } from './messages.js';
import {
  claimMisplacedNotifications, loadPlacementStates, recordStorageFailovers, savePlacementStates,
} from './store.js';
import {
  claimPinRepair, pinRepairDisabled, runPinRepair, selectRepairCandidates,
} from './pin-repair.js';

export const PLACEMENT_TICK_MS = 60_000;
/** Past startup migrations, matching the other reconcilers. */
const INITIAL_DELAY_MS = 120_000;
/**
 * How long a tenant must stay misplaced before anyone is told. A data-locality
 * rebuild, an operator migration or a pod restarting on its own node all look
 * misplaced for a few minutes and must not page.
 */
export const MISPLACED_NOTIFY_AFTER_MS = 10 * 60_000;
/**
 * A salvage older than this when first seen is recorded but not announced —
 * the first run on a cluster finds every salvage Longhorn still remembers,
 * and an alarm about last month is noise.
 */
export const FAILOVER_NOTIFY_WINDOW_MS = 6 * 60 * 60_000;

export interface PlacementDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  readonly now?: () => Date;
  /** Test seam; defaults to the shared fleet read. */
  readonly collect?: (db: Database, k8s: K8sClients) => Promise<CollectedFacts>;
  /** Test seam: await the pin repair instead of letting it run in the background. */
  readonly awaitRepair?: boolean;
}

export interface PlacementTickResult {
  readonly placements: readonly TenantPlacementObservation[];
  readonly newFailovers: number;
  readonly failoversNotified: number;
  readonly misplacedNotified: number;
  readonly repairStarted: boolean;
  readonly relocationsReleased: number;
}

let repairRunning = false;

/** The Longhorn volume read succeeded — salvages can be trusted even if another read failed. */
function volumesReadOk(facts: CollectedFacts): boolean {
  return !facts.readError || !facts.readError.includes('longhorn volumes');
}

export async function runPlacementTick(deps: PlacementDeps): Promise<PlacementTickResult> {
  const log = deps.logger ?? console;
  const now = (deps.now ?? (() => new Date()))();
  const facts = await (deps.collect ?? collectFacts)(deps.db, deps.k8s);
  const placements = computePlacements(facts);
  const byTenant = new Map(placements.map((p) => [p.tenantId, p]));
  const before = await loadPlacementStates(deps.db);

  // 1. Storage failovers.
  const observed = volumesReadOk(facts) ? observeStorageFailovers(facts) : [];
  const inserted = await recordStorageFailovers(deps.db, observed, before, byTenant);
  const fresh: NamedFailover[] = inserted
    .filter((f) => now.getTime() - f.remountRequestedAt.getTime() <= FAILOVER_NOTIFY_WINDOW_MS)
    .map((f) => ({
      ...f,
      tenantName: byTenant.get(f.tenantId)?.tenantName ?? f.tenantId,
      primaryNode: byTenant.get(f.tenantId)?.primaryNode ?? null,
    }));
  if (inserted.length > 0) {
    log.warn(`[tenant-placement] ${inserted.length} new storage failover(s) recorded`
      + (fresh.length < inserted.length ? ` (${inserted.length - fresh.length} too old to announce)` : ''));
  }
  if (fresh.length > 0) {
    const tenantIds = [...new Set(fresh.map((f) => f.tenantId))];
    await notifyAdminTenantStorageFailover(
      deps.db,
      failoverMessage(fresh),
      tenantIds.length === 1 ? tenantIds[0] : undefined,
      `storage-failover:${fresh.map((f) => f.id).sort().join(',')}`,
    );
  }

  // 2. Placement state.
  await savePlacementStates(deps.db, placements, now);

  // 3. Misplacement notifications.
  const claimed = await claimMisplacedNotifications(deps.db, now, MISPLACED_NOTIFY_AFTER_MS);
  if (claimed.length > 0) {
    const named: NamedPlacement[] = claimed.map((p) => ({ ...p, tenantName: byTenant.get(p.tenantId)?.tenantName ?? p.tenantId }));
    await notifyAdminTenantMisplaced(
      deps.db,
      misplacedMessage(named),
      claimed.length === 1 ? claimed[0]!.tenantId : undefined,
      `tenant-misplaced:${claimed.map((p) => `${p.tenantId}@${p.misplacedSince?.toISOString() ?? ''}`).sort().join(',')}`,
    );
  }

  // 4. One-shot pin repair, only from a complete read.
  const repairStarted = facts.readError ? false : await maybeStartPinRepair(deps, placements, now);

  // 5. Release data relocations whose copy is done (or out of time). Judged
  //    from this tick's replica read — never from a failed one.
  const relocationsReleased = facts.readError?.includes('longhorn')
    ? 0
    : await finishDataRelocations(deps.k8s, facts.replicas, now)
      .then((released) => {
        for (const r of released) {
          const line = `[tenant-placement] relocation of ${r.volumeName} to ${r.node} released`;
          if (r.verdict === 'done') log.info(`${line}: data now local`);
          else log.warn(`${line}: gave up after the time limit, data left where it is`);
        }
        return released.length;
      })
      .catch((err: unknown) => {
        log.warn('[tenant-placement] could not check data relocations:', err);
        return 0;
      });

  return {
    placements,
    newFailovers: inserted.length,
    failoversNotified: fresh.length,
    misplacedNotified: claimed.length,
    repairStarted,
    relocationsReleased,
  };
}

async function maybeStartPinRepair(
  deps: PlacementDeps,
  placements: readonly TenantPlacementObservation[],
  now: Date,
): Promise<boolean> {
  if (pinRepairDisabled() || repairRunning) return false;
  if (!(await claimPinRepair(deps.db, now))) return false;

  const rows = await deps.db
    .select({ id: tenants.id, ns: tenants.kubernetesNamespace, storage: tenants.storageLifecycleState })
    .from(tenants);
  const namespaces = new Map(rows.filter((r) => r.ns).map((r) => [r.id, r.ns as string]));
  const idle = new Set(rows.filter((r) => r.storage === 'idle').map((r) => r.id));
  const { candidates, skipped } = selectRepairCandidates(placements, namespaces, idle);

  const log = deps.logger ?? console;
  log.info(`[pin-repair] starting: ${candidates.length} tenant(s) to check, ${skipped.length} skipped`);
  repairRunning = true;
  const run = runPinRepair({ db: deps.db, k8s: deps.k8s, logger: log }, candidates, skipped)
    .catch((err) => { log.warn('[pin-repair] aborted:', err); })
    .finally(() => { repairRunning = false; });
  if (deps.awaitRepair) await run;
  return true;
}

export function startPlacementReconciler(deps: PlacementDeps): () => void {
  let timer: NodeJS.Timeout | null = null;
  const tick = () => void safeTick('tenant-placement', async () => { await runPlacementTick(deps); });
  const initial = setTimeout(() => {
    tick();
    timer = setInterval(tick, PLACEMENT_TICK_MS);
  }, INITIAL_DELAY_MS);
  return () => {
    clearTimeout(initial);
    if (timer) clearInterval(timer);
  };
}
