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
import { eq } from 'drizzle-orm';
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

export async function collectPostflightFacts(k8s: K8sClients, pendingVersion: string | null): Promise<PostflightFacts> {
  const [cnpg, deploys, loops] = await Promise.all([
    cnpgReady(k8s),
    deploymentHealth(k8s),
    crashloopingPods(k8s),
  ]);
  return {
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
export async function runPostflight(settings: SettingsIO, k8s: K8sClients, nowMs: number): Promise<PostflightState> {
  // Normalise '' (our cleared sentinel from a prior healthy run) → null, so a
  // confirmed-converged cluster reads as `idle` and never re-accrues a streak.
  const pendingVersion = normalizePending(await settings.get(KEY_PENDING));
  const facts = await collectPostflightFacts(k8s, pendingVersion);
  const result = evaluatePostflight(facts);

  const prevRaw = await settings.get(KEY_STREAK);
  const prev = prevRaw !== null ? Number.parseInt(prevRaw, 10) : 0;
  const { consecutiveFailures, verdict } = advanceStreak(prev, result);

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

  await settings.set(KEY_STREAK, String(consecutiveFailures));
  await settings.set(KEY_STATE, JSON.stringify(state));
  // A confirmed healthy convergence ends the upgrade: clear the in-flight marker
  // so the UI/poller stop showing "upgrading → X" and the streak rests at idle.
  if (verdict === 'healthy') {
    await settings.set(KEY_PENDING, '');
  }
  return state;
}

/** Read-only view of the last persisted post-flight state (the GET route). Never advances the streak. */
export async function readPostflightState(db: Database): Promise<PostflightState> {
  const idle: PostflightState = {
    phase: 'idle', verdict: 'idle', consecutiveFailures: 0, abortThreshold: ABORT_THRESHOLD,
    pendingVersion: null, runningVersion: RUNNING_VERSION, gates: [], ok: true, failures: 0, warnings: 0,
    lastCheckedAt: null, environment: ENVIRONMENT,
  };
  try {
    const rows = await db.select().from(platformSettings).where(eq(platformSettings.key, KEY_STATE)).limit(1);
    const raw = rows[0]?.value;
    if (!raw) return idle;
    // Full-shape validation against the api-contracts schema (single source of
    // truth) — a malformed / stale-schema / hand-edited blob falls back to idle
    // rather than echoing partial or unvalidated fields to the super_admin UI.
    const parsed = upgradePostflightResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return idle;
    // Force the env-derived fields from live constants (never trust the blob's copy).
    return { ...parsed.data, abortThreshold: ABORT_THRESHOLD, runningVersion: RUNNING_VERSION, environment: ENVIRONMENT };
  } catch {
    return idle;
  }
}
