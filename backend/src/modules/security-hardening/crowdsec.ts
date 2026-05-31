/**
 * CrowdSec — Banned IPs admin service.
 *
 * Wraps the in-cluster CrowdSec Local API (LAPI). Reads use the
 * bouncer key (HTTP); writes (manual ban / unban) shell out to `cscli`
 * inside the CrowdSec pod via `kubectl exec` because the LAPI
 * machine-auth path is not exposed to the platform.
 *
 * Manual bans added by this UI are prefixed with `MANUAL_BAN_REASON_PREFIX`
 * in the scenario field so the list endpoint can flag them as
 * operator-added vs automatic (community blocklist / scenario hits).
 *
 * Cluster-wide enforcement coverage is provided by the Traefik
 * DaemonSet — every node's Traefik replica queries the same LAPI on
 * every request via the crowdsec middleware. We surface the
 * traefik-pods-vs-nodes count in the status response so an operator
 * can see at a glance whether enforcement is universal.
 */

import * as k8s from '@kubernetes/client-node';
import { Buffer } from 'node:buffer';
import { createKubeConfig } from '../container-console/service.js';
import { cscliExec, findCrowdsecPodName, parseCscliJson } from './cscli-exec.js';
import type {
  CrowdsecAddBanRequest,
  CrowdsecBouncer,
  CrowdsecCoverage,
  CrowdsecDecision,
  CrowdsecListDecisionsQuery,
  CrowdsecListDecisionsResponse,
  CrowdsecMachine,
  CrowdsecStatus,
} from '@insula/api-contracts';

const CROWDSEC_NAMESPACE = 'crowdsec';
// Platform-api uses its own pre-registered bouncer key so it shows up
// as a single named bouncer "platform-api" in `cscli bouncers list`
// instead of one per (pod IP, pod restart) tuple under the shared
// Traefik key. Bootstrap.sh's generate_platform_api_bouncer_key()
// creates this Secret + runs `cscli bouncers add platform-api -k
// <key>` so CrowdSec maps it to a stable name. Falls back to the
// shared Traefik key on clusters bootstrapped before that function
// existed — those clusters will continue to show the platform-api as
// `traefik@<pod-ip>` until they're re-bootstrapped or the secret is
// created manually (the new key + bouncer registration are
// idempotent on re-runs).
const PLATFORM_API_BOUNCER_SECRET = 'platform-api-bouncer-key';
const CROWDSEC_BOUNCER_SECRET = 'crowdsec-bouncer-key';
const CROWDSEC_BOUNCER_SECRET_KEY = 'bouncer-key';
// User-Agent for platform-api's LAPI calls. CrowdSec uses this string
// to derive the bouncer name when auto-registering. Without an explicit
// UA, Node.js's undici defaults to literally "node", which CrowdSec
// logs as "bad user agent 'node'" and registers under `traefik@<ip>`
// (suffixing onto the shared Traefik bouncer name). Setting a
// distinguishable UA + using our own pre-registered bouncer key
// keeps platform-api as a single entry instead of one per pod IP.
const PLATFORM_API_USER_AGENT = 'Hosting-Platform-Admin/1.0';
const LAPI_BASE_URL = process.env.CROWDSEC_LAPI_URL ?? 'http://crowdsec.crowdsec.svc.cluster.local:8080';
const TRAEFIK_NAMESPACE = 'traefik';
const TRAEFIK_DAEMONSET = 'traefik';
const MODSEC_LABEL_SELECTOR = 'app.kubernetes.io/name=modsec-crs';

/**
 * All bans added through this UI carry this prefix in the scenario/reason
 * field. Used to distinguish operator-added bans from automatic ones
 * (community blocklist, scenario triggers) on the listing screen.
 */
export const MANUAL_BAN_REASON_PREFIX = 'admin-panel:';

/**
 * Long-duration "static" operator bans (F2). Distinguished from transient
 * MANUAL bans by the prefix so the UI can flag them with staticByOperator=true.
 */
export const MANUAL_STATIC_BAN_REASON_PREFIX = 'admin-panel-static:';

