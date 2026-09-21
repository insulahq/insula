/**
 * Per-tenant resource-saturation alerting, as episodes.
 *
 * Low-footprint by design (the operator's cardinality choice): this evaluates
 * per-tenant CPU/memory/storage usage-vs-limit and fires notifications to BOTH
 * the operator and the tenant — it publishes NO per-tenant time-series into
 * vmsingle. It runs off the metrics the hourly metrics-scheduler ALREADY
 * collects (metrics-server + file-manager du), so it adds no extra
 * metrics-server load and no storage.
 *
 * What changed (migration 0133)
 * -----------------------------
 * This used to dedupe on a key containing the current hour. The scheduler
 * ticks hourly, so every cycle produced a key that had never been seen and
 * nothing was ever deduplicated: a tenant at 94% of its storage mailed its
 * operator and its owner every hour, forever, and going back under the
 * threshold sent nothing at all.
 *
 * Now `tenant_saturation_events` holds one open episode per (tenant,
 * resource). The episode opens once, re-announces on a 1h/6h/daily ladder
 * while it persists, announces level changes immediately, and ends with an
 * explicit all-clear.
 *
 * HA: the metrics scheduler runs on EVERY api replica with no lease. The old
 * hour bucket was what accidentally kept replicas from double-sending. Each
 * state change here is ONE guarded statement that re-checks the state the
 * decision was made from, so exactly one replica's claim returns a row and
 * the losers stay quiet.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { ResourceMetrics } from './resource-metrics.js';
import {
  SATURATION_WARN,
  SATURATION_CRITICAL,
  STORAGE_SATURATION_CRITICAL,
  decideEpisodeAction,
  durationText,
  levelWithHysteresis,
  reminderDelayMs,
  saturationLevel,
  type EpisodeAction,
  type SaturationLevel,
} from './saturation-policy.js';

export {
  SATURATION_WARN,
  SATURATION_CRITICAL,
  STORAGE_SATURATION_CRITICAL,
  saturationLevel,
};

interface SatLogger { warn?(...args: unknown[]): void }

interface Dimension {
  readonly resource: 'CPU' | 'memory' | 'storage';
  readonly unit: string;
  readonly inUse: number;
  readonly available: number;
  readonly crit: number;
}

interface EpisodeRow extends Record<string, unknown> {
  level: string;
  used_pct: number;
  first_seen_at: string | Date;
  last_notified_at: string | Date | null;
  notify_count: number;
}

function asDate(v: string | Date | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Number of notifications produced, for logging. `fired` counts episodes that
 * SAID something this cycle — an open, an escalation, a reminder or an
 * all-clear — not tenants over a threshold.
 */
export interface SaturationCycleResult {
  readonly fired: number;
  readonly resolved: number;
}

/**
 * Evaluate one tenant's freshly-collected metrics and drive its saturation
 * episodes. Never throws (per-dimension try/catch).
 */
