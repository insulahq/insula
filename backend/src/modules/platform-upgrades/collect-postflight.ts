/**
 * Collect post-flight FACTS + the streak OBSERVER (ADR-045 W14 follow-up).
 *
 * `collectPostflightFacts` gathers convergence facts from the live cluster (best
 * effort — a failed probe degrades to a `fail` gate, never throws). `runPostflight`
 * is the OBSERVER: it evaluates, advances the consecutive-failure streak over the
 * SettingsIO seam, persists a compact state blob, and — on a confirmed healthy
 * convergence — clears the in-flight `pending_update_version`. The scheduler (W14
 * auto-trigger follow-up) calls it on a CONTROLLED cadence; the GET route only
 * READS the persisted blob (so a fast UI poll never inflates the streak).
 */
import { inArray } from 'drizzle-orm';
import { upgradePostflightResponseSchema } from '@insula/api-contracts';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { SettingsIO } from './orchestrate.js';
import { cnpgReady } from './collect-preflight.js';
import {
  evaluatePostflight,
  advanceStreak,
  ABORT_THRESHOLD,
  type PostflightFacts,
  type PostflightMigrationFacts,
  type PostflightPhase,
  type PostflightVerdict,
  type PostflightGate,
} from './postflight.js';

const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';
const PLATFORM_NS = 'platform';
const RUNNING_VERSION = (process.env.PLATFORM_VERSION?.replace(/^v/, '') ?? 'unknown').trim();
// Cap any cluster-sourced detail string (e.g. a CNPG status message) before it
// is persisted + echoed to the UI — defence-in-depth against an oversized blob.
const MAX_DETAIL_LEN = 200;
const clip = (s: string): string => (s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN - 1)}…` : s);

/** Normalise a stored pending marker: '' / whitespace (our cleared sentinel) → null. */
const normalizePending = (v: string | null): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

// platform_settings keys for the persisted post-flight state.
const KEY_STREAK = 'postflight_consecutive_failures';
const KEY_STATE = 'postflight_state'; // compact JSON the GET route reads
const KEY_PENDING = 'pending_update_version';

/** The persisted, GET-readable post-flight assessment. */
export interface PostflightState {
  readonly phase: PostflightPhase;
  readonly verdict: PostflightVerdict;
  readonly consecutiveFailures: number;
  readonly abortThreshold: number;
  readonly pendingVersion: string | null;
  readonly runningVersion: string;
  readonly gates: readonly PostflightGate[];
  readonly ok: boolean;
  readonly failures: number;
  readonly warnings: number;
  readonly lastCheckedAt: string | null;
  readonly environment: string;
}

async function deploymentHealth(k8s: K8sClients): Promise<{ total: number; available: number; readable: boolean }> {
  try {
    const list = (await k8s.apps.listNamespacedDeployment({
      namespace: PLATFORM_NS,
    } as unknown as Parameters<typeof k8s.apps.listNamespacedDeployment>[0])) as {
      items?: Array<{ spec?: { replicas?: number }; status?: { availableReplicas?: number } }>;
    };
    const items = list.items ?? [];
    let available = 0;
    for (const d of items) {
      const want = d.spec?.replicas ?? 1;
      const have = d.status?.availableReplicas ?? 0;
      if (have >= want) available++;
    }
    return { total: items.length, available, readable: true };
  } catch {
    // Unreadable → readable:false, surfaced as a distinct "unreadable" fail by
    // the gate (never conflated with "N down", never a fail-open pass).
    return { total: 0, available: 0, readable: false };
  }
}

async function crashloopingPods(k8s: K8sClients): Promise<number> {
  try {
    const list = (await k8s.core.listNamespacedPod({
      namespace: PLATFORM_NS,
    } as unknown as Parameters<typeof k8s.core.listNamespacedPod>[0])) as {
      items?: Array<{ status?: { containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }> } }>;
    };
    let count = 0;
    for (const p of list.items ?? []) {
      const looping = (p.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === 'CrashLoopBackOff');
      if (looping) count++;
    }
    return count;
  } catch {
    return 0; // unreadable → don't manufacture a crashloop; other gates still gate
  }
}

/**
 * Platform-migration registry facts. `db` is optional so callers that have no
 * database handle (tests, the offline CLI path) degrade to the deployment-only
 * gates rather than failing — but an UNREADABLE registry is reported as such,
 * never as "converged", because a fail-open here is exactly what let a halted
 * registry ride three tiers on 2026-08-19.
 */
async function migrationFacts(db: Database | null): Promise<PostflightMigrationFacts> {
  if (!db) return {};
  try {
    const { listMigrationStatus } = await import('./index.js');
    const items = await listMigrationStatus(db);
    return {
      migrationsReadable: true,
      migrationsPending: items.filter((m) => m.status === 'pending').length,
      // The registry halts on the first failure, so a pending tail behind a
      // failure is a symptom, not a separate problem — name the cause.
      migrationsFailed: [],
    };
  } catch {
    return { migrationsReadable: false };
  }
}

/** Per-node host-migration convergence, via the existing read-only relay. */
async function hostMigrationFacts(k8s: K8sClients): Promise<PostflightMigrationFacts> {
  try {
    const { readHostMigrationStatus } = await import('./host-migration-status.js');
    const status = await readHostMigrationStatus(k8s);
    const nodes = status.nodes ?? [];
    // No node has reported yet → leave undefined so the gate is omitted rather
    // than blocking an otherwise healthy upgrade on missing data.
    if (nodes.length === 0) return {};
    const bad = nodes.filter((n) => (n.failedCount ?? 0) > 0 || (n.blockedCount ?? 0) > 0);
    return {
      hostMigrationsDegraded: status.degraded === true || bad.length > 0,
      hostMigrationsDetail: bad.length > 0
        ? `${bad.length}/${nodes.length} node(s) blocked: ${bad.map((n) => n.node).join(', ')}`
        : `${nodes.length} node(s) converged`,
    };
  } catch {
    return {};
  }
}

export async function collectPostflightFacts(
  k8s: K8sClients,
  pendingVersion: string | null,
  db: Database | null = null,
): Promise<PostflightFacts> {
  const [cnpg, deploys, loops, migrations, hostMigrations] = await Promise.all([
    cnpgReady(k8s),
    deploymentHealth(k8s),
    crashloopingPods(k8s),
    migrationFacts(db),
    hostMigrationFacts(k8s),
  ]);
  return {
    ...migrations,
    ...hostMigrations,
    pendingVersion,
    runningVersion: RUNNING_VERSION,
    cnpgReady: cnpg.ready,
    cnpgDetail: clip(cnpg.detail),
    deploymentsTotal: deploys.total,
    deploymentsAvailable: deploys.available,
    deploymentsReadable: deploys.readable,
    crashloopingPods: loops,
  };
}

/**
 * The OBSERVER. Evaluate convergence, advance + persist the streak, and on a
 * confirmed healthy convergence clear `pending_update_version`. Returns the state
 * it persisted. Idempotent at the data layer (a re-run just advances the streak
 * one more observation). MUST be called on a controlled cadence, not per UI poll.
 */
async function assess(settings: SettingsIO, k8s: K8sClients, nowMs: number, advance: boolean, db: Database | null = null): Promise<PostflightState> {
  // Normalise '' (our cleared sentinel from a prior healthy run) → null, so a
  // confirmed-converged cluster reads as `idle` and never re-accrues a streak.
  const pendingVersion = normalizePending(await settings.get(KEY_PENDING));
  const facts = await collectPostflightFacts(k8s, pendingVersion, db);
  const result = evaluatePostflight(facts);

  const prevRaw = await settings.get(KEY_STREAK);
  const prev = prevRaw !== null ? Number.parseInt(prevRaw, 10) : 0;
  // The abort streak advances ONLY on the slow cadence (`advance`). The fast
  // convergence pass evaluates + clears pending on a healthy roll WITHOUT
  // inflating the streak — otherwise the busy tick rate would trip
  // `abort-recommended` during a perfectly normal ~30–90s roll.
  let consecutiveFailures: number;
  let verdict: PostflightVerdict;
  if (advance) {
    ({ consecutiveFailures, verdict } = advanceStreak(prev, result));
  } else if (result.phase === 'healthy') {
    consecutiveFailures = 0;
    verdict = 'healthy';
  } else if (result.phase === 'idle') {
    consecutiveFailures = 0;
    verdict = 'idle';
  } else {
    consecutiveFailures = prev;
    verdict = prev >= ABORT_THRESHOLD ? 'abort-recommended' : 'reconciling';
  }

  const state: PostflightState = {
    phase: result.phase,
    verdict,
    consecutiveFailures,
    abortThreshold: ABORT_THRESHOLD,
    pendingVersion,
    runningVersion: facts.runningVersion,
    gates: result.gates,
    ok: result.ok,
    failures: result.failures,
    warnings: result.warnings,
    lastCheckedAt: new Date(nowMs).toISOString(),
    environment: ENVIRONMENT,
  };

  // Persist the streak only when advancing; the fast pass still resets it to 0 on
  // a healthy/idle observation (so convergence clears it) and leaves it untouched
  // while reconciling.
  if (advance) await settings.set(KEY_STREAK, String(consecutiveFailures));
  else if (result.phase === 'healthy' || result.phase === 'idle') await settings.set(KEY_STREAK, '0');
  await settings.set(KEY_STATE, JSON.stringify(state));
  // A confirmed healthy convergence ends the upgrade: clear the in-flight marker
  // so the UI/poller stop showing "upgrading → X" and the streak rests at idle.
  if (verdict === 'healthy') {
    await settings.set(KEY_PENDING, '');
  }
  return state;
}

/**
 * OBSERVER (slow cadence): evaluate convergence AND advance the abort streak.
 * On a confirmed healthy convergence clears `pending_update_version`. MUST be
 * called on a controlled cadence, not per UI poll (the streak is what escalates
 * a stuck upgrade to `abort-recommended`).
 */
export const runPostflight = (settings: SettingsIO, k8s: K8sClients, nowMs: number, db: Database | null = null): Promise<PostflightState> =>
  assess(settings, k8s, nowMs, true, db);

/**
 * FAST convergence check (busy cadence): evaluate + persist the blob + clear
 * `pending_update_version` on a healthy roll, WITHOUT advancing the abort streak.
 * Lets the reconciler finalize the Task Center row within seconds of the roll
 * completing while stuck-detection stays on the slow streak cadence.
 */
export const checkConvergence = (settings: SettingsIO, k8s: K8sClients, nowMs: number, db: Database | null = null): Promise<PostflightState> =>
  assess(settings, k8s, nowMs, false, db);

/** Read-only view of the last persisted post-flight state (the GET route). Never advances the streak. */
export async function readPostflightState(db: Database): Promise<PostflightState> {
  const idle: PostflightState = {
    phase: 'idle', verdict: 'idle', consecutiveFailures: 0, abortThreshold: ABORT_THRESHOLD,
    pendingVersion: null, runningVersion: RUNNING_VERSION, gates: [], ok: true, failures: 0, warnings: 0,
    lastCheckedAt: null, environment: ENVIRONMENT,
  };
  try {
    const rows = await db
      .select()
      .from(platformSettings)
      .where(inArray(platformSettings.key, [KEY_STATE, KEY_PENDING]));
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    // The post-flight assessment is only meaningful WHILE an upgrade is in flight
    // (`pending_update_version` set). On a healthy convergence `runPostflight`
    // clears that marker but the persisted state blob stays FROZEN with the
    // just-completed target as `pendingVersion` + `phase: healthy` — and the
    // scheduler then goes dormant, so nothing ever refreshes it to idle. Reading
    // the blob verbatim would report a PHANTOM perpetual upgrade to the old target
    // (progress bar stuck, modal stuck on "Rolling → <old>…"). Reconcile against
    // the live marker: no live pending → idle, regardless of the frozen blob.
    const livePending = normalizePending(byKey.get(KEY_PENDING) ?? null);
    if (livePending === null) return idle;
    // An upgrade IS in flight. If the scheduler has not written (or we cannot
    // parse) an assessment blob yet — the first ~100s after Apply (the reconciler's
    // initial delay), or a cluster's very first upgrade — do NOT fall back to
    // `idle`: that reports "no upgrade in flight" and makes the just-opened progress
    // modal compute `converged → done` and flash "Done" before the roll even
    // starts. Report a synthetic `reconciling` pinned to the live target so the UI
    // shows in-flight immediately. The abort streak still advances ONLY from a real
    // scheduler-written blob (this read never inflates it).
    const inflight: PostflightState = { ...idle, phase: 'reconciling', verdict: 'reconciling', pendingVersion: livePending };
    const raw = byKey.get(KEY_STATE);
    if (!raw) return inflight;
    let blob: unknown;
    try { blob = JSON.parse(raw); } catch { return inflight; }
    // Full-shape validation against the api-contracts schema (single source of
    // truth) — a malformed / stale-schema / hand-edited blob degrades to the
    // in-flight assessment rather than echoing partial or unvalidated fields.
    const parsed = upgradePostflightResponseSchema.safeParse(blob);
    if (!parsed.success) return inflight;
    // Force the env-derived fields from live constants (never trust the blob's
    // copy); pin `pendingVersion` to the LIVE marker so a target changed since the
    // last scheduler tick reads fresh, not one tick stale.
    return { ...parsed.data, abortThreshold: ABORT_THRESHOLD, runningVersion: RUNNING_VERSION, environment: ENVIRONMENT, pendingVersion: livePending };
  } catch {
    return idle;
  }
}
