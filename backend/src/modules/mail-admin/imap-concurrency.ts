/**
 * Transient IMAP-concurrency elevation around tenant-bundle mailbox
 * migration jobs.
 *
 * Why this module exists:
 *
 *   Stalwart 0.16's `x:Imap.maxConcurrent` setting controls the
 *   maximum number of in-flight IMAP requests *per user*. Empirically
 *   the effective cap is roughly `maxConcurrent / 16` concurrent
 *   connections per user — at the default `16` only a single
 *   connection's worth of in-flight commands is admitted; a second
 *   LOGIN as the same user fails with
 *   `NO [LIMIT] Too many concurrent requests`.
 *
 *   The mailbox backup/restore tooling
 *   (`images/mail-backup-tools/imap-restore.py --workers 4`) opens
 *   four concurrent IMAP connections per user to amortize Stalwart's
 *   per-message processing pipeline (FTS, threading, ACL) across
 *   MULTIAPPEND batches. Without elevation the worker pool collapses
 *   to one effective connection and restore throughput halves.
 *
 *   We don't want to leave `maxConcurrent` permanently at 64 because
 *   it inflates the per-user worst-case memory bound for buffered
 *   APPEND literals: `maxConcurrent × maxRequestSize` per active user
 *   = 64 × 100 MiB = 6.4 GiB if a single user ever pushed 64 parallel
 *   100 MiB APPENDs. In practice no interactive client does that, but
 *   the default-16 floor is what the upstream Stalwart team picked
 *   for memory hygiene, and we should sit at the default when there
 *   is no active migration.
 *
 * Lifecycle:
 *
 *   1. Capture (tenant-bundles/components/mailboxes.ts) and restore
 *      (backup-restore/executors/mailboxes-by-address.ts) both call
 *      `ensureImapMaxConcurrentAtLeast(MIGRATION)` immediately after
 *      acquiring their cluster-concurrency slot, BEFORE creating the
 *      mail-backup-tools Job.
 *
 *   2. The 5-min `imap-concurrency-reverter` scheduler (started from
 *      backend index.ts) checks `tenant_bundle_in_flight` every tick;
 *      if there are zero active rows for `mailboxes` /
 *      `mailbox-worker`, it sets `maxConcurrent` back to the default
 *      (16). Otherwise it no-ops.
 *
 *   3. Best-effort throughout: a Stalwart outage during elevation
 *      logs a warning but does NOT fail the bundle Job. The Job
 *      will then run against whatever `maxConcurrent` is currently
 *      set; worst case is degraded throughput, not data loss.
 *
 * Idempotency:
 *
 *   `ensureImapMaxConcurrentAtLeast` reads the current value first
 *   and skips the write if it is already at or above the target. This
 *   keeps the per-job overhead at ~50 ms (a single x:Imap/get) when
 *   the cluster is already elevated by another in-flight job.
 *
 * Cross-replica safety:
 *
 *   Two platform-api replicas can elevate concurrently — both writes
 *   are idempotent SETs to the same value (64), no race. The revert
 *   scheduler runs on every replica but checks a DB-backed in-flight
 *   gauge before writing, so the last-replica-to-finish wins; if a
 *   third bundle Job starts while the revert is in progress, the
 *   elevation from step 1 above re-asserts 64 before any IMAP work
 *   begins.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { JmapError } from '../stalwart-jmap/client.js';

const log = mailLogger().child({ module: 'mail-admin-imap-concurrency' });

/** Stalwart's documented default. Match it on revert. */
export const IMAP_MAX_CONCURRENT_DEFAULT = 16;

/**
 * Elevated value used during mailbox migration Jobs. Roughly 4
 * concurrent IMAP connections per user, which matches the
 * imap-restore.py default `--workers 4`.
 *
 * If the restore tool's `--workers` value changes, update this
 * constant in lock-step (and consider whether to bump
 * `maxRequestSize` × `maxConcurrent` budget — see header comment).
 */
export const IMAP_MAX_CONCURRENT_MIGRATION = 64;

/** Reverter tick cadence. 5 min trades reaction time for negligible
 * Stalwart load (one x:Imap/get + at most one x:Imap/set per tick). */
