/**
 * Upgrade reconciler (ADR-045 W14 follow-up) — MONITOR + NOTIFY ONLY.
 *
 * While an upgrade is in flight (`pending_update_version` set) this ticks the
 * post-flight OBSERVER on a controlled cadence: it advances the consecutive-
 * failure streak and, on the TRANSITION into `abort-recommended` (the upgrade is
 * not converging after ABORT_THRESHOLD ticks), notifies admins so they can roll
 * back. A confirmed healthy convergence is handled inside runPostflight (clears
 * pending). This scheduler does NOT auto-apply upgrades — Apply stays operator-
 * driven (the deliberate scope decision); the auto-trigger is intentionally absent.
 *
 * Dormant by default: with no upgrade in flight the tick is a cheap no-op.
 * Single-flight across HA replicas via a short DB lease, so the streak is
 * advanced once per real interval (not once per replica → premature abort).
 */
import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { platformSettings, notifications, users } from '../../db/schema.js';
import { dbSettings } from './orchestrate.js';
import { runPostflight, checkConvergence, readPostflightState, type PostflightState } from './collect-postflight.js';
import { collectUpgradeProgress } from './progress.js';
import { finalizeByRef, progressByRef } from '../tasks/service.js';
import { toSafeText } from '@insula/api-contracts';

// Dormant cadence — a cheap no-op tick that just reads `pending_update_version`.
const IDLE_TICK_MS = 30 * 1000;
// Fast cadence WHILE an upgrade is in flight: advance the Task Center progress bar
// and detect convergence within seconds of the roll finishing, instead of the
// up-to-4-min lag (idle cadence + initial delay) the operator saw as "task still
// running after the modal says Done".
const BUSY_TICK_MS = 8 * 1000;
// Short first tick so a freshly-rolled pod confirms convergence + finalizes the
// task promptly (was 100s, which alone delayed finalize by that much). The
// post-flight probes all degrade gracefully on a transient startup error.
const INITIAL_DELAY_MS = 12 * 1000;
// The abort streak advances on this SLOW sub-cadence regardless of the fast tick
// rate, so a normal ~30–90s roll never trips `abort-recommended` (3 advances ≈
// 6 min genuinely stuck), while progress + finalize stay fast.
const STREAK_ADVANCE_MS = 2 * 60 * 1000;
const STREAK_CLOCK_KEY = 'postflight_streak_at';
const LEASE_KEY = 'upgrade_reconciler_lease';
// TTL scales with the active interval so it's reliably expired by the next tick —
// one actor per interval across HA replicas, never a sticky leader.
const leaseTtlFor = (intervalMs: number): number => Math.floor(intervalMs * 0.9);

/** Injected seam — keeps reconcileUpgradeOnce pure + unit-testable off DB/k8s. */
export interface UpgradeReconcilerDeps {
  /** The in-flight target (platform_settings pending_update_version), or null. */
  readonly getPending: () => Promise<string | null>;
  /** The previously-persisted post-flight verdict (to detect a transition). */
  readonly readPrevVerdict: () => Promise<string>;
  /** Advance + persist the streak; returns the new state. */
  readonly observe: (nowMs: number) => Promise<PostflightState>;
  /** Notify admins that the upgrade is not converging. */
  readonly notifyStuck: (state: PostflightState) => Promise<void>;
  /** Finalize the Task Center task (succeeded) on a confirmed healthy convergence. */
  readonly finalizeConverged: (target: string) => Promise<void>;
  /** Live roll progress (percent 0..100 + counts) for the in-flight target. */
  readonly liveProgress: (target: string) => Promise<{ pct: number; atTarget: number; total: number }>;
  /** Write the live roll progress onto the Task Center row (by ref) so the chip advances. */
  readonly updateProgress: (target: string, pct: number, text: string) => Promise<void>;
  /** Fast convergence check (no streak advance) — returns the assessed state. */
  readonly checkConvergence: (nowMs: number) => Promise<PostflightState>;
  /** True (and claims the slot) when the slow abort-streak sub-cadence is due. */
  readonly dueForStreak: (nowMs: number) => Promise<boolean>;
}

