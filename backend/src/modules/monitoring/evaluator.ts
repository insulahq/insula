/**
 * SLO alert evaluator (ADR-051 phase 3).
 *
 * One tick (claimed by exactly one HA replica via the scheduler's DB
 * lease): for every enabled rule, query vmsingle, compare against the
 * persisted alert_state, and on transitions notify admins through the
 * standard notification system. Pure in-process — no vmalert, no
 * Alertmanager (ADR-051).
 *
 * State machine per rule:
 *   violated & previously resolved/absent
 *     → record violationSince; fire once `forSeconds` elapsed
 *   violated & firing      → re-notify only after the 24h throttle
 *   healthy  & firing      → resolve + notify
 *   healthy  & resolved    → touch lastEvaluatedAt
 *
 * Who-watches-the-watcher: VM_FAILURE_THRESHOLD consecutive ticks where
 * vmsingle is unreachable raise the synthetic `monitoring-unreachable`
 * critical THROUGH THE SAME alert_state/notification path — which is
 * deliberately independent of VictoriaMetrics (platform DB + SMTP).
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { alertState, monitoringRuleOverrides } from '../../db/schema.js';
import { notifyAdminSloAlertFiring, notifyAdminSloAlertResolved } from '../notifications/events.js';
import { queryInstant, type VmClientOptions } from './vm-client.js';
import {
  SLO_RULES, MONITORING_UNREACHABLE_RULE_ID, renderExpr, describeSubject, subjectKey,
  type SloRule,
} from './rules.js';

export const VM_FAILURE_THRESHOLD = 3;
const RENOTIFY_THROTTLE_MS = 24 * 60 * 60 * 1000; // node-health parity

export interface EvaluatorLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Module-level violation timers ("for" handling). In-memory is correct
 * here: only the lease-holding replica evaluates, and a failover resets
 * the pending window at worst — an alert fires `forSeconds` later, it
 * never fires spuriously. (Persisting pendings would buy little and
 * cost a write per rule per tick.)
 */
const violationSince = new Map<string, number>();
/** Consecutive vm-client failures (same in-memory rationale). */
let vmFailureStreak = 0;

/** Test-only reset. */
export function __resetEvaluatorStateForTest(): void {
  violationSince.clear();
  vmFailureStreak = 0;
}

export function vmReachable(): boolean {
  return vmFailureStreak < VM_FAILURE_THRESHOLD;
}

interface TransitionInput {
  readonly rule: Pick<SloRule, 'id' | 'name' | 'description' | 'severity'>;
  readonly violated: boolean;
  readonly value: number | null;
  readonly now: Date;
  readonly forSeconds: number;
  /**
   * Identifies WHICH object this transition is about. `key` is '' for
   * cluster-wide rules, which keeps their state in exactly one row and
   * preserves the pre-existing behaviour for those.
   */
  readonly subject: { key: string; labels: Record<string, string>; label: string | null };
}

const NO_SUBJECT = { key: '', labels: {}, label: null } as const;

/** In-memory "for" timers are per (rule, subject) now, not per rule. */
function timerKey(ruleId: string, subjectKeyValue: string): string {
  return `${ruleId}\u0000${subjectKeyValue}`;
}

async function applyRuleState(
  db: Database,
  input: TransitionInput,
  log: EvaluatorLogger,
): Promise<void> {
  const { rule, violated, value, now, subject } = input;
  const rowFilter = and(eq(alertState.ruleId, rule.id), eq(alertState.subjectKey, subject.key));
  const [existing] = await db.select().from(alertState).where(rowFilter);
  const timer = timerKey(rule.id, subject.key);

  if (violated) {
    const since = violationSince.get(timer) ?? now.getTime();
    violationSince.set(timer, since);
    const heldLongEnough = now.getTime() - since >= input.forSeconds * 1000;
    if (!heldLongEnough) {
      // pending — don't flip state yet, but keep the heartbeat fresh.
      if (existing) {
        await db.update(alertState)
          .set({ lastEvaluatedAt: now, lastValue: value })
          .where(rowFilter);
      }
      return;
    }

    const wasFiring = existing?.state === 'firing';
    const throttleElapsed = !existing?.lastNotifiedAt
      || now.getTime() - existing.lastNotifiedAt.getTime() >= RENOTIFY_THROTTLE_MS;
    const shouldNotify = !wasFiring || throttleElapsed;

    if (existing) {
      await db.update(alertState)
        .set({
          state: 'firing',
          severity: rule.severity,
          since: wasFiring ? existing.since : now,
          lastValue: value,
          lastEvaluatedAt: now,
          subjectLabels: subject.labels,
          ...(shouldNotify ? { lastNotifiedAt: now } : {}),
        })
        .where(rowFilter);
    } else {
      await db.insert(alertState).values({
        ruleId: rule.id,
        subjectKey: subject.key,
        subjectLabels: subject.labels,
        state: 'firing',
        severity: rule.severity,
        since: now,
        lastValue: value,
        lastNotifiedAt: shouldNotify ? now : null,
        lastEvaluatedAt: now,
      });
    }

    if (shouldNotify) {
      // Categorised dispatch (admin.slo_alert_<severity>) — recipient
      // resolution, channel prefs, quiet hours, and templates are the
      // dispatcher's job; it never throws (fire-and-forget contract).
      await notifyAdminSloAlertFiring(db, {
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        description: rule.description,
        value: value != null ? String(value) : undefined,
        // Without this the admin gets "Certificate not Ready" and no way to
        // tell which certificate, in which namespace, for which tenant.
        subject: subject.label ?? undefined,
        subjectLabels: Object.keys(subject.labels).length > 0 ? subject.labels : undefined,
      });
      log.warn(
        `monitoring: alert FIRING — ${rule.id}`
        + `${subject.label ? ` [${subject.label}]` : ''} (value=${value ?? 'n/a'})`,
      );
    }
    return;
  }

  // healthy
  violationSince.delete(timer);
  if (existing?.state === 'firing') {
    await db.update(alertState)
      .set({ state: 'resolved', since: now, lastValue: value, lastEvaluatedAt: now })
      .where(rowFilter);
    await notifyAdminSloAlertResolved(db, {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      subject: subject.label ?? undefined,
      subjectLabels: Object.keys(subject.labels).length > 0 ? subject.labels : undefined,
    });
    log.info(`monitoring: alert RESOLVED — ${rule.id}${subject.label ? ` [${subject.label}]` : ''}`);
  } else if (existing) {
    await db.update(alertState)
      .set({ lastValue: value, lastEvaluatedAt: now })
      .where(rowFilter);
  }
}

