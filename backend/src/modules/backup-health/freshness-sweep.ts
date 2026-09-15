/**
 * Freshness sweep — does every watched backup schedule still PRODUCE backups?
 *
 * The sibling Job watcher answers "did a run fail". This answers the question
 * that had no detector at all: "has a run happened when one was supposed to".
 * Measured on DEV 2026-09-15 — last successful mail snapshot four days earlier,
 * 178 scheduled fires missed, every operator surface green. Nothing failed.
 * Nothing ran. Nothing said so.
 *
 * ## Why this reads CronJobs, not Jobs
 *
 * A missed run leaves NO Job behind, so a Job watcher structurally cannot see
 * it — the evidence is an absence. `CronJob.status.lastSuccessfulTime` plus
 * `spec.schedule` is the whole input, both already on the object.
 *
 * It also means this sweep does not depend on the health-watch labels reaching
 * `spec.jobTemplate.metadata` (the defect PR #577 fixes): CronJobs have carried
 * the label all along. Verified against the live DEV cluster before writing
 * this, per the handover's own warning that a mocked lister proves nothing
 * about a selector:
 *
 *     kubectl get cronjobs -A -l insula.host/backup-health-watch=true
 *       platform/etcd-snap-via-shim              0 * * * *    lastSuccess 15:00
 *       platform/platform-cluster-state-backup   0 3 * * *    lastSuccess 03:00
 *       platform/platform-secrets-backup         15 3 * * *   lastSuccess 03:18
 *
 * ## Two guards that keep it from crying wolf
 *
 * A SUSPENDED schedule is not stale — it is off on purpose, and an idle resting
 * state is not a fault. A schedule YOUNGER than its own stale threshold has not
 * had the chance to run yet: `evaluateFreshness` returns 'never' the moment
 * `lastSuccessAt` is null, which for a CronJob created two minutes ago is true
 * and useless. Both are filtered here rather than in the evaluator, which is
 * pure and has no business knowing about Kubernetes.
 */
import { eq, notInArray } from 'drizzle-orm';
import * as k8s from '@kubernetes/client-node';
import { backupFreshnessState } from '../../db/schema.js';
import {
  evaluateFreshness,
  countScheduledFires,
  scanScheduledFires,
  DEFAULT_STALE_AFTER_FIRES,
  type FreshnessVerdict,
} from './freshness.js';
import {
  notifyAdminBackupStale,
  notifyAdminBackupNeverRun,
  notifyAdminBackupTargetUnreachable,
} from '../notifications/events.js';
import { LABEL_HEALTH_WATCH } from './labels.js';
import { safeTick } from '../../shared/safe-tick.js';
import type { Database } from '../../db/index.js';

/** Same cadence as the Job watcher; both read the same apiserver. */
export const FRESHNESS_TICK_MS = 5 * 60 * 1000;

export interface WatchedSchedule {
  readonly uid: string;
  readonly namespace: string;
  readonly name: string;
  readonly schedule: string | null;
  readonly suspended: boolean;
  readonly lastSuccessAt: Date | null;
  readonly createdAt: Date | null;
  /** `spec.timeZone`. Kubernetes fires the schedule in THIS zone, not UTC. */
  readonly timeZone: string | null;
  /** Runs currently in flight (`status.active`). A running run is not a missed one. */
  readonly activeRuns: number;
  /** When the controller last CREATED a run (`status.lastScheduleTime`). */
  readonly lastScheduleAt: Date | null;
}

export interface FreshnessSweepResult {
  readonly evaluated: number;
  readonly notified: number;
  readonly skippedSuspended: number;
  readonly skippedTooYoung: number;
  readonly skippedInFlight: number;
  readonly pruned: number;
}

type Logger = { warn: (msg: string, err?: unknown) => void; info?: (msg: string) => void };

/**
 * Read watched CronJobs off the apiserver.
 *
 * Exported so the sweep can be tested against hand-built objects AND so the
 * selector itself stays one string rather than being retyped per call site.
 */