export const IMAP_CONCURRENCY_REVERTER_TICK_MS = 5 * 60 * 1000;

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';

/** Stalwart admin account ID — fixed constant, matches bootstrap.sh. */
const ADMIN_ACCOUNT_ID = 'd333333';

const STALWART_MGMT_URL =
  process.env.STALWART_MGMT_URL ?? 'http://stalwart-mgmt.mail.svc.cluster.local:8080';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ImapConcurrencyDeps {
  /** Override the JMAP transport. Production callers leave undefined; tests inject. */
  readonly jmapPost?: (auth: string, body: unknown) => Promise<JmapResponseShape>;
  /** Override creds (tests). Production reads from credentials.ts. */
  readonly authHeader?: string;
  readonly baseUrl?: string;
}

export interface JmapResponseShape {
  readonly methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
}

export interface EnsureResult {
  readonly prior: number;
  readonly current: number;
  readonly bumped: boolean;
}

export async function ensureImapMaxConcurrentAtLeast(
  target: number,
  deps: ImapConcurrencyDeps = {},
): Promise<EnsureResult> {
  const transport = await resolveTransport(deps);
  const prior = await readMaxConcurrent(transport);
  if (prior >= target) {
    return { prior, current: prior, bumped: false };
  }
  await writeMaxConcurrent(transport, target);
  log.info(
    { prior, target, reason: 'pre-mailbox-job elevation' },
    `x:Imap.maxConcurrent ${prior} → ${target}`,
  );
  return { prior, current: target, bumped: true };
}

/**
 * Force x:Imap.maxConcurrent to an exact value. Use only from the
 * revert scheduler — production callers should prefer
 * `ensureImapMaxConcurrentAtLeast` to keep semantics monotonic.
 */
export async function setImapMaxConcurrent(
  value: number,
  deps: ImapConcurrencyDeps = {},
): Promise<{ prior: number; current: number }> {
  const transport = await resolveTransport(deps);
  const prior = await readMaxConcurrent(transport);
  if (prior === value) {
    return { prior, current: prior };
  }
  await writeMaxConcurrent(transport, value);
  return { prior, current: value };
}

/**
 * One tick of the revert scheduler. Idempotent; never throws (errors
 * are logged and swallowed so a Stalwart blip doesn't crash the
 * scheduler).
 */
export async function runImapConcurrencyReverterTick(
  db: Database,
  deps: ImapConcurrencyDeps = {},
): Promise<void> {
  try {
    // Initial gate: skip the JMAP round-trip entirely when jobs are
    // active. This is the common case (we only need to write when the
    // cluster has truly gone idle since the last tick).
    const initial = (await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM tenant_bundle_in_flight
       WHERE component IN ('mailboxes', 'mailbox-worker')
    `)) as unknown as { rows: Array<{ n: number }> };
    if ((initial.rows[0]?.n ?? 0) > 0) return;

    const transport = await resolveTransport(deps);
    const prior = await readMaxConcurrent(transport);
    if (prior <= IMAP_MAX_CONCURRENT_DEFAULT) return;

    // Second gate: re-check the count immediately before the write.
    // Without this, a new mailbox Job that acquired its
    // tenant_bundle_in_flight slot between our initial SELECT and the
    // x:Imap/get would have its elevation reverted right under it,
    // costing it ~5 min of degraded throughput until the next tick. The
    // narrow window is the (x:Imap/get + write planning) span — usually
    // <50 ms — but the second read closes it for ~zero extra cost.
    const recheck = (await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM tenant_bundle_in_flight
       WHERE component IN ('mailboxes', 'mailbox-worker')
    `)) as unknown as { rows: Array<{ n: number }> };
    if ((recheck.rows[0]?.n ?? 0) > 0) {
      log.info(
        'imap-concurrency reverter: job slot acquired during tick — skipping revert (will retry next interval)',
      );
      return;
    }

    await writeMaxConcurrent(transport, IMAP_MAX_CONCURRENT_DEFAULT);
    log.info(
      { prior, target: IMAP_MAX_CONCURRENT_DEFAULT, reason: 'idle: no in-flight mailbox jobs' },
      `x:Imap.maxConcurrent ${prior} → ${IMAP_MAX_CONCURRENT_DEFAULT} (reverter tick)`,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'imap-concurrency reverter tick failed — will retry next interval',
    );
  }
}