// 100 years — effectively permanent. CrowdSec stores decisions with
// an absolute `until` timestamp, so there is no "never expires" sentinel
// flag; the longest practical duration is the safety story. Verified
// against cscli on 2026-05-26: `--duration 876000h` parses cleanly,
// rounds to `875999h59m57s`, and Go's time.Duration int64 has plenty of
// headroom (max ~292 years). Exported so the admin route response can
// echo back the same value the cscli call used (instead of the old
// hardcoded '8760h' string that lied to callers after the bump).
export const STATIC_BAN_DURATION = '876000h';

const LAPI_HTTP_TIMEOUT_MS = 8_000;

// ─── KubeConfig loading + bouncer key caching ──────────────────────────

// Module-level cache — single-process Fastify deployment today. If the
// platform scales to multiple platform-api replicas, each replica holds
// its own copy; on Secret rotation, every replica picks up the new key
// within BOUNCER_KEY_TTL_MS independently. Move to Redis if cross-replica
// invalidation matters (the platform already uses Redis for other TTL
// caches).
let cachedBouncerKey: { value: string; loadedAt: number } | null = null;
const BOUNCER_KEY_TTL_MS = 5 * 60 * 1000;

async function loadBouncerKey(kc: k8s.KubeConfig): Promise<string> {
  if (cachedBouncerKey && Date.now() - cachedBouncerKey.loadedAt < BOUNCER_KEY_TTL_MS) {
    return cachedBouncerKey.value;
  }
  const core = kc.makeApiClient(k8s.CoreV1Api);
  // Prefer the platform-api-specific Secret (pre-registered via
  // cscli bouncers add by bootstrap.sh). Falls back to the shared
  // Traefik bouncer key on clusters bootstrapped before that path
  // existed — those see the old per-pod-IP entries until the
  // operator re-runs bootstrap or creates the new Secret manually.
  let secret: { data?: Record<string, string> } | null = null;
  let usedName = PLATFORM_API_BOUNCER_SECRET;
  try {
    secret = (await core.readNamespacedSecret({
      name: PLATFORM_API_BOUNCER_SECRET,
      namespace: CROWDSEC_NAMESPACE,
    })) as unknown as { data?: Record<string, string> };
  } catch (err) {
    // Only a TRUE 404 falls back to the shared Traefik key. Network
    // errors, 5xx, auth failures, etc. re-throw — silently swallowing
    // them into the fallback path would be a security regression
    // (platform-api would use the wrong key on transient API-server
    // blips, possibly authenticating as a different bouncer).
    // statusCode is the @kubernetes/client-node HTTP status; code is
    // a Node.js errno (ECONNRESET, etc.) — only the numeric 404
    // match counts as a real "Secret doesn't exist" signal.
    const e = err as { statusCode?: unknown; code?: unknown };
    const isHttp404 = e.statusCode === 404 || e.code === 404;
    if (!isHttp404) throw err;
    // Backward-compat fallback to the shared Traefik bouncer key.
    secret = (await core.readNamespacedSecret({
      name: CROWDSEC_BOUNCER_SECRET,
      namespace: CROWDSEC_NAMESPACE,
    })) as unknown as { data?: Record<string, string> };
    usedName = CROWDSEC_BOUNCER_SECRET;
  }
  const data = secret?.data ?? {};
  const b64 = data[CROWDSEC_BOUNCER_SECRET_KEY];
  if (!b64) {
    throw new Error(`Secret ${CROWDSEC_NAMESPACE}/${usedName} missing key "${CROWDSEC_BOUNCER_SECRET_KEY}"`);
  }
  const decoded = Buffer.from(b64, 'base64').toString('utf-8').trim();
  cachedBouncerKey = { value: decoded, loadedAt: Date.now() };
  return decoded;
}

// ─── LAPI HTTP helpers ─────────────────────────────────────────────────

interface LapiRawDecision {
  id?: number;
  origin?: string;
  type?: string;
  scope?: string;
  value?: string;
  scenario?: string;
  duration?: string;
  simulated?: boolean;
}