export async function listWatchedSchedules(
  batch: k8s.BatchV1Api,
): Promise<readonly WatchedSchedule[]> {
  const res = await batch.listCronJobForAllNamespaces({
    labelSelector: `${LABEL_HEALTH_WATCH}=true`,
  });
  const items = res.items ?? [];
  const out: WatchedSchedule[] = [];
  for (const cj of items) {
    const uid = cj.metadata?.uid;
    const name = cj.metadata?.name;
    const namespace = cj.metadata?.namespace;
    // No UID means no stable identity to remember a verdict against.
    if (!uid || !name || !namespace) continue;
    const last = cj.status?.lastSuccessfulTime;
    const created = cj.metadata?.creationTimestamp;
    out.push({
      uid,
      namespace,
      name,
      schedule: cj.spec?.schedule ?? null,
      timeZone: cj.spec?.timeZone ?? null,
      activeRuns: (cj.status?.active ?? []).length,
      lastScheduleAt: cj.status?.lastScheduleTime ? new Date(cj.status.lastScheduleTime) : null,
      suspended: cj.spec?.suspend === true,
      lastSuccessAt: last ? new Date(last) : null,
      createdAt: created ? new Date(created) : null,
    });
  }
  return out;
}

/** "92.4h" / "3.1d" — short enough for a subject line. */
export function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

/**
 * Has this schedule existed long enough for 'never' to mean anything?
 *
 * Without this a CronJob created moments ago reports 'never' — true, and a
 * false alarm. It must have had at least as many chances to fire as a
 * previously-working schedule gets before being called stale.
 */
export function oldEnoughToJudgeNever(
  s: WatchedSchedule,
  now: Date,
  staleAfter = DEFAULT_STALE_AFTER_FIRES,
): boolean {
  if (!s.schedule || !s.createdAt) return false;
  return countScheduledFires(s.schedule, s.createdAt, now, undefined, s.timeZone) >= staleAfter;
}

/**
 * Is a run happening right now?
 *
 * `status.active` alone is not enough: a Job wedged Pending forever (an
 * unschedulable node, a missing PVC) stays active indefinitely, and treating
 * that as "in progress" would mean the one failure mode with NO failed Job and
 * NO missing run is never reported at all. So a run counts as in flight only
 * while it is younger than one interval — past that the next run is already
 * due and it is stuck, not working.
 */
export function isRunInFlight(s: WatchedSchedule, now: Date, intervalMs: number | null): boolean {
  if (s.activeRuns <= 0) return false;
  if (!s.lastScheduleAt || intervalMs === null) return true;
  return now.getTime() - s.lastScheduleAt.getTime() < intervalMs;
}

