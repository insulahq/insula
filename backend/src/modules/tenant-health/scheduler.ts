/**
 * Auto-repin tick.
 *
 * Separate from the 5-minute node-health reconciler on purpose: that cadence
 * is tuned for expensive signals (CSI drivers, eviction windows, kubelet disk
 * stats), and during the 2026-09-11 drill it meant a dead node went unnoticed
 * for 4m20s. Recovering a stranded HA-tier tenant should not wait on that.
 *
 * Idempotent by construction — candidates are recomputed from live cluster
 * state every tick and a tenant that is no longer pinned to a dead node
 * simply stops being a candidate, so a missed or failed tick self-heals.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { safeTick } from '../../shared/safe-tick.js';
import { collectFacts } from './collect.js';
import { applyAutoRepin, autoRepinDisabled, selectAutoRepinCandidates } from './auto-repin.js';

/** 60s: fast enough to matter, slow enough not to add load during an outage. */
export const AUTO_REPIN_TICK_MS = 60_000;
/** Past startup migrations, matching the other reconcilers. */
const INITIAL_DELAY_MS = 90_000;

export interface AutoRepinDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tickMs?: number;
  readonly logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export async function runAutoRepinTick(deps: AutoRepinDeps): Promise<void> {
  const log = deps.logger ?? console;
  if (autoRepinDisabled()) return;

  const facts = await collectFacts(deps.db, deps.k8s);
  // A partial cluster read must not drive placement changes: acting on an
  // incomplete replica list could unpin a tenant whose surviving replica we
  // simply failed to see.
  if (facts.readError) {
    log.warn('[auto-repin] skipping tick — incomplete cluster read:', facts.readError);
    return;
  }

  const candidates = selectAutoRepinCandidates(facts);
  if (candidates.length === 0) return;

  log.info(`[auto-repin] ${candidates.length} HA-tier tenant(s) stranded on an offline node`);
  const result = await applyAutoRepin(deps.db, deps.k8s, candidates, log);
  if (result.failed.length > 0) {
    log.warn(`[auto-repin] ${result.failed.length} re-pin(s) failed; will retry next tick`, result.failed);
  }
}

export function startAutoRepinScheduler(deps: AutoRepinDeps): () => void {
  const tickMs = deps.tickMs ?? AUTO_REPIN_TICK_MS;
  let timer: NodeJS.Timeout | null = null;
  const initial = setTimeout(() => {
    void safeTick('tenant-auto-repin', () => runAutoRepinTick(deps));
    timer = setInterval(() => void safeTick('tenant-auto-repin', () => runAutoRepinTick(deps)), tickMs);
  }, INITIAL_DELAY_MS);

  return () => {
    clearTimeout(initial);
    if (timer) clearInterval(timer);
  };
}