/**
 * The bouncer name CrowdSec sees us as. Matches what bootstrap.sh's
 * generate_platform_api_bouncer_key() registers via `cscli bouncers
 * add platform-api -k <key>`. Used by:
 *   - reregisterPlatformApiBouncer() — self-heal on 403
 *   - pruneStaleBouncersExcept()    — never prune our own registration
 */
export const PLATFORM_API_BOUNCER_NAME = 'platform-api';

/**
 * Re-register the platform-api bouncer with CrowdSec, using the key
 * stored in the k8s Secret. Called when LAPI returns 403 (bouncer
 * registration lost — e.g. CrowdSec pod restarted with ephemeral
 * storage, the prune scheduler caught us during a long idle window,
 * or an operator manually deleted the entry).
 *
 * Idempotent via delete-then-add: cscli refuses to overwrite an
 * existing bouncer name, and `bouncers add` is what generates a NEW
 * key by default — so we delete first (no-op if absent), then add
 * with `-k <our-key>` to keep the Secret's key value authoritative.
 *
 * Returns true on success, false on any failure (caller decides
 * whether to retry the LAPI call or bubble up). Errors are logged
 * by the caller because we don't take a `log` here — the function
 * is intentionally narrow.
 */
async function reregisterPlatformApiBouncer(
  kc: k8s.KubeConfig,
  key: string,
): Promise<boolean> {
  try {
    const podName = await findCrowdsecPodName(kc);
    // `delete` may fail with "bouncer not found" — that's the normal
    // self-heal path. Swallow and continue to `add`.
    await cscliExec(kc, podName, ['bouncers', 'delete', PLATFORM_API_BOUNCER_NAME]).catch(() => {});
    // `add -k <key>` — the bootstrap.sh comment notes the short -k form
    // is reliable via `kubectl exec` whereas --key was observed to be
    // silently ignored. Stick with -k here too.
    await cscliExec(kc, podName, ['bouncers', 'add', PLATFORM_API_BOUNCER_NAME, '-k', key]);
    return true;
  } catch {
    return false;
  }
}

// Coalesce concurrent self-heal attempts onto one promise. Without
// this, N parallel lapiGet calls that all hit 403 would each spawn
// their own cscli delete+add cycle (and could race on the cscli's
// sqlite). One coalesced re-register caps the load.
//
// Cross-replica caveat: this is module-level state in a single Node
// process. With multiple platform-api replicas, each pod has its own
// `inFlightReregister`. The cscli sqlite (single-writer WAL) serialises
// the actual delete+add at the DB level, so cross-replica races resolve
// safely — replica A's `add` wins; replica B's `add` errors with
// "bouncer already exists" and `reregisterPlatformApiBouncer` returns
// false. Replica B's next lapiGet (or next heartbeat tick) will then
// see a valid registration and succeed. Acceptable degraded behaviour;
// no Redis-coordinated lock needed.
let inFlightReregister: Promise<boolean> | null = null;

