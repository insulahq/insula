/**
 * Evaluator scheduler (ADR-051 phase 3).
 *
 * 60s tick / 90s initial delay. HA dedup via a conditional UPDATE on
 * the single-row monitoring_evaluator_lease — the exact
 * backup_schedules.last_fired_at pattern: all three platform-api
 * replicas tick, exactly one wins the minute's claim and evaluates.
 * No claim rollback on evaluation error: a failed evaluation already
 * consumed the minute (re-running the same minute from another replica
 * would double-notify on transient DB errors); the next minute retries
 * naturally.
 *
 * With `k8s` the evaluator also holds back alerts about a node that is still
 * joining (node-health/join-grace.ts) — the same 30-minute window the node
 * health detectors use, so a bootstrapping node's CPU or a not-yet-scraped
 * kubelet does not page while the operator watches the join.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { lazyJoinGrace } from '../node-health/join-grace.js';
import { evaluateOnce, type EvaluatorLogger } from './evaluator.js';

export const EVALUATOR_TICK_MS = 60_000;
const INITIAL_DELAY_MS = 90_000;

/** Truncate to the minute so every replica computes the same claim key. */
function minuteFloor(d: Date): Date {
  const t = new Date(d);
  t.setSeconds(0, 0);
  return t;
}

export function startMonitoringEvaluator(
  db: Database,
  log: EvaluatorLogger,
  opts: { tickMs?: number; initialDelayMs?: number; k8s?: Pick<K8sClients, 'core' | 'custom'> } = {},
): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tickMs = opts.tickMs ?? EVALUATOR_TICK_MS;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const minute = minuteFloor(new Date());
      // Conditional claim — exactly one replica per minute.
      const claimed = await db.execute(sql`
        UPDATE monitoring_evaluator_lease
        SET last_run_at = ${minute}
        WHERE id = 'evaluator'
          AND (last_run_at IS NULL OR last_run_at < ${minute})
        RETURNING id
      `);
      const rows = (claimed as unknown as { rows?: unknown[] }).rows ?? [];
      if (rows.length > 0) {
        const now = new Date();
        await evaluateOnce(db, log, {}, now, {
          joinGrace: opts.k8s ? lazyJoinGrace(opts.k8s, now) : undefined,
        });
      }
    } catch (err) {
      log.warn('monitoring evaluator tick failed:', err instanceof Error ? err.message : String(err));
    }
    if (!stopped) timer = setTimeout(tick, tickMs);
  };

  timer = setTimeout(tick, opts.initialDelayMs ?? INITIAL_DELAY_MS);
  log.info(`monitoring evaluator started (tick ${tickMs}ms, lease-deduped)`);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
