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
import { runPostflight, readPostflightState, type PostflightState } from './collect-postflight.js';

const TICK_MS = 2 * 60 * 1000;
const INITIAL_DELAY_MS = 100_000; // past startup migrations, like the other reconcilers
const LEASE_KEY = 'upgrade_reconciler_lease';
// TTL < tick so the lease is reliably expired by the next tick — we don't want a
// sticky leader, just one actor per interval (and failover if a holder dies).
const LEASE_TTL_MS = Math.floor(TICK_MS * 0.9);

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

  const prevVerdict = await deps.readPrevVerdict();
  const state = await deps.observe(nowMs);

  let notified = false;
  // Notify only on the ENTRY into abort-recommended (not every subsequent tick).
  if (state.verdict === 'abort-recommended' && prevVerdict !== 'abort-recommended') {
    await deps.notifyStuck(state);
    notified = true;
  }
  return { acted: true, verdict: state.verdict, notified };
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
    observe: (nowMs) => runPostflight(settings, k8s, nowMs),
    notifyStuck: (state) => notifyUpgradeStuck(db, state),
  };
}

/**
 * Acquire the per-tick lease (single-flight across replicas). Atomic claim: the
 * guarded UPDATE wins for exactly one replica (Postgres row-locks + re-evaluates
 * the WHERE after the winner commits). Returns true iff THIS replica may act.
 */
export async function claimLease(db: Database, nowMs: number): Promise<boolean> {
  await db.insert(platformSettings).values({ key: LEASE_KEY, value: '0' }).onConflictDoNothing();
  const won = await db
    .update(platformSettings)
    .set({ value: String(nowMs + LEASE_TTL_MS) })
    .where(
      and(
        eq(platformSettings.key, LEASE_KEY),
        // numeric guard so a malformed value can't blow up the CAST.
        sql`${platformSettings.value} ~ '^[0-9]+$'`,
        sql`CAST(${platformSettings.value} AS BIGINT) < ${nowMs}`,
      ),
    )
    .returning({ key: platformSettings.key });
  return won.length === 1;
}

export function startUpgradeReconciler(db: Database, k8s: K8sClients): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[upgrade-reconciler] starting (monitor-only, 2min cadence)');

  const tick = async () => {
    if (stopped) return;
    try {
      // One timestamp for the whole pass — the lease expiry and the observation
      // share it, so a slow claim can't skew lastCheckedAt vs the lease window.
      const nowMs = Date.now();
      if (await claimLease(db, nowMs)) {
        const r = await reconcileUpgradeOnce(realUpgradeReconcilerDeps(db, k8s), nowMs);
        if (r.notified) console.log('[upgrade-reconciler] in-flight upgrade is not converging → notified admins');
      }
    } catch (err) {
      console.error('[upgrade-reconciler] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