// Lightweight fetcher used for the initial attempt AND the retry.
// Each call gets its own AbortController + timeout so the retry path
// after a slow self-heal doesn't inherit an already-aborted signal
// from the initial attempt's timeout (which was the actual failure
// mode in degraded-CrowdSec scenarios: initial fetch times out → ctrl
// aborts → reregister runs ~5-15s → retry fetch sees aborted signal →
// rejects instantly → operator sees "self-heal didn't help").
async function lapiGetOnce(path: string, key: string): Promise<Response> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LAPI_HTTP_TIMEOUT_MS);
  try {
    // User-Agent is required: Node.js's undici defaults to literally
    // "node", which CrowdSec rejects as "bad user agent" and falls
    // back to creating a per-source-IP bouncer entry under the
    // shared Traefik bouncer name. Setting an explicit UA + using
    // the platform-api-specific pre-registered bouncer key keeps
    // CrowdSec mapping to a single stable bouncer entry.
    return await fetch(`${LAPI_BASE_URL}${path}`, {
      headers: {
        'X-Api-Key': key,
        'Accept': 'application/json',
        'User-Agent': PLATFORM_API_USER_AGENT,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function lapiGet<T>(path: string, key: string, kc?: k8s.KubeConfig): Promise<T> {
  let res = await lapiGetOnce(path, key);
  if (res.status === 403 && kc) {
    // Self-heal: bouncer registration lost (pod restart with ephemeral
    // storage, prune scheduler caught us during a long idle window,
    // etc.). Re-register from the Secret's key — same value, just
    // re-stamped into CrowdSec's sqlite — and retry ONCE. Coalesce
    // concurrent attempts onto a single inFlight promise so a thundering
    // herd of admin-panel tabs doesn't spawn N parallel cscli runs.
    if (!inFlightReregister) {
      inFlightReregister = reregisterPlatformApiBouncer(kc, key).finally(() => {
        inFlightReregister = null;
      });
    }
    const healed = await inFlightReregister;
    if (healed) {
      res = await lapiGetOnce(path, key);
    }
  }
  if (!res.ok) {
    // 403 still means the bouncer key was rejected after self-heal
    // (or kc wasn't provided so we couldn't try). Surface a remediation
    // hint instead of the bare status code so operators can fix it
    // without spelunking logs.
    if (res.status === 403) {
      throw new Error(
        `LAPI GET ${path} → HTTP 403 (bouncer key rejected after self-heal attempt; check the Secret crowdsec/${PLATFORM_API_BOUNCER_SECRET} key matches what CrowdSec stores, or re-run \`scripts/bootstrap.sh --resume-from-phase3\`)`,
      );
    }
    throw new Error(`LAPI GET ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function lapiHealth(): Promise<{ healthy: boolean; error: string | null }> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), LAPI_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${LAPI_BASE_URL}/health`, {
      headers: { 'User-Agent': PLATFORM_API_USER_AGENT },
      signal: ctrl.signal,
    });
    return { healthy: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// cscli exec helper moved to cscli-exec.ts (shared with allowlists).

// ─── Decision shape mapping ───────────────────────────────────────────

function parseLapiDecision(d: LapiRawDecision): CrowdsecDecision | null {
  const idNum = typeof d.id === 'number' ? d.id : Number(d.id);
  const origin = String(d.origin ?? '');
  const type = String(d.type ?? '');
  const scope = String(d.scope ?? '');
  const value = String(d.value ?? '');
  const scenario = String(d.scenario ?? '');
  const duration = String(d.duration ?? '');
  if (!Number.isFinite(idNum) || !value) return null;
  // Validate enums — drop unknown values rather than throw.
  if (type !== 'ban' && type !== 'captcha' && type !== 'throttle' && type !== 'mfa') return null;
  if (scope !== 'Ip' && scope !== 'Range' && scope !== 'Country' && scope !== 'AS') return null;
  return {
    id: idNum,
    origin,
    type,
    scope,
    value,
    scenario,
    duration,
    expiresAt: parseDurationToAbsolute(duration),
    manualByOperator: origin === 'cscli' && scenario.startsWith(MANUAL_BAN_REASON_PREFIX),
    staticByOperator: origin === 'cscli' && scenario.startsWith(MANUAL_STATIC_BAN_REASON_PREFIX),
    simulated: Boolean(d.simulated),
  };
}

/**
 * Best-effort: CrowdSec durations come as "4h3m12s" / "29d" / "1m". Map
 * to an absolute ISO timestamp relative to "now" so the UI can render
 * "expires in 4h" / sort by expiry. Returns null for unparseable inputs.
 */
function parseDurationToAbsolute(duration: string): string | null {
  const re = /(-?)(\d+)([smhd])/g;
  let totalMs = 0;
  let sign = 1;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(duration)) !== null) {
    matched = true;
    if (m[1] === '-') sign = -1;
    const n = Number(m[2]);
    const unit = m[3];
    const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    totalMs += n * mult;
  }
  if (!matched) return null;
  return new Date(Date.now() + sign * totalMs).toISOString();
}

// ─── Public service surface ────────────────────────────────────────────

/**
 * Heartbeat helper for crowdsec-bouncer-heartbeat-scheduler. Calls the
 * same `/v1/decisions` endpoint a real bouncer would, which bumps
 * CrowdSec's `last_pull` timestamp on the platform-api bouncer
 * registration and prevents the 24h prune scheduler from harvesting
 * us during idle windows. Returns the number of decisions seen so the
 * scheduler can log non-zero ticks as a coarse health signal.
 */
export async function fetchDecisionsHeartbeat(
  kubeconfigPath: string | undefined,
): Promise<number> {
  const kc = createKubeConfig(kubeconfigPath);
  const key = await loadBouncerKey(kc);
  const raw = await lapiGet<LapiRawDecision[] | null>('/v1/decisions', key, kc);
  return (raw ?? []).length;
}

export async function listDecisions(
  kubeconfigPath: string | undefined,
  query: CrowdsecListDecisionsQuery,
): Promise<CrowdsecListDecisionsResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const key = await loadBouncerKey(kc);
  // Pass kc so lapiGet can self-heal on 403 (re-register bouncer + retry).
  const raw = await lapiGet<LapiRawDecision[] | null>('/v1/decisions', key, kc);
  const all = (raw ?? []).map(parseLapiDecision).filter((d): d is CrowdsecDecision => d !== null);
  let filtered = all;
  if (query.scope) filtered = filtered.filter((d) => d.scope === query.scope);
  if (query.manualOnly) filtered = filtered.filter((d) => d.manualByOperator);
  if (query.staticOnly) filtered = filtered.filter((d) => d.staticByOperator);
  if (query.q) {
    const q = query.q.toLowerCase();
    filtered = filtered.filter((d) => d.value.toLowerCase().includes(q));
  }
  return {
    decisions: filtered,
    totalActive: all.length,
  };
}

export async function addBan(
  kubeconfigPath: string | undefined,
  req: CrowdsecAddBanRequest,
  actor: string,
): Promise<{ message: string }> {
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  // Scenario field carries the prefix + actor + reason so the listing endpoint can
  // surface "added by <actor>: <reason>" and the manualByOperator flag is reliable.
  const scenario = `${MANUAL_BAN_REASON_PREFIX}${actor}:${req.reason}`;
  // cscli uses --ip for single IPs and --range for CIDRs. Build the list
  // declaratively so reordering arguments above doesn't silently break the
  // flag swap (the previous `cscliArgs[3] = '--range'` form was fragile).
  const targetFlag = req.scope === 'Range' ? '--range' : '--ip';
  const cscliArgs = [
    'decisions', 'add',
    targetFlag, req.value,
    '--duration', req.duration,
    '--reason', scenario,
    '--type', 'ban',
  ];
  const { stdout, stderr } = await cscliExec(kc, podName, cscliArgs);
  return { message: (stdout + stderr).trim().slice(0, 500) };
}

/**
 * F2 — Static (effectively-permanent) operator ban. Same code path as
 * addBan but with the static prefix + 100-year duration. The list
 * endpoint flags these with staticByOperator=true. Bumped from 1-year
 * to 100-year on 2026-05-26 so operators no longer have to re-add
 * known-bad IPs annually; CrowdSec has no "never expires" flag, so a
 * very-long duration is the only available expression of "permanent".
 */
export async function addStaticBan(
  kubeconfigPath: string | undefined,
  req: { value: string; scope: 'Ip' | 'Range' | 'Country' | 'AS'; reason: string },
  actor: string,
): Promise<{ message: string }> {
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  const scenario = `${MANUAL_STATIC_BAN_REASON_PREFIX}${actor}:${req.reason}`;
  const targetFlag = req.scope === 'Range' ? '--range' : '--ip';
  const cscliArgs = [
    'decisions', 'add',
    targetFlag, req.value,
    '--duration', STATIC_BAN_DURATION,
    '--reason', scenario,
    '--type', 'ban',
  ];
  const { stdout, stderr } = await cscliExec(kc, podName, cscliArgs);
  return { message: (stdout + stderr).trim().slice(0, 500) };
}

export async function deleteDecisionById(
  kubeconfigPath: string | undefined,
  id: number,
): Promise<{ message: string; deleted: number }> {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('invalid decision id');
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);
  const { stdout, stderr } = await cscliExec(kc, podName, ['decisions', 'delete', '--id', String(id)]);
  const combined = (stdout + stderr).trim();
  // cscli prints "N decision(s) deleted" — extract the count for the UI.
  const match = combined.match(/(\d+)\s+decision\(s\)\s+deleted/);
  const deleted = match ? Number(match[1]) : 0;
  return { message: combined.slice(0, 500), deleted };
}

/**
 * Prune bouncers whose last_pull is older than `olderThanSeconds`.
 *
 * Why this exists: the maxlerebourg Traefik bouncer plugin doesn't
 * send a stable name. CrowdSec auto-creates a new bouncer entry
 * `traefik@<pod-ip>` for each unique source IP. Every Traefik pod
 * restart leaves the old entry behind in CrowdSec's SQLite forever —
 * by design, CrowdSec doesn't auto-prune. Without periodic cleanup
 * `cscli bouncers list` accumulates dozens of zombies and the
 * Banned-IPs status panel shows a confusing "8 online / 31 total".
 *
 * This wraps `cscli bouncers prune -d <olderThanSeconds>s --force`.
 * Returns the parsed pruned-count + the raw cscli output.
 *
 * `--force` is required for unattended use (cscli normally prompts
 * for y/n confirmation). The duration MUST be > the bouncer's
 * `updateIntervalSeconds` (60s in our config); we default to 24h
 * which is well above the noise floor.
 */
export async function pruneStaleBouncers(
  kubeconfigPath: string | undefined,
  olderThanSeconds: number = 24 * 60 * 60,
): Promise<{ message: string; pruned: number; olderThanSeconds: number }> {
  if (!Number.isInteger(olderThanSeconds) || olderThanSeconds < 60) {
    // Defence: never prune anything more recent than 60s. The
    // updateIntervalSeconds for the bouncer plugin is 60s; pruning
    // anything younger would catch live bouncers that just happened
    // to be between pulls.
    throw new Error('olderThanSeconds must be ≥ 60');
  }
  const kc = createKubeConfig(kubeconfigPath);
  const podName = await findCrowdsecPodName(kc);

  // Count BEFORE → run prune → count AFTER. cscli's prune output
  // format varies across versions ("No bouncers to prune.", a TABLE
  // of pruned bouncers, "Successfully deleted N bouncers" suffix
  // line, etc.) and the count can land beyond the 500-char message
  // slice. The before/after diff is bulletproof and version-agnostic.
  const beforeCount = await countBouncers(kc, podName);
  const duration = `${olderThanSeconds}s`;
  const { stdout, stderr } = await cscliExec(kc, podName, ['bouncers', 'prune', '-d', duration, '--force']);
  const afterCount = await countBouncers(kc, podName);
  const pruned = Math.max(0, beforeCount - afterCount);

  const combined = (stdout + stderr).trim();
  return { message: combined.slice(0, 500), pruned, olderThanSeconds };
}

/**
 * Helper for pruneStaleBouncers: returns the total bouncer count
 * regardless of staleness. Used to compute pruned-count via before/after
 * diff (more reliable than parsing cscli's variable output format).
 */
async function countBouncers(kc: k8s.KubeConfig, podName: string): Promise<number> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['bouncers', 'list', '-o', 'json']);
    const parsed = parseCscliJson<unknown>(stdout);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// ─── Status / coverage ─────────────────────────────────────────────────

// cscli emits snake_case (last_pull, last_push, ip_address) for bouncers
// but camelCase (machineId, ipAddress) for machines — confirmed against
// CrowdSec v1.7.0. Earlier versions of this code assumed the camelCase
// shape for both and every bouncer rendered as offline.
interface CscliMachineRow {
  machineId?: string;
  ipAddress?: string;
  last_push?: string;
  isValidated?: boolean;
}
interface CscliBouncerRow {
  name?: string;
  ip_address?: string;
  type?: string;
  last_pull?: string;
  revoked?: boolean;
}

const PULL_FRESHNESS_MS = 5 * 60_000;

async function fetchMachinesAndBouncers(kc: k8s.KubeConfig, podName: string): Promise<{
  machines: CrowdsecMachine[]; bouncers: CrowdsecBouncer[];
}> {
  const [machinesRes, bouncersRes] = await Promise.allSettled([
    cscliExec(kc, podName, ['machines', 'list', '-o', 'json']),
    cscliExec(kc, podName, ['bouncers', 'list', '-o', 'json']),
  ]);
  const machines: CrowdsecMachine[] = [];
  const bouncers: CrowdsecBouncer[] = [];
  if (machinesRes.status === 'fulfilled') {
    try {
      const parsed = parseCscliJson<CscliMachineRow[]>(machinesRes.value.stdout);
      for (const m of parsed) {
        machines.push({
          name: String(m.machineId ?? ''),
          ipAddress: String(m.ipAddress ?? ''),
          lastHeartbeatAt: m.last_push ?? null,
          online: typeof m.last_push === 'string' && (Date.now() - new Date(m.last_push).getTime()) < PULL_FRESHNESS_MS,
        });
      }
    } catch { /* swallow — machines list is best-effort */ }
  }
  if (bouncersRes.status === 'fulfilled') {
    try {
      const parsed = parseCscliJson<CscliBouncerRow[]>(bouncersRes.value.stdout);
      for (const b of parsed) {
        if (b.revoked) continue;
        bouncers.push({
          name: String(b.name ?? ''),
          ipAddress: String(b.ip_address ?? ''),
          type: String(b.type ?? ''),
          lastApiPullAt: b.last_pull ?? null,
          online: typeof b.last_pull === 'string' && (Date.now() - new Date(b.last_pull).getTime()) < PULL_FRESHNESS_MS,
        });
      }
    } catch { /* swallow */ }
  }
  return { machines, bouncers };
}

async function fetchCapiStatus(kc: k8s.KubeConfig, podName: string): Promise<{ authenticated: boolean; pullEnabled: boolean }> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['capi', 'status']);
    return {
      authenticated: /successfully interact with Central API/i.test(stdout),
      pullEnabled: /Pulling community blocklist is enabled/i.test(stdout),
    };
  } catch {
    return { authenticated: false, pullEnabled: false };
  }
}

