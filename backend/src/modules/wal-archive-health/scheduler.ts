/**
 * WAL-archive health scheduler: alert on archive failures + circuit-breaker.
 *
 * Every tick: read the breaker (skip if already tripped) → read a health
 * snapshot → assess. On `failing` → alert, once it has failed long enough. On
 * `critical` (failing + pg_wal past the hard pressure threshold) → DISABLE
 * archiving + persist the breaker + fire a mandatory critical alert, so the
 * volume can never fill even if the warnings go unseen for days. Healthy again
 * after an alert → "recovered", so every alert gets its end.
 *
 * `runWalArchiveTick` takes injected ports so the orchestration is unit-tested
 * without real k8s / DB / notifications.
 */
import type { Logger } from 'pino';
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
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
import {
  readAlertedFailure,
  recordAlertedFailure,
  clearAlertedFailure,
  type AlertedFailure,
} from './alerted-failure.js';
import { readWalArchiveHealth, disableWalArchiving } from './service.js';
import {
  notifyAdminWalArchiveFailing,
  notifyAdminWalArchiveAutoDisabled,
  notifyAdminWalArchiveRecovered,
} from '../notifications/events.js';

export const WAL_ARCHIVE_HEALTH_TICK_MS = 5 * 60 * 1000;

export interface WalArchiveTickPorts {
  readonly readBreaker: (db: Database) => Promise<CircuitBreakerState>;
  readonly readSnapshot: () => Promise<WalArchiveSnapshot | null>;
  /** Resolves true when the alert reached someone. */
  readonly notifyFailing: (db: Database, p: { clusterName: string; pressurePercent: string; reason?: string }, dedupeKey?: string) => Promise<boolean>;
  readonly notifyDisabled: (db: Database, p: { clusterName: string; reason?: string }, dedupeKey?: string) => Promise<void>;
  readonly notifyRecovered: (db: Database, p: { clusterName: string; failedFor: string }, dedupeKey?: string) => Promise<void>;
  readonly readAlerted: (db: Database) => Promise<AlertedFailure | null>;
  readonly recordAlerted: (db: Database, f: AlertedFailure) => Promise<void>;
  readonly clearAlerted: (db: Database) => Promise<void>;
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

  const nowIso = ports.nowIso();
  const a = assessWalArchive(snap, thresholds, Date.parse(nowIso));
  if (a.state === 'ok') {
    await closeAlertedFailure(db, log, ports, snap, nowIso);
    return;
  }

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
      await ports.tripBreaker(db, { reason: a.reason, clusterName: snap.clusterName, nowIso });
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

  // Failing, but not for long yet: most likely a failover's first upload,
  // which the retry fixes within seconds. Say so in the log only.
  if (!a.shouldAlert) {
    log.warn({ cluster: snap.clusterName, failingSince: snap.failingSince }, `wal-archive-health: ${a.reason}`);
    return;
  }

  // failing (not yet critical): alert, no disable. The key names the failure,
  // so the next one alerts too — a fixed key would let the dispatcher's
  // 30-day dedupe swallow every failure after the first. With no start time
  // from CNPG, the failure already on record is this one; else it starts now,
  // and until a record exists each tick's key is new — the category's 6-hour
  // rate limit is what holds those to one alert.
  //
  // A new start replaces the record: when archiving recovered and failed again
  // between two ticks, the earlier failure gets no "working again" of its own,
  // and the alert for this one says what is true now.
  const alerted = await ports.readAlerted(db).catch((err: unknown) => {
    // An unreadable record must not cost the alert.
    log.warn({ err: err instanceof Error ? err.message : String(err) },
      'wal-archive-health: could not read the alerted failure — alerting without it');
    return null;
  });
  const onRecord = alerted?.clusterName === snap.clusterName ? alerted : null;
  const failingSince = snap.failingSince ?? onRecord?.failingSince ?? nowIso;
  const reached = await ports.notifyFailing(db, {
    clusterName: snap.clusterName,
    pressurePercent: String(Math.round(a.pressurePct)),
    reason: a.reason,
  }, `wal-failing:${snap.clusterName}:${failingSince}`);
  log.warn({ cluster: snap.clusterName, pressurePct: Math.round(a.pressurePct), severity: a.severity, reached },
    'wal-archive-health: WAL archiving is failing');
  if (!reached || onRecord?.failingSince === failingSince) return;
  await ports.recordAlerted(db, { clusterName: snap.clusterName, failingSince, alertedAt: nowIso });
}

/**
 * Archiving is not failing. If an alert went out for the last failure, tell
 * the operator it is over — but only once CNPG reports archiving working
 * (condition 'True'). An absent or Unknown condition, as during a restart,
 * waits for a later tick: closing on it could announce a failure as over that
 * is not, and the dedupe key would then swallow the real "working again".
 *
 * With the plugin removed (archiving switched off), WAL no longer reaches the
 * target at all, and "working again" would be false: the record is dropped
 * silently. After a breaker trip the record stays, because ticks skip while
 * tripped; once an operator resets it and archiving works, the notice closes
 * the alert with the whole time it failed, including the time it was off.
 */
async function closeAlertedFailure(
  db: Database,
  log: Pick<Logger, 'warn' | 'error'>,
  ports: WalArchiveTickPorts,
  snap: WalArchiveSnapshot,
  nowIso: string,
): Promise<void> {
  const alerted = await ports.readAlerted(db);
  if (!alerted) return;
  if (snap.barmanPluginPresent) {
    if (!snap.continuousArchivingConfirmed) return;
    await ports.notifyRecovered(db, {
      clusterName: alerted.clusterName,
      failedFor: failedFor(alerted.failingSince, nowIso),
    }, `wal-recovered:${alerted.clusterName}:${alerted.failingSince}`);
  }
  try {
    await ports.clearAlerted(db);
  } catch (err) {
    // The dedupe key keeps a retried notice from going out twice.
    log.error({ err: err instanceof Error ? err.message : String(err) },
      'wal-archive-health: could not clear the alerted failure — retrying next tick');
  }
}

/** "25 minutes", "3 hours 5 minutes" — the time the failure lasted, up to now. */
export function failedFor(failingSince: string, nowIso: string): string {
  const ms = Date.parse(nowIso) - Date.parse(failingSince);
  const totalMin = Math.max(1, Number.isNaN(ms) ? 0 : Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (h === 0) return unit(m, 'minute');
  return m === 0 ? unit(h, 'hour') : `${unit(h, 'hour')} ${unit(m, 'minute')}`;
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
    notifyRecovered: notifyAdminWalArchiveRecovered,
    readAlerted: readAlertedFailure,
    recordAlerted: recordAlertedFailure,
    clearAlerted: clearAlertedFailure,
    tripBreaker: tripCircuitBreaker,
    disableArchiving: () => disableWalArchiving(deps.custom, deps.log),
    nowIso: () => new Date().toISOString(),
  };
  const tickMs = deps.tickMs ?? WAL_ARCHIVE_HEALTH_TICK_MS;
  // One replica watches: the breaker is read, then tripped — two replicas
  // reading it untripped together would both disable archiving and both alert.
  const tick = (): void => {
    void withSchedulerLease(deps.db, 'wal-archive-health', tickMs * 1.5,
      () => runWalArchiveTick(deps.db, deps.log, ports, deps.thresholds), { log: deps.log }).catch((err) => {
      deps.log.error({ err: err instanceof Error ? err.message : String(err) },
        'wal-archive-health: scheduler tick failed');
    });
  };
  tick();
  const timer = setInterval(tick, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