export interface ReconcileOutcome {
  readonly acted: boolean;
  readonly verdict?: string;
  readonly notified: boolean;
}

/**
 * One reconcile pass. No-op (acted:false) when nothing is in flight. Otherwise
 * advances the streak and notifies ONCE on the transition into abort-recommended.
 */
export async function reconcileUpgradeOnce(deps: UpgradeReconcilerDeps, nowMs: number): Promise<ReconcileOutcome> {
  const pending = (await deps.getPending())?.trim();
  if (!pending) return { acted: false, notified: false }; // dormant — no upgrade in flight

  // FAST every tick: advance the Task Center progress bar from the live roll so
  // the chip/dropdown track the modal instead of sitting at 0% until finalize.
  try {
    const lp = await deps.liveProgress(pending);
    await deps.updateProgress(pending, lp.pct, `${lp.atTarget}/${lp.total} services on ${pending}`);
  } catch {
    // best-effort — a progress-write hiccup must never fail the reconcile pass.
  }

  // FAST every tick: convergence check WITHOUT advancing the abort streak, so the
  // task finalizes the moment the cluster is healthy at the target — not up to a
  // full slow cadence later. checkConvergence clears the pending marker on healthy.
  const conv = await deps.checkConvergence(nowMs);
  if (conv.verdict === 'healthy') {
    // `pending` still holds the just-converged target — use it as the task ref.
    await deps.finalizeConverged(pending);
    return { acted: true, verdict: 'healthy', notified: false };
  }

  // SLOW sub-cadence: advance the abort streak for stuck-detection only when due,
  // so the fast tick rate never trips a false `abort-recommended` during a normal
  // roll. Notify once on the ENTRY into abort-recommended.
  if (await deps.dueForStreak(nowMs)) {
    const prevVerdict = await deps.readPrevVerdict();
    const state = await deps.observe(nowMs);
    if (state.verdict === 'abort-recommended' && prevVerdict !== 'abort-recommended') {
      await deps.notifyStuck(state);
      return { acted: true, verdict: state.verdict, notified: true };
    }
    return { acted: true, verdict: state.verdict, notified: false };
  }

  return { acted: true, verdict: conv.verdict, notified: false };
}

/** Mark the Task Center platform-upgrade task succeeded on convergence. */
async function finalizeUpgradeTask(db: Database, target: string): Promise<void> {
  await finalizeByRef(db, 'platform.upgrade', target, {
    status: 'succeeded',
    detailsPatch: { convergedAtIso: new Date().toISOString(), toVersion: target },
    recreate: {
      scope: 'system',
      userId: null,
      label: toSafeText(`Platform upgrade → ${target}`),
      target: { type: 'modal', modal: 'platform-upgrade', modalProps: { version: target } },
    },
  }).catch((err) => {
    console.error('[upgrade-reconciler] task finalize failed:', (err as Error).message);
  });
}

async function getAdminUserIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
  return rows.map((r) => r.id);
}

/** Direct admin notification (same pattern as node-health) — the upgrade is stuck. */
async function notifyUpgradeStuck(db: Database, state: PostflightState): Promise<void> {
  const failing = state.gates.filter((g) => g.status === 'fail').map((g) => g.label);
  const title = `Platform upgrade to ${state.pendingVersion ?? 'a new version'} is not converging`;
  const message =
    `Post-flight has failed ${state.consecutiveFailures} consecutive checks` +
    (failing.length > 0 ? ` — unresolved: ${failing.join(', ')}.` : '.') +
    ' Consider rolling back from Platform → Upgrades.';
  const adminIds = await getAdminUserIds(db);
  for (const uid of adminIds) {
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: uid,
      type: 'warning',
      title,
      message,
      resourceType: 'platform_upgrade',
      resourceId: (state.pendingVersion ?? 'upgrade').slice(0, 64),
    }).catch((err) => {
      console.error('[upgrade-reconciler] notification insert failed:', (err as Error).message);
    });
  }
}