/** Evaluate every enabled rule once. Exported for tests + the scheduler. */
export async function evaluateOnce(
  db: Database,
  log: EvaluatorLogger,
  vmOpts: VmClientOptions = {},
  now: Date = new Date(),
): Promise<void> {
  const overrides = await db.select().from(monitoringRuleOverrides);
  const overrideById = new Map(overrides.map((o) => [o.ruleId, o]));

  let anyQuerySucceeded = false;
  let anyQueryFailed = false;

  for (const rule of SLO_RULES) {
    const ov = overrideById.get(rule.id);
    if (ov && !ov.enabled) continue;
    const expr = renderExpr(rule, ov?.threshold ?? null);
    try {
      const samples = await queryInstant(expr, vmOpts);
      anyQuerySucceeded = true;
      // PromQL comparison semantics: `expr > $T` FILTERS — when the
      // condition holds, the sample survives carrying the LHS VALUE
      // (which can legitimately be 0, e.g. `(count(...) or vector(0))
      // > -1`). So violated = "any sample survived", full stop — an
      // additional value>0 check silently un-fires zero-valued passes
      // (caught live 2026-06-12 on the induced cnpg-down E2E).

      if (rule.subjectLabels.length === 0) {
        // Cluster-wide rule: one state row, keyed by the empty subject.
        const violated = samples.length > 0;
        const value = violated ? Math.max(...samples.map((s) => s.value)) : null;
        await applyRuleState(
          db,
          { rule, violated, value, now, forSeconds: rule.forSeconds, subject: { ...NO_SUBJECT } },
          log,
        );
        continue;
      }

      // Per-subject rule: EACH surviving series is its own alert. This is
      // the whole point — one row per certificate/node/target, so the
      // notification and the panel can name what is broken.
      const firingNow = new Map<string, { labels: Record<string, string>; value: number }>();
      for (const sample of samples) {
        const key = subjectKey(rule, sample.labels);
        const prev = firingNow.get(key);
        // Same subject can appear twice if the expr keeps extra labels;
        // keep the worst value.
        if (!prev || sample.value > prev.value) {
          firingNow.set(key, { labels: sample.labels, value: sample.value });
        }
      }

      for (const [key, hit] of firingNow) {
        await applyRuleState(db, {
          rule,
          violated: true,
          value: hit.value,
          now,
          forSeconds: rule.forSeconds,
          subject: { key, labels: hit.labels, label: describeSubject(rule, hit.labels) },
        }, log);
      }

      // Subjects that were firing and are absent from this tick's result
      // have recovered. Without this pass a resolved certificate would stay
      // "firing" forever — nothing else would ever revisit its row.
      const known = await db.select().from(alertState).where(eq(alertState.ruleId, rule.id));
      for (const row of known) {
        if (firingNow.has(row.subjectKey)) continue;
        const labels = (row.subjectLabels ?? {}) as Record<string, string>;
        await applyRuleState(db, {
          rule,
          violated: false,
          value: null,
          now,
          forSeconds: rule.forSeconds,
          subject: { key: row.subjectKey, labels, label: describeSubject(rule, labels) },
        }, log);
      }
    } catch (err) {
      anyQueryFailed = true;
      log.warn(`monitoring: query failed for ${rule.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Synthetic watcher-of-the-watcher.
  if (anyQueryFailed && !anyQuerySucceeded) {
    vmFailureStreak += 1;
  } else if (anyQuerySucceeded) {
    vmFailureStreak = 0;
  }
  await applyRuleState(db, {
    rule: {
      id: MONITORING_UNREACHABLE_RULE_ID,
      name: 'Monitoring unreachable',
      description: `vmsingle has been unreachable for ${VM_FAILURE_THRESHOLD}+ consecutive evaluation ticks — SLO alerting is blind.`,
      severity: 'critical',
    },
    violated: vmFailureStreak >= VM_FAILURE_THRESHOLD,
    value: vmFailureStreak,
    now,
    forSeconds: 0,
    subject: { ...NO_SUBJECT },
  }, log);
}
