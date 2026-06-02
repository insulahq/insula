/**
 * WAL-archive health scheduler: alert on archive failures + circuit-breaker.
 *
 * Every tick: read the breaker (skip if already tripped) → read a health
 * snapshot → assess. On `failing` → alert. On `critical` (failing + pg_wal
 * past the hard pressure threshold) → DISABLE archiving + persist the breaker
 * + fire a mandatory critical alert, so the volume can never fill even if the
 * warnings go unseen for days.
 *
 * `runWalArchiveTick` takes injected ports so the orchestration is unit-tested
 * without real k8s / DB / notifications.
 */
import type { Logger } from 'pino';
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import {
  assessWalArchive,
  DEFAULT_THRESHOLDS,
  type WalArchiveSnapshot,
  type WalArchiveThresholds,
} from './health.js';
import {
  readCircuitBreaker,
  tripCircuitBreaker,
  type CircuitBreakerState,
} from './breaker.js';
import { readWalArchiveHealth, disableWalArchiving } from './service.js';
import {
  notifyAdminWalArchiveFailing,
  notifyAdminWalArchiveAutoDisabled,
} from '../notifications/events.js';

export const WAL_ARCHIVE_HEALTH_TICK_MS = 5 * 60 * 1000;

export interface WalArchiveTickPorts {
  readonly readBreaker: (db: Database) => Promise<CircuitBreakerState>;
  readonly readSnapshot: () => Promise<WalArchiveSnapshot | null>;
  readonly notifyFailing: (db: Database, p: { clusterName: string; pressurePercent: string; reason?: string }, dedupeKey?: string) => Promise<void>;
  readonly notifyDisabled: (db: Database, p: { clusterName: string; reason?: string }, dedupeKey?: string) => Promise<void>;
  readonly tripBreaker: (db: Database, o: { reason: string; clusterName: string; nowIso: string }) => Promise<void>;
  readonly disableArchiving: () => Promise<void>;
  readonly nowIso: () => string;
}

/** One scheduler tick. Pure orchestration over injected ports. */
export async function runWalArchiveTick(
  db: Database,
  log: Pick<Logger, 'warn' | 'error'>,
  ports: WalArchiveTickPorts,
  thresholds: WalArchiveThresholds = DEFAULT_THRESHOLDS,
): Promise<void> {
  // Already tripped → archiving is off, WAL recycles, nothing to do until an
  // operator resets the breaker (which re-enables via the reconciler).
  const breaker = await ports.readBreaker(db);
  if (breaker.tripped) return;

  const snap = await ports.readSnapshot();
  if (!snap) return;

  const a = assessWalArchive(snap, thresholds);
  if (a.state === 'ok') return;

  if (a.shouldTrip) {
    // Two independent disable paths, both best-effort so one failure can't
    // suppress the alert:
    //   1. immediate k8s plugin removal (fast relief),
    //   2. the persisted breaker FLAG — the DURABLE mechanism: the
    //      postgres-objectstore reconciler reads it every tick and ENFORCES
    //      plugin removal (overriding wal-archive ownership), so the disable
    //      sticks even if (1) failed this instant.
    try {
      await ports.disableArchiving();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) },
        'wal-archive-health: immediate disable failed — the breaker flag + reconciler will enforce it');
    }
    try {
      await ports.tripBreaker(db, { reason: a.reason, clusterName: snap.clusterName, nowIso: ports.nowIso() });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) },
        'wal-archive-health: breaker flag NOT persisted (DB write failed) — will retry next tick');
    }
    // Stable dedupe key: the breaker short-circuit above guarantees this path
    // runs at most once per trip lifecycle, so a fixed key is enough and the
    // operator gets a fresh alert if they reset + it re-trips.
    await ports.notifyDisabled(db, { clusterName: snap.clusterName, reason: a.reason },
      `wal-disabled:${snap.clusterName}`);
    log.error({ cluster: snap.clusterName, pressurePct: Math.round(a.pressurePct), reason: a.reason },
      'wal-archive-health: CIRCUIT-BREAKER TRIPPED — WAL archiving auto-disabled to prevent a full volume');
    return;
  }

  // failing (not yet critical): alert, no disable.
  await ports.notifyFailing(db, {
    clusterName: snap.clusterName,
    pressurePercent: String(Math.round(a.pressurePct)),
    reason: a.reason,
  }, `wal-failing:${snap.clusterName}`);
  log.warn({ cluster: snap.clusterName, pressurePct: Math.round(a.pressurePct), severity: a.severity },
    'wal-archive-health: WAL archiving is failing');
}

export interface WalArchiveSchedulerDeps {
  readonly db: Database;
  readonly custom: k8s.CustomObjectsApi;
  /** Accepts Fastify's logger (a pino subset) as well as pino.Logger. */
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly tickMs?: number;
  readonly thresholds?: WalArchiveThresholds;
}

/** Wire the real ports + start the interval. Returns a cleanup function. */
export function startWalArchiveHealthScheduler(deps: WalArchiveSchedulerDeps): () => void {
  const ports: WalArchiveTickPorts = {
    readBreaker: readCircuitBreaker,
    readSnapshot: () => readWalArchiveHealth({ db: deps.db, custom: deps.custom, log: deps.log }),
    notifyFailing: notifyAdminWalArchiveFailing,
    notifyDisabled: notifyAdminWalArchiveAutoDisabled,
    tripBreaker: tripCircuitBreaker,
    disableArchiving: () => disableWalArchiving(deps.custom, deps.log),
    nowIso: () => new Date().toISOString(),
  };
  const tick = (): void => {
    void runWalArchiveTick(deps.db, deps.log, ports, deps.thresholds).catch((err) => {
      deps.log.error({ err: err instanceof Error ? err.message : String(err) },
        'wal-archive-health: scheduler tick failed');
    });
  };
  tick();
  const timer = setInterval(tick, deps.tickMs ?? WAL_ARCHIVE_HEALTH_TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