export function realUpgradeReconcilerDeps(db: Database, k8s: K8sClients): UpgradeReconcilerDeps {
  const settings = dbSettings(db);
  return {
    getPending: () => settings.get('pending_update_version'),
    readPrevVerdict: async () => (await readPostflightState(db)).verdict,
    // `db` is what lets the migration gates see the registry — without it the
    // postflight degrades to the deployment-only gates it had before.
    observe: (nowMs) => runPostflight(settings, k8s, nowMs, db),
    notifyStuck: (state) => notifyUpgradeStuck(db, state),
    finalizeConverged: (target) => finalizeUpgradeTask(db, target),
    liveProgress: async (target) => {
      const p = await collectUpgradeProgress(k8s, target);
      return { pct: p.percent, atTarget: p.atTarget, total: p.total };
    },
    updateProgress: (target, pct, text) => progressByRef(db, 'platform.upgrade', target, { pct, text: toSafeText(text) }),
    checkConvergence: (nowMs) => checkConvergence(settings, k8s, nowMs, db),
    // Claim the slow streak slot at most once per STREAK_ADVANCE_MS (shared clock
    // setting → HA-safe). Returns true (and stamps the clock) only when due.
    dueForStreak: async (nowMs) => {
      const raw = await settings.get(STREAK_CLOCK_KEY);
      const last = raw !== null && /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
      if (nowMs - last < STREAK_ADVANCE_MS) return false;
      await settings.set(STREAK_CLOCK_KEY, String(nowMs));
      return true;
    },
  };
}

/**
 * Acquire the per-tick lease (single-flight across replicas). Atomic claim: the
 * guarded UPDATE wins for exactly one replica (Postgres row-locks + re-evaluates
 * the WHERE after the winner commits). Returns true iff THIS replica may act.
 */
export async function claimLease(db: Database, nowMs: number, ttlMs: number = leaseTtlFor(IDLE_TICK_MS)): Promise<boolean> {
  await db.insert(platformSettings).values({ key: LEASE_KEY, value: '0' }).onConflictDoNothing();
  const won = await db
    .update(platformSettings)
    .set({ value: String(nowMs + ttlMs) })
    .where(
      and(
        eq(platformSettings.key, LEASE_KEY),
        // numeric guard so a malformed value can't blow up the CAST.
        sql`${platformSettings.value} ~ '^[0-9]+$'`,
        // Claimable when the lease has expired, OR when its expiry is further out
        // than ANY legitimate TTL — a stale lease left by a prior release whose
        // TTL was longer (the old fixed 108s). Without the second clause that
        // stale lease blocks the new fast reconciler through the whole FIRST
        // upgrade to this version (observed: ~90s finalize lag on the transition).
        sql`(CAST(${platformSettings.value} AS BIGINT) < ${nowMs} OR CAST(${platformSettings.value} AS BIGINT) > ${nowMs + leaseTtlFor(IDLE_TICK_MS)})`,
      ),
    )
    .returning({ key: platformSettings.key });
  return won.length === 1;
}

export function startUpgradeReconciler(db: Database, k8s: K8sClients): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[upgrade-reconciler] starting (adaptive: 30s idle / 8s while an upgrade is in flight)');

  const tick = async () => {
    if (stopped) return;
    // Re-arm fast while an upgrade is in flight, dormant otherwise.
    let nextDelay = IDLE_TICK_MS;
    try {
      // One timestamp for the whole pass — the lease expiry and the observation
      // share it, so a slow claim can't skew lastCheckedAt vs the lease window.
      const nowMs = Date.now();
      const pending = (await dbSettings(db).get('pending_update_version'))?.trim();
      const busy = !!pending;
      nextDelay = busy ? BUSY_TICK_MS : IDLE_TICK_MS;
      // Only claim the lease + do work when there's an upgrade in flight; an idle
      // tick is a pure no-op (just the pending read above — no lease churn).
      if (busy && (await claimLease(db, nowMs, leaseTtlFor(nextDelay)))) {
        const r = await reconcileUpgradeOnce(realUpgradeReconcilerDeps(db, k8s), nowMs);
        if (r.notified) console.log('[upgrade-reconciler] in-flight upgrade is not converging → notified admins');
      }
    } catch (err) {
      console.error('[upgrade-reconciler] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, nextDelay);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