export function startImapConcurrencyReverter(
  db: Database,
  deps: ImapConcurrencyDeps = {},
  tickMs: number = IMAP_CONCURRENCY_REVERTER_TICK_MS,
): () => void {
  // Run one tick immediately on start to converge from any stale
  // elevated state left over from a previous platform-api crash.
  void runImapConcurrencyReverterTick(db, deps);
  const timer = setInterval(() => void runImapConcurrencyReverterTick(db, deps), tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── Internal: JMAP plumbing ─────────────────────────────────────────────────

interface ResolvedTransport {
  readonly authHeader: string;
  readonly baseUrl: string;
  readonly jmapPost: (auth: string, body: unknown) => Promise<JmapResponseShape>;
}

async function resolveTransport(deps: ImapConcurrencyDeps): Promise<ResolvedTransport> {
  const baseUrl = deps.baseUrl ?? STALWART_MGMT_URL;
  const authHeader = deps.authHeader ?? (await loadAdminAuthHeader());
  const jmapPost = deps.jmapPost ?? makeFetchJmapPost(baseUrl);
  return { authHeader, baseUrl, jmapPost };
}

async function loadAdminAuthHeader(): Promise<string> {
  const { readStalwartCredentials } = await import('./credentials.js');
  const { username, password } = readStalwartCredentials(process.env);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function makeFetchJmapPost(baseUrl: string): (auth: string, body: unknown) => Promise<JmapResponseShape> {
  return async (auth, body) => {
    const res = await fetch(`${baseUrl}/jmap/`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JmapError(
        `JMAP POST failed: HTTP ${res.status}`,
        'httpError',
        { status: res.status, body: text.slice(0, 500) },
      );
    }
    const data = (await res.json()) as unknown;
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
    ) {
      throw new JmapError(
        'JMAP response missing methodResponses',
        'malformedResponse',
        data,
      );
    }
    return data as JmapResponseShape;
  };
}

async function readMaxConcurrent(t: ResolvedTransport): Promise<number> {
  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Imap/get', { accountId: ADMIN_ACCOUNT_ID, ids: ['singleton'], properties: ['maxConcurrent'] }, 'c0'],
    ],
  });
  const args = res.methodResponses[0]?.[1] as { list?: unknown };
  const list = args?.list;
  if (!Array.isArray(list) || list.length === 0) {
    throw new JmapError(
      'x:Imap/get returned no singleton — Stalwart bootstrap may not be complete',
      'malformedResponse',
      args,
    );
  }
  const raw = (list[0] as { maxConcurrent?: unknown }).maxConcurrent;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new JmapError(
      `x:Imap/get returned non-positive maxConcurrent: ${String(raw)}`,
      'malformedResponse',
      list[0],
    );
  }
  return Math.floor(n);
}

async function writeMaxConcurrent(t: ResolvedTransport, value: number): Promise<void> {
  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Imap/set', { accountId: ADMIN_ACCOUNT_ID, update: { singleton: { maxConcurrent: value } } }, 'c0'],
    ],
  });
  const first = res.methodResponses[0];
  if (!first) {
    throw new JmapError('x:Imap/set: empty methodResponses', 'malformedResponse', res);
  }
  const [method, args] = first;
  if (method === 'error') {
    throw new JmapError(
      `x:Imap/set returned method-level error: ${JSON.stringify(args).slice(0, 200)}`,
      'methodError',
      args,
    );
  }
  const notUpdated = (args as { notUpdated?: Record<string, unknown> | null }).notUpdated;
  if (notUpdated && Object.keys(notUpdated).length > 0) {
    throw new JmapError(
      `x:Imap/set notUpdated: ${JSON.stringify(notUpdated).slice(0, 200)}`,
      'methodError',
      notUpdated,
    );
  }
}