export async function evaluateTenantSaturation(
  db: Database,
  tenantId: string,
  tenantLabel: string,
  metrics: ResourceMetrics,
  logger?: SatLogger,
  now: Date = new Date(),
): Promise<number> {
  const dims: readonly Dimension[] = [
    { resource: 'CPU', unit: ' cores', inUse: metrics.cpu.inUse, available: metrics.cpu.available, crit: SATURATION_CRITICAL },
    { resource: 'memory', unit: ' GiB', inUse: metrics.memory.inUse, available: metrics.memory.available, crit: SATURATION_CRITICAL },
    { resource: 'storage', unit: ' GiB', inUse: metrics.storage.inUse, available: metrics.storage.available, crit: STORAGE_SATURATION_CRITICAL },
  ];

  const events = await import('../notifications/events.js');
  let fired = 0;

  for (const d of dims) {
    try {
      // An unlimited / unknown limit cannot saturate. It can, however, have an
      // episode already open from when a limit DID exist — resolve that rather
      // than abandoning it, or the tenant keeps an open episode forever and
      // never gets the all-clear.
      const prev = await readOpenEpisode(db, tenantId, d.resource);
      const ratio = d.available > 0 ? d.inUse / d.available : NaN;
      const prevLevel = (prev?.level as SaturationLevel | undefined) ?? null;
      const notifyCount = prev?.notify_count ?? 1;
      const newLevel = d.available > 0
        ? levelWithHysteresis(ratio, prevLevel, SATURATION_WARN, d.crit)
        : null;

      const action = decideEpisodeAction({
        newLevel,
        prevLevel,
        lastNotifiedAt: prev ? asDate(prev.last_notified_at) : null,
        notifyCount,
        now,
      });
      if (action === 'none') continue;

      const usedPct = Number.isFinite(ratio) ? Math.round(ratio * 100) : (prev?.used_pct ?? 0);
      const claimed = await claimEpisode(db, {
        tenantId,
        resource: d.resource,
        action,
        newLevel,
        prevLevel,
        usedPct,
        reminderAfterMs: reminderDelayMs(notifyCount),
      });
      // Lost the race to another replica, or the row moved under us.
      if (!claimed) continue;

      // A resolve can be caused by the LIMIT going away (plan change, override
      // cleared), not by usage dropping. Rendering "of its 0 GiB limit" in that
      // email would be worse than saying nothing, so the limit reports what it
      // actually is.
      const limitText = d.available > 0 ? String(d.available) : 'unlimited';
      const common = {
        resource: d.resource,
        usedPct: String(usedPct),
        used: String(Math.round(d.inUse * 100) / 100),
        limit: limitText,
        unit: d.available > 0 ? d.unit : '',
      };
      // Only the tenant-facing templates render a timestamp. Shipping one to
      // the admin templates too would be a payload key no template reads —
      // a fact fetched and then silently discarded.
      const tenantCommon = {
        ...common,
        occurredAt: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
      };
      // Episode identity, not a time bucket: unique per intended send, so a
      // retry is idempotent while a genuinely NEW announcement always lands.
      // The episode start is in the key because notify_count restarts at 1 on
      // every new episode, and a bare count would collide with the previous
      // episode's opening alert inside the dispatcher's 30-day window.
      const epoch = new Date(claimed.first_seen_at).toISOString().slice(0, 19);
      const keyBase = `${tenantId}:${d.resource}:${epoch}`;

      if (action === 'resolve') {
        const lasted = durationText(new Date(claimed.first_seen_at).getTime(), now.getTime());
        await events.notifyTenantResourceRecovered(
          db,
          tenantId,
          { ...tenantCommon, durationText: lasted },
          `sat-tenant-ok:${keyBase}`,
        );
        await events.notifyAdminTenantResourceRecovered(
          db,
          tenantId,
          { ...common, tenantLabel, durationText: lasted },
          `sat-ok:${keyBase}`,
        );
      } else {
        const level = newLevel as SaturationLevel;
        const n = claimed.notify_count;
        await events.notifyTenantResourceSaturation(
          db,
          tenantId,
          level,
          tenantCommon,
          `sat-tenant:${keyBase}:${level}:${n}`,
        );
        await events.notifyAdminTenantResourceSaturation(
          db,
          tenantId,
          level,
          { tenantLabel, ...common },
          `sat:${keyBase}:${level}:${n}`,
        );
      }
      fired += 1;
    } catch (err) {
      logger?.warn?.({ err, tenantId, resource: d.resource }, 'tenant-saturation: notification failed');
    }
  }
  return fired;
}

async function readOpenEpisode(
  db: Database,
  tenantId: string,
  resource: string,
): Promise<EpisodeRow | null> {
  const res = await db.execute<EpisodeRow>(sql`
    SELECT level, used_pct, first_seen_at, last_notified_at, notify_count
      FROM tenant_saturation_events
     WHERE tenant_id = ${tenantId}
       AND resource = ${resource}
       AND cleared_at IS NULL
  `);
  return (res.rows ?? [])[0] ?? null;
}

