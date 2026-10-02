/**
 * Mail DR watcher — monitors active node health and triggers auto-failover.
 *
 * Runs every DEFAULT_TICK_MS. Each tick:
 *   1. Reads mailAutoFailoverEnabled from system_settings — exits immediately if false.
 *   2. Checks whether the active node's k8s Node object has Ready=True.
 *   3. If node is NotReady:
 *      - Transitions drState: healthy → degraded (records degradedSince).
 *      - If degraded for >= failoverThresholdSeconds: triggers restore-based
 *        auto-failover to secondary/tertiary node.
 *   4. If node recovers while in degraded state: resets drState → healthy.
 *
 * For node-loss DR the source PVC is inaccessible, so we use
 * `triggerRestoreBasedFailover` (empty PVC + allow-restore annotation) rather
 * than the full rsync migration pipeline.
 *
 * Follows the exact pattern of backup-health/scheduler.ts.
 */

import { eq, sql } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerRestoreBasedFailover } from './migration.js';
import { resolveActiveMailNode } from './active-node.js';
import { withDbRetry } from '../../shared/db-retry.js';
import { safeTick } from '../../shared/safe-tick.js';

const SETTINGS_ID = 'system';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;

export interface DrWatcherDeps {
  readonly db: Database;
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  /**
   * Batch tenant — required since Phase 1 streamline
   * because the restore-based failover polls the snapshot CronJob's
   * `status.lastSuccessfulTime` to wait for fresh snapshots before
   * scaling Stalwart down.
   */
  readonly batch: BatchV1Api;
  readonly kubeconfigPath?: string;
  readonly tickMs?: number;
  readonly logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

/** Default tick: 30s — fast enough to detect node loss within a minute. */
export const DR_WATCHER_TICK_MS = 30_000;

/**
 * Start the DR watcher. Returns a stop function compatible with
 * `app.addHook('onClose', () => stop())`.
 */
export function startDrWatcher(deps: DrWatcherDeps): () => void {
  const tickMs = deps.tickMs ?? DR_WATCHER_TICK_MS;

  // Run one tick immediately on start to catch a degraded state that
  // persisted across a platform-api restart.
  safeTick('mail-dr-watcher', () => runDrWatcherTick(deps));

  const timer = setInterval(() => safeTick('mail-dr-watcher', () => runDrWatcherTick(deps)), tickMs);
  return () => clearInterval(timer);
}

/**
 * One tick of the DR watcher. Exported for unit-testability.
 */
export async function runDrWatcherTick(deps: DrWatcherDeps): Promise<void> {
  const { db, core, apps, batch, kubeconfigPath } = deps;
  const log = deps.logger ?? {
    warn: (...args: unknown[]) => console.warn('[dr-watcher]', ...args),
    info: (...args: unknown[]) => console.info('[dr-watcher]', ...args),
  };

  try {
    const [settings] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
    if (!settings) return;
    // Only act in stable states — if already failing-over or failed-over,
    // leave the state machine alone. Except a failover whose state machine is
    // GONE: its run ended (or was reaped) without the watcher's own state ever
    // leaving 'failing-over', and nothing else ever moves it — auto-failover
    // stayed dead until someone edited the database. Released even with
    // auto-failover switched OFF (an operator taking manual control mid-incident
    // must not freeze the state): releasing starts nothing by itself.
    const drState = settings.mailDrState ?? 'healthy';
    if (drState === 'failing-over') {
      await releaseAbandonedFailover(db, log);
      return;
    }
    if (!settings.mailAutoFailoverEnabled) return;
    if (drState !== 'healthy' && drState !== 'degraded') return;

    // Where mail IS (live pod → its volume → the stored column), recorded when
    // settled: after a failover the run never finished, the column still named
    // the dead source while Stalwart served from the standby.
    const { node: activeNode } = await resolveActiveMailNode(db, core, {
      persist: true,
      stored: settings.mailActiveNode ?? null,
      logger: { warn: (msg: string) => log.warn(msg) },
    });
    if (!activeNode) return;

    const nodeReady = await isNodeReady(core, activeNode);

    if (!nodeReady) {
      const thresholdSec = settings.mailFailoverThresholdSeconds ?? 300;

      if (drState === 'healthy') {
        // First detection — transition to degraded and record the time.
        // CAS guard: only this replica's UPDATE will see drState=healthy;
        // any concurrent replica's UPDATE filters zero rows and skips
        // the log message. Prevents spurious "entering degraded state"
        // warnings firing from each of the 3 HA platform-api replicas.
        const cas = await db.execute(sql`
          UPDATE system_settings
          SET mail_dr_state = 'degraded',
              mail_last_failover_at = now()
          WHERE id = ${SETTINGS_ID} AND mail_dr_state = 'healthy'
          RETURNING id
        `) as { rows?: unknown[] };
        if ((cas.rows ?? []).length > 0) {
          log.warn(
            `Active mail node ${activeNode} is NotReady — entering degraded state (threshold ${thresholdSec}s)`,
          );
        }
        return;
      }

      // Already degraded — check how long.
      const degradedSince = settings.mailLastFailoverAt
        ? (Date.now() - settings.mailLastFailoverAt.getTime()) / 1000
        : thresholdSec + 1; // treat unknown as exceeded

      if (degradedSince < thresholdSec) {
        log.info(
          `Node ${activeNode} still degraded — ${Math.round(degradedSince)}s / ${thresholdSec}s threshold`,
        );
        return;
      }

      // Threshold exceeded — pick failover target. Walk the priority
      // list (secondary then tertiary) skipping nodes that don't exist
      // or aren't Ready. Both server-role and worker-role are valid
      // mail placements (see affinity-patch-mail-stack.yaml). Earlier
      // server-role gating was reverted — the mail-stack
      // affinity now spans both roles, so failover to a worker is fine.
      const candidates = [settings.mailSecondaryNode, settings.mailTertiaryNode]
        .filter((n): n is string => !!n && n !== activeNode);
      let targetNode: string | null = null;
      const skipped: string[] = [];
      for (const c of candidates) {
        try {
          const n = await core.readNode({ name: c } as unknown as Parameters<typeof core.readNode>[0]) as { status?: { conditions?: Array<{ type: string; status: string }> } };
          const ready = (n.status?.conditions ?? []).find((x) => x.type === 'Ready');
          if (ready?.status !== 'True') {
            skipped.push(`${c}(NotReady)`);
            continue;
          }
          targetNode = c;
          break;
        } catch {
          // Node not found / API error — try the next candidate
          skipped.push(`${c}(unreadable)`);
        }
      }
      if (!targetNode) {
        const detail = skipped.length ? ` (skipped: ${skipped.join(', ')})` : '';
        log.warn(`No viable secondary/tertiary node for auto-failover${detail}. Set a Ready node in placement.`);
        return;
      }

      // CAS-guarded transition degraded → failing-over. With 3 HA
      // platform-api replicas all ticking dr-watcher every 30s,
      // multiple replicas can pass the read above with state=degraded
      // and race to write 'failing-over'. Only the replica whose
      // UPDATE...WHERE state='degraded' affects a row should call
      // triggerRestoreBasedFailover. The others see zero rows and
      // skip — preventing duplicate mail_migration_runs INSERTs +
      // competing PVC deletes.
      const claimRow = await db.execute(sql`
        UPDATE system_settings
        SET mail_dr_state = 'failing-over'
        WHERE id = ${SETTINGS_ID} AND mail_dr_state = 'degraded'
        RETURNING id
      `) as { rows?: unknown[] };
      if ((claimRow.rows ?? []).length === 0) {
        log.info(
          `Auto-failover already claimed by another replica — skipping this tick`,
        );
        return;
      }

      log.warn(
        `Node ${activeNode} degraded for ${Math.round(degradedSince)}s >= threshold ${thresholdSec}s — ` +
        `triggering auto-failover to ${targetNode}`,
      );

      try {
        await triggerRestoreBasedFailover(targetNode, { db, core, apps, batch, kubeconfigPath });
        log.warn(`Auto-failover to ${targetNode} complete — state set to failed-over`);
      } catch (err) {
        log.warn('Auto-failover failed — resetting to degraded for next tick retry:', err);
        // Retried across a short DB outage (the dead node may have held the
        // primary). If it is still lost, releaseAbandonedFailover is the backstop.
        await withDbRetry(() => db.update(systemSettings)
          .set({ mailDrState: 'degraded' })
          .where(eq(systemSettings.id, SETTINGS_ID)))
          .catch(() => { /* still down — releaseAbandonedFailover picks it up */ });
      }
    } else if (drState === 'degraded') {
      // Node recovered from degraded state before threshold — reset to healthy.
      await db.update(systemSettings)
        .set({ mailDrState: 'healthy' })
        .where(eq(systemSettings.id, SETTINGS_ID));
      log.info(`Active mail node ${activeNode} recovered — drState reset to healthy`);
    }
  } catch (err) {
    // Never let a tick crash the interval — log and wait for next cycle.
    const log2 = deps.logger ?? { warn: console.warn, info: console.info };
    log2.warn('DR watcher tick error:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A run that ended this recently may still be stamping the outcome itself —
 * through up to two retried writes (withDbRetry, ~2 min each) after the run row
 * reached 'done'. 5 min outlasts that; the release is a backstop, not a race.
 */
const ABANDONED_FAILOVER_GRACE_SECONDS = 300;

/**
 * 'failing-over' with no mail migration in flight and the last run ended over a
 * minute ago: the state machine that owned the transition is gone (its process
 * died, or its outcome writes were lost to a DB outage and the run was reaped).
 * Hand the decision back to the watcher — 'degraded' keeps the original
 * detection time, so the next tick either retries at once (node still down) or
 * returns to healthy (node back, or mail already running elsewhere).
 */
async function releaseAbandonedFailover(
  db: Database,
  log: { warn: (...args: unknown[]) => void },
): Promise<void> {
  const res = await db.execute(sql`
    UPDATE system_settings
    SET mail_dr_state = 'degraded'
    WHERE id = ${SETTINGS_ID} AND mail_dr_state = 'failing-over'
      AND NOT EXISTS (
        SELECT 1 FROM mail_migration_runs
         WHERE state NOT IN ('done', 'failed', 'rolled-back', 'cancelled')
            OR finished_at > now() - make_interval(secs => ${ABANDONED_FAILOVER_GRACE_SECONDS})
      )
    RETURNING id
  `) as { rows?: unknown[] };
  if ((res.rows ?? []).length > 0) {
    log.warn('DR state was stuck at failing-over with no failover running — released to degraded so the watcher decides again');
  }
}

async function isNodeReady(core: CoreV1Api, nodeName: string): Promise<boolean> {
  try {
    const node = await core.readNode({ name: nodeName }) as {
      status?: { conditions?: Array<{ type: string; status: string }> };
    };
    const conditions = node.status?.conditions ?? [];
    const readyCond = conditions.find((c) => c.type === 'Ready');
    return readyCond?.status === 'True';
  } catch {
    // Node not found or API unreachable — treat as not ready.
    return false;
  }
}