/**
 * Aggregate decision counts broken down by origin. Used to surface
 * "Community blocklist: N IPs" in the status panel.
 *
 * Uses `cscli metrics show decisions -o json` because the output is
 * AGGREGATE COUNTS (not the full decision list) — scales cleanly to
 * a 6M-entry community blocklist without OOM-ing cscliExec's stdout
 * buffer. Format:
 *   { "decisions": { "<reason>": { "<origin>": { "<action>": N }}}}
 *
 * Returns null on parse failure so callers can render "unknown"
 * rather than incorrect zeros.
 */
async function fetchDecisionCounts(kc: k8s.KubeConfig, podName: string): Promise<{
  total: number;
  byOrigin: Record<string, number>;
  communityBlocklist: number;
} | null> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['metrics', 'show', 'decisions', '-o', 'json']);
    const parsed = parseCscliJson<{ decisions?: Record<string, Record<string, Record<string, number>>> }>(stdout);
    const tree = parsed.decisions ?? {};
    let total = 0;
    const byOrigin: Record<string, number> = {};
    for (const reason of Object.values(tree)) {
      for (const [origin, actions] of Object.entries(reason)) {
        for (const count of Object.values(actions)) {
          const n = Number(count);
          if (!Number.isFinite(n)) continue;
          total += n;
          byOrigin[origin] = (byOrigin[origin] ?? 0) + n;
        }
      }
    }
    return {
      total,
      byOrigin,
      // CAPI = Central API = the community blocklist (CrowdSec terminology).
      // Operators see this as "Community blocklist" in the UI.
      communityBlocklist: byOrigin.CAPI ?? 0,
    };
  } catch {
    return null;
  }
}

