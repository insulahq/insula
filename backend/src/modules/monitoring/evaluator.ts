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
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { alertState, monitoringRuleOverrides } from '../../db/schema.js';
import { notifyAdminSloAlertFiring, notifyAdminSloAlertResolved } from '../notifications/events.js';
import { queryInstant, type VmClientOptions } from './vm-client.js';
import { SLO_RULES, MONITORING_UNREACHABLE_RULE_ID, renderExpr, type SloRule } from './rules.js';

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
}

async function applyRuleState(
  db: Database,
  input: TransitionInput,
  log: EvaluatorLogger,
): Promise<void> {
  const { rule, violated, value, now } = input;
  const [existing] = await db.select().from(alertState).where(eq(alertState.ruleId, rule.id));

  if (violated) {
    const since = violationSince.get(rule.id) ?? now.getTime();
    violationSince.set(rule.id, since);
    const heldLongEnough = now.getTime() - since >= input.forSeconds * 1000;
    if (!heldLongEnough) {
      // pending — don't flip state yet, but keep the heartbeat fresh.
      if (existing) {
        await db.update(alertState)
          .set({ lastEvaluatedAt: now, lastValue: value })
          .where(eq(alertState.ruleId, rule.id));
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
          ...(shouldNotify ? { lastNotifiedAt: now } : {}),
        })
        .where(eq(alertState.ruleId, rule.id));
    } else {
      await db.insert(alertState).values({
        ruleId: rule.id,
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
      });
      log.warn(`monitoring: alert FIRING — ${rule.id} (value=${value ?? 'n/a'})`);
    }
    return;
  }

  // healthy
  violationSince.delete(rule.id);
  if (existing?.state === 'firing') {
    await db.update(alertState)
      .set({ state: 'resolved', since: now, lastValue: value, lastEvaluatedAt: now })
      .where(eq(alertState.ruleId, rule.id));
    await notifyAdminSloAlertResolved(db, {
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
    });
    log.info(`monitoring: alert RESOLVED — ${rule.id}`);
  } else if (existing) {
    await db.update(alertState)
      .set({ lastValue: value, lastEvaluatedAt: now })
      .where(eq(alertState.ruleId, rule.id));
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
      const violated = samples.length > 0;
      const value = samples.length > 0 ? Math.max(...samples.map((s) => s.value)) : null;
      await applyRuleState(db, { rule, violated, value, now, forSeconds: rule.forSeconds }, log);
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
  }, log);
}