export async function runFreshnessSweep(
  db: Database,
  batch: k8s.BatchV1Api,
  log: Logger,
  now: Date = new Date(),
): Promise<FreshnessSweepResult> {
  let schedules: readonly WatchedSchedule[];
  try {
    schedules = await listWatchedSchedules(batch);
  } catch (err) {
    log.warn('listWatchedSchedules failed', err);
    return {
      evaluated: 0, notified: 0, skippedSuspended: 0, skippedTooYoung: 0,
      skippedInFlight: 0, pruned: 0,
    };
  }

  const prior = new Map<string, { verdict: FreshnessVerdict; notifiedVerdict: string | null }>();
  try {
    const rows = await db
      .select({
        resourceUid: backupFreshnessState.resourceUid,
        verdict: backupFreshnessState.verdict,
        notifiedVerdict: backupFreshnessState.notifiedVerdict,
      })
      .from(backupFreshnessState);
    for (const r of rows) {
      prior.set(r.resourceUid, {
        verdict: r.verdict as FreshnessVerdict,
        notifiedVerdict: r.notifiedVerdict,
      });
    }
  } catch (err) {
    // Read failure means no hysteresis this tick, not no evaluation. Say so —
    // a silently missing `previous` looks exactly like a first run.
    log.warn('freshness state read failed; evaluating without hysteresis', err);
  }

  let evaluated = 0;
  let notified = 0;
  let skippedSuspended = 0;
  let skippedTooYoung = 0;
  let skippedInFlight = 0;

  for (const s of schedules) {
    if (s.suspended) {
      skippedSuspended += 1;
      continue;
    }

    const previous = prior.get(s.uid);

    // A run in progress is not a missed run. Leave the stored verdict alone
    // rather than overwriting it with a guess — this tick simply has nothing
    // to say about a schedule that is mid-flight.
    const interval = s.schedule
      ? scanScheduledFires(s.schedule, s.lastSuccessAt ?? s.createdAt ?? now, now, undefined, s.timeZone).intervalMs
      : null;
    if (isRunInFlight(s, now, interval)) {
      skippedInFlight += 1;
      continue;
    }

    const result = evaluateFreshness({
      lastSuccessAt: s.lastSuccessAt,
      cronExpression: s.schedule,
      now,
      previous: previous?.verdict,
      // Per-CronJob, not per-cluster-assumption: a schedule that fires in
      // Europe/Berlin must be counted in Europe/Berlin or every daily job
      // looks like it missed a run for an hour or two every day.
      timeZone: s.timeZone,
    });
    evaluated += 1;

    let verdict = result.verdict;
    if (verdict === 'never' && !oldEnoughToJudgeNever(s, now)) {
      // Too new to have run yet. Record it as unknown rather than fresh: it is
      // not healthy, it is unjudged, and calling it healthy is the false green
      // this work exists to remove.
      verdict = 'unknown';
      skippedTooYoung += 1;
    }

    const label = `${s.namespace}/${s.name}`;
    const alreadyTold = previous?.notifiedVerdict ?? null;
    let notifiedVerdict = alreadyTold;

    // Notify on ENTERING a bad verdict, once. Re-notifying a condition the
    // operator already knows about every five minutes is how an alert becomes
    // noise and then a mute.
    if ((verdict === 'stale' || verdict === 'never') && alreadyTold !== verdict) {
      try {
        if (verdict === 'stale') {
          await notifyAdminBackupStale(db, {
            backupName: label,
            missedFires: String(result.missedFires),
            lastSuccessAge: result.ageMs === null ? 'never' : formatAge(result.ageMs),
            schedule: s.schedule ?? 'unknown',
            detail: result.detail,
          }, `backup-stale:${s.uid}:${result.missedFires}`);
        } else {
          const configuredAge = s.createdAt
            ? formatAge(now.getTime() - s.createdAt.getTime())
            : 'an unknown period';
          await notifyAdminBackupNeverRun(db, {
            backupName: label,
            schedule: s.schedule ?? 'unknown',
            configuredAge,
            detail: result.detail,
          }, `backup-never-run:${s.uid}`);
        }
        notifiedVerdict = verdict;
        notified += 1;
      } catch (err) {
        // Leave notifiedVerdict alone so the next tick retries. Marking it as
        // told when nothing was sent is how a condition goes permanently
        // unreported.
        log.warn(`freshness notification failed for ${label}`, err);
      }
    } else if (verdict === 'fresh' && alreadyTold !== null) {
      // Recovered. Clear the memory so a future relapse notifies again rather
      // than being swallowed as "already told".
      notifiedVerdict = null;
    }

    if (verdict === 'unknown') {
      log.info?.(`[backup-freshness] ${label}: unknown — ${result.detail}`);
    }

    try {
      await db
        .insert(backupFreshnessState)
        .values({
          resourceUid: s.uid,
          namespace: s.namespace,
          name: s.name,
          verdict,
          missedFires: result.missedFires,
          lastSuccessAt: s.lastSuccessAt,
          notifiedVerdict,
          evaluatedAt: now,
        })
        .onConflictDoUpdate({
          target: backupFreshnessState.resourceUid,
          set: {
            namespace: s.namespace,
            name: s.name,
            verdict,
            missedFires: result.missedFires,
            lastSuccessAt: s.lastSuccessAt,
            notifiedVerdict,
            evaluatedAt: now,
          },
        });
    } catch (err) {
      log.warn(`freshness state write failed for ${label}`, err);
    }
  }

  // Prune schedules that no longer exist, so the table stays one row per live
  // CronJob instead of accumulating for the life of the cluster.
  let pruned = 0;
  // An EMPTY listing does not prune.
  //
  // "No watched CronJobs exist" and "the listing came back empty this once" are
  // indistinguishable here, and only one of them is real. Pruning on empty
  // would drop every verdict — losing the hysteresis band and the
  // already-notified memory — so a selector typo or an apiserver blip would be
  // followed by a burst re-announcing conditions the operator already knows
  // about. Stale rows cost nothing; the next non-empty tick removes them.
  if (schedules.length > 0) {
    try {
      const liveUids = schedules.map((s) => s.uid);
      const rows = await db.delete(backupFreshnessState)
        .where(notInArray(backupFreshnessState.resourceUid, liveUids))
        .returning({ id: backupFreshnessState.resourceUid });
      pruned = rows.length;
    } catch (err) {
      log.warn('freshness state prune failed', err);
    }
  }

  return { evaluated, notified, skippedSuspended, skippedTooYoung, skippedInFlight, pruned };
}