interface ClaimInput {
  readonly tenantId: string;
  readonly resource: string;
  readonly action: EpisodeAction;
  readonly newLevel: SaturationLevel | null;
  readonly prevLevel: SaturationLevel | null;
  readonly usedPct: number;
  readonly reminderAfterMs: number;
}

interface ClaimedRow extends Record<string, unknown> {
  first_seen_at: string | Date;
  notify_count: number;
}

/**
 * Take the episode transition, or return null because somebody else did.
 *
 * Every branch is a single statement whose WHERE re-states the precondition
 * the caller decided from, so two replicas evaluating the same tenant in the
 * same second produce exactly one notification.
 */
async function claimEpisode(db: Database, i: ClaimInput): Promise<ClaimedRow | null> {
  const { tenantId, resource, usedPct } = i;
  let res: { rows?: ClaimedRow[] };

  switch (i.action) {
    case 'open':
      // ON CONFLICT re-arms a previously cleared row. The WHERE makes a
      // still-open episode a no-op, which is exactly the losing replica.
      res = await db.execute<ClaimedRow>(sql`
        INSERT INTO tenant_saturation_events
          (tenant_id, resource, level, used_pct, first_seen_at, last_notified_at, notify_count)
        VALUES (${tenantId}, ${resource}, ${i.newLevel}, ${usedPct}, NOW(), NOW(), 1)
        ON CONFLICT (tenant_id, resource) DO UPDATE
           SET level = EXCLUDED.level,
               used_pct = EXCLUDED.used_pct,
               first_seen_at = NOW(),
               last_notified_at = NOW(),
               notify_count = 1,
               cleared_at = NULL
         WHERE tenant_saturation_events.cleared_at IS NOT NULL
        RETURNING first_seen_at, notify_count
      `);
      break;

    case 'escalate':
      // Guarded on the level we read: the first replica to flip it wins, and
      // the ladder restarts because a level change is a new thing to say.
      res = await db.execute<ClaimedRow>(sql`
        UPDATE tenant_saturation_events
           SET level = ${i.newLevel},
               used_pct = ${usedPct},
               last_notified_at = NOW(),
               notify_count = 1
         WHERE tenant_id = ${tenantId}
           AND resource = ${resource}
           AND cleared_at IS NULL
           AND level = ${i.prevLevel}
        RETURNING first_seen_at, notify_count
      `);
      break;

    case 'remind':
      // The age guard is the interlock: once one replica stamps
      // last_notified_at, the other's identical UPDATE matches nothing.
      res = await db.execute<ClaimedRow>(sql`
        UPDATE tenant_saturation_events
           SET used_pct = ${usedPct},
               last_notified_at = NOW(),
               notify_count = notify_count + 1
         WHERE tenant_id = ${tenantId}
           AND resource = ${resource}
           AND cleared_at IS NULL
           AND level = ${i.prevLevel}
           AND last_notified_at <= NOW() - make_interval(secs => ${i.reminderAfterMs / 1000})
        RETURNING first_seen_at, notify_count
      `);
      break;

    case 'resolve':
      res = await db.execute<ClaimedRow>(sql`
        UPDATE tenant_saturation_events
           SET cleared_at = NOW(),
               used_pct = ${usedPct}
         WHERE tenant_id = ${tenantId}
           AND resource = ${resource}
           AND cleared_at IS NULL
        RETURNING first_seen_at, notify_count
      `);
      break;

    default:
      return null;
  }

  return (res.rows ?? [])[0] ?? null;
}

/**
 * Drop cleared episodes once they stop being useful history. Open rows are
 * bounded by (tenant × 3 resources) and cascade away with their tenant, so
 * this only ever touches the audit tail. Called once per scheduler cycle,
 * not per tenant.
 */
export async function gcClearedSaturationEpisodes(
  db: Database,
  logger?: SatLogger,
): Promise<void> {
  try {
    await db.execute(sql`
      DELETE FROM tenant_saturation_events
       WHERE cleared_at IS NOT NULL
         AND cleared_at < NOW() - INTERVAL '30 days'
    `);
  } catch (err) {
    logger?.warn?.({ err }, 'tenant-saturation: gc of cleared episodes failed');
  }
}
