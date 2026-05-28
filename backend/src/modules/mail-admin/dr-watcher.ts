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

const SETTINGS_ID = 'system';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;

export interface DrWatcherDeps {
  readonly db: Database;
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  /**
   * Batch tenant — required since Phase 1 streamline (2026-05-15)
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
  void runDrWatcherTick(deps);

  const timer = setInterval(() => void runDrWatcherTick(deps), tickMs);
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
    if (!settings.mailAutoFailoverEnabled) return;
    if (!settings.mailActiveNode) return;

    // Only act in stable states — if already failing-over or failed-over,
    // leave the state machine alone.
    const drState = settings.mailDrState ?? 'healthy';
    if (drState !== 'healthy' && drState !== 'degraded') return;

    const nodeReady = await isNodeReady(core, settings.mailActiveNode);

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
            `Active mail node ${settings.mailActiveNode} is NotReady — entering degraded state (threshold ${thresholdSec}s)`,
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
          `Node ${settings.mailActiveNode} still degraded — ${Math.round(degradedSince)}s / ${thresholdSec}s threshold`,
        );
        return;
      }

      // Threshold exceeded — pick failover target. Walk the priority
      // list (secondary then tertiary) skipping non-server-role nodes,
      // since the mail-stack requires server-role per the
      // system-node-affinity Kustomize component (Bulwark has a hard
      // affinity to node-role=server). Picking a worker node here would
      // cause the migration's preflight to fail-fast and leave the
      // cluster in `degraded` state on the next dr-watcher tick — caught
      // 2026-05-28 by Phase H of the mobility E2E when the operator had
      // mistakenly set secondary=worker.
      const candidates = [settings.mailSecondaryNode, settings.mailTertiaryNode].filter((n): n is string => !!n);
      let targetNode: string | null = null;
      const skippedNonServer: string[] = [];
      for (const c of candidates) {
        try {
          const n = await core.readNode({ name: c } as unknown as Parameters<typeof core.readNode>[0]) as { metadata?: { labels?: Record<string, string> } };
          const role = n.metadata?.labels?.['platform.phoenix-host.net/node-role'];
          if (role && role !== 'server') {
            skippedNonServer.push(`${c}(role=${role})`);
            continue;
          }
          targetNode = c;
          break;
        } catch {
          // Node not found / API error — try the next candidate
          skippedNonServer.push(`${c}(unreadable)`);
        }
      }
      if (!targetNode) {
        const detail = skippedNonServer.length ? ` (skipped: ${skippedNonServer.join(', ')})` : '';
        log.warn(`No viable secondary/tertiary node for auto-failover${detail}. Set a server-role node in placement.`);
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
        `Node ${settings.mailActiveNode} degraded for ${Math.round(degradedSince)}s >= threshold ${thresholdSec}s — ` +
        `triggering auto-failover to ${targetNode}`,
      );

      try {
        await triggerRestoreBasedFailover(targetNode, { db, core, apps, batch, kubeconfigPath });
        log.warn(`Auto-failover to ${targetNode} complete — state set to failed-over`);
      } catch (err) {
        log.warn('Auto-failover failed — resetting to degraded for next tick retry:', err);
        await db.update(systemSettings)
          .set({ mailDrState: 'degraded' })
          .where(eq(systemSettings.id, SETTINGS_ID))
          .catch(() => { /* best-effort */ });
      }
    } else if (drState === 'degraded') {
      // Node recovered from degraded state before threshold — reset to healthy.
      await db.update(systemSettings)
        .set({ mailDrState: 'healthy' })
        .where(eq(systemSettings.id, SETTINGS_ID));
      log.info(`Active mail node ${settings.mailActiveNode} recovered — drState reset to healthy`);
    }
  } catch (err) {
    // Never let a tick crash the interval — log and wait for next cycle.
    const log2 = deps.logger ?? { warn: console.warn, info: console.info };
    log2.warn('DR watcher tick error:', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