/**
 * Report a mail backup target that cannot be reached.
 *
 * `notifyAdminBackupTargetUnreachable` has existed since the categories were
 * seeded and nothing has ever called it.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It does not run in the request path. `listMailBackups` is what the
 *     Backups → Mail page calls, and notifying from there means an operator is
 *     told only when someone happens to open the page — the alert would depend
 *     on somebody already looking.
 *   - It does not branch on the `reason` text. That string is written for a
 *     human and gets reworded; `unreachableCause` is the value to read.
 *     `not_configured` and `provisioning` are not faults — the first would fire
 *     forever on a fresh install, the second resolves itself in about a minute.
 */
export async function checkMailTargetReachable(
  db: Database,
  listMailBackups: () => Promise<{
    repoReachable: boolean;
    unreachableCause: 'not_configured' | 'provisioning' | 'unreachable' | 'timed_out' | null;
    reason: string | null;
    targetName: string | null;
  }>,
  log: Logger,
): Promise<'ok' | 'notified' | 'skipped'> {
  let res;
  try {
    res = await listMailBackups();
  } catch (err) {
    log.warn('mail backup listing threw during reachability check', err);
    return 'skipped';
  }

  if (res.repoReachable) return 'ok';
  if (res.unreachableCause !== 'unreachable' && res.unreachableCause !== 'timed_out') {
    // Configured-but-not-yet-working states. Not an outage.
    return 'skipped';
  }

  try {
    await notifyAdminBackupTargetUnreachable(db, {
      targetName: res.targetName ?? 'mail backup target',
      errorMessage: res.reason ?? `Cause: ${res.unreachableCause}.`,
    }, `mail-target-unreachable:${res.targetName ?? 'mail'}:${res.unreachableCause}`);
    return 'notified';
  } catch (err) {
    log.warn('target-unreachable notification failed', err);
    return 'skipped';
  }
}

export function startFreshnessSweep(deps: {
  readonly db: Database;
  readonly batch: k8s.BatchV1Api;
  readonly tickMs?: number;
  readonly logger?: Logger;
  /**
   * Supplied by app.ts so the reachability check runs on the tick instead of
   * on a page load. Optional so the sweep is testable without a cluster.
   */
  readonly listMailBackups?: () => Promise<{
    repoReachable: boolean;
    unreachableCause: 'not_configured' | 'provisioning' | 'unreachable' | 'timed_out' | null;
    reason: string | null;
    targetName: string | null;
  }>;
}): () => void {
  const tickMs = deps.tickMs ?? FRESHNESS_TICK_MS;
  const log: Logger = deps.logger ?? {
    warn: (msg, err) => console.warn(`[backup-freshness] ${msg}`, err ?? ''),
    info: (msg) => console.log(msg),
  };

  const tick = () => safeTick('backup-freshness', async () => {
    const r = await runFreshnessSweep(deps.db, deps.batch, log);
    if (deps.listMailBackups) {
      await checkMailTargetReachable(deps.db, deps.listMailBackups, log);
    }
    if (r.notified > 0 || r.pruned > 0) {
      log.info?.(
        `[backup-freshness] evaluated=${r.evaluated} notified=${r.notified} `
        + `suspended=${r.skippedSuspended} tooYoung=${r.skippedTooYoung} `
        + `inFlight=${r.skippedInFlight} pruned=${r.pruned}`,
      );
    }
  }, log);

  tick();
  const timer = setInterval(tick, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/** Referenced so the retention guard can see the table has a bounded writer. */
export const __freshnessStateTable = backupFreshnessState;
export { eq };