async function fetchScenariosCount(kc: k8s.KubeConfig, podName: string): Promise<number> {
  try {
    const { stdout } = await cscliExec(kc, podName, ['scenarios', 'list', '-o', 'json']);
    const parsed = parseCscliJson<Record<string, unknown[]> | unknown[]>(stdout);
    if (Array.isArray(parsed)) return parsed.length;
    // cscli sometimes wraps in { scenarios: [...] }
    const scen = (parsed as { scenarios?: unknown[] }).scenarios;
    return Array.isArray(scen) ? scen.length : 0;
  } catch {
    return 0;
  }
}

async function fetchCoverage(kc: k8s.KubeConfig): Promise<CrowdsecCoverage> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  let traefikPodsTotal = 0;
  let traefikPodsCovered = 0;
  let modsecPodsTotal = 0;
  let nodesTotal = 0;
  try {
    const ds = await (apps as unknown as {
      readNamespacedDaemonSet: (args: { namespace: string; name: string }) => Promise<{
        status?: { numberAvailable?: number; numberReady?: number; desiredNumberScheduled?: number };
      }>;
    }).readNamespacedDaemonSet({ namespace: TRAEFIK_NAMESPACE, name: TRAEFIK_DAEMONSET });
    traefikPodsTotal = Number(ds.status?.desiredNumberScheduled ?? 0);
    // "Covered" = ready (every ready Traefik pod has the crowdsec middleware
    // loaded via the cluster-wide Middleware resource — see
    // k8s/base/traefik/middlewares-crowdsec.yaml).
    traefikPodsCovered = Number(ds.status?.numberReady ?? 0);
  } catch { /* swallow — return zeros */ }
  try {
    const modsecPods = await (core as unknown as {
      listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
        items: { status?: { phase?: string } }[];
      }>;
    }).listNamespacedPod({ namespace: TRAEFIK_NAMESPACE, labelSelector: MODSEC_LABEL_SELECTOR });
    modsecPodsTotal = (modsecPods.items ?? []).filter((p) => p.status?.phase === 'Running').length;
  } catch { /* swallow */ }
  try {
    const nodes = await (core as unknown as {
      listNode: () => Promise<{ items: { status?: { conditions?: { type?: string; status?: string }[] } }[] }>;
    }).listNode();
    nodesTotal = (nodes.items ?? []).filter((n) =>
      n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    ).length;
  } catch { /* swallow */ }
  return { traefikPodsTotal, traefikPodsCovered, modsecPodsTotal, nodesTotal };
}

export async function getStatus(kubeconfigPath: string | undefined): Promise<CrowdsecStatus> {
  const kc = createKubeConfig(kubeconfigPath);
  // Fail soft per component — a single cscli error shouldn't blank the
  // whole status banner.
  const health = await lapiHealth();
  let podName: string | null = null;
  try { podName = await findCrowdsecPodName(kc); } catch { /* leave null */ }

  const [coverage, capi, machinesBouncers, scenariosLoaded, decisionCounts] = await Promise.all([
    fetchCoverage(kc),
    podName ? fetchCapiStatus(kc, podName) : Promise.resolve({ authenticated: false, pullEnabled: false }),
    podName ? fetchMachinesAndBouncers(kc, podName) : Promise.resolve({ machines: [], bouncers: [] }),
    podName ? fetchScenariosCount(kc, podName) : Promise.resolve(0),
    podName ? fetchDecisionCounts(kc, podName) : Promise.resolve(null),
  ]);

  return {
    lapiHealthy: health.healthy,
    lapiError: health.error,
    capiAuthenticated: capi.authenticated,
    communityBlocklistEnabled: capi.pullEnabled,
    machines: machinesBouncers.machines,
    bouncers: machinesBouncers.bouncers,
    scenariosLoaded,
    coverage,
    decisionCounts,
  };
}

// ─── Test seams (exported for unit tests) ──────────────────────────────

export const __test = {
  parseLapiDecision,
  parseDurationToAbsolute,
  MANUAL_BAN_REASON_PREFIX,
  // Self-heal entrypoints exposed for unit tests. lapiGet is the hot
  // path; reregisterPlatformApiBouncer is the helper it calls on 403.
  lapiGet,
  reregisterPlatformApiBouncer,
  // Reset coalescing state between tests so a 403 in test N doesn't
  // share the inFlightReregister promise from test N-1.
  resetInFlightReregister: (): void => {
    inFlightReregister = null;
  },
};
