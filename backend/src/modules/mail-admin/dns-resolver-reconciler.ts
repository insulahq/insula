/**
 * Keeps Stalwart's DNS resolver at one in-flight query (`x:DnsResolver.concurrency`).
 *
 * Why: Stalwart 0.16 builds its DNSSEC-validating resolver from the same options
 * as the plain one, and hickory-dns aborts its TCP retry when more than one
 * concurrently-queried nameserver answers with a TRUNCATED UDP response
 * (hickory-dns#3963, open; Stalwart #3316). A pod gets two nameservers on any
 * dual-stack cluster — the cluster DNS service's IPv4 and IPv6 addresses — so
 * every lookup whose chain carries a DNSKEY RRset over 1232 bytes failed with
 * "DNSSEC validation failed": on production, outbound mail to every `.na`
 * domain (`na.` DNSKEY 1681 B), plus `.org` (1349 B) and `.co.za` (`za.`
 * 1611 B), sat in the queue for days. With one query in flight a truncated
 * answer is always retried over TCP on the same server.
 *
 * Cost: no parallel hedge between the nameservers — a dead one picked first
 * costs a timeout before failover (hickory then prefers the server that answers).
 *
 * Only `concurrency` is written; the resolver type and its other settings stay
 * the operator's. `STALWART_DNS_RESOLVER_CONCURRENCY` overrides the target (once
 * hickory's fix ships, 2 restores the parallel hedge). Safe on every replica:
 * the write is idempotent and only happens when the value differs.
 */

import { mailLogger } from '../../shared/mail-logger.js';
import { safeTick } from '../../shared/safe-tick.js';
import { JmapError } from '../stalwart-jmap/client.js';
import { resolveTransport, type ImapConcurrencyDeps, type ResolvedTransport } from './imap-concurrency.js';

const log = mailLogger().child({ module: 'mail-admin-dns-resolver' });

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';
/** Stalwart admin account ID — fixed constant, matches bootstrap.sh. */
const ADMIN_ACCOUNT_ID = 'd333333';

export const DNS_RESOLVER_RECONCILER_TICK_MS = 10 * 60 * 1000;
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;

export type DnsResolverReconcilerDeps = ImapConcurrencyDeps;

export interface DnsResolverTickResult {
  readonly outcome: 'updated' | 'unchanged';
  readonly prior: number;
  readonly current: number;
  /** Whether Stalwart confirmed the ReloadSettings action (else: next restart). */
  readonly reloaded: boolean;
}

/** The target value: 1, or a whole number 1–16 from STALWART_DNS_RESOLVER_CONCURRENCY. */
export function desiredResolverConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STALWART_DNS_RESOLVER_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONCURRENCY) {
    log.warn({ value: raw }, `STALWART_DNS_RESOLVER_CONCURRENCY must be a whole number 1-${MAX_CONCURRENCY}; using ${DEFAULT_CONCURRENCY}`);
    return DEFAULT_CONCURRENCY;
  }
  return n;
}

/** One tick. Exported for tests; throws on a malformed Stalwart answer (safeTick logs it). */
export async function runDnsResolverReconcilerTick(
  deps: DnsResolverReconcilerDeps = {},
  desired: number = desiredResolverConcurrency(),
): Promise<DnsResolverTickResult> {
  const t = await resolveTransport(deps);
  const prior = await readConcurrency(t);
  if (prior === desired) return { outcome: 'unchanged', prior, current: prior, reloaded: false };

  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:DnsResolver/set', { accountId: ADMIN_ACCOUNT_ID, update: { singleton: { concurrency: desired } } }, 's'],
      // The resolvers are built from the settings (SmtpConfig::parse), so a
      // settings reload applies the change without restarting the mail server.
      ['x:Action/set', { accountId: ADMIN_ACCOUNT_ID, create: { r: { '@type': 'ReloadSettings' } } }, 'r'],
    ],
  });
  const setArgs = res.methodResponses.find((m) => m[2] === 's')?.[1] as { updated?: Record<string, unknown> } | undefined;
  if (!setArgs?.updated || !('singleton' in setArgs.updated)) {
    throw new JmapError('x:DnsResolver/set did not update the singleton', 'malformedResponse', res.methodResponses);
  }
  const reloadArgs = res.methodResponses.find((m) => m[2] === 'r')?.[1] as
    { created?: Record<string, unknown>; notCreated?: Record<string, unknown> | null } | undefined;
  const reloaded = Boolean(reloadArgs?.created && 'r' in reloadArgs.created);
  if (reloaded) {
    log.info({ prior, current: desired }, `Stalwart DNS resolver concurrency ${prior} → ${desired}`);
  } else {
    log.warn({ prior, current: desired, reload: reloadArgs ?? null },
      `Stalwart DNS resolver concurrency set ${prior} → ${desired}, but ReloadSettings did not run — it applies at the next Stalwart restart`);
  }
  return { outcome: 'updated', prior, current: desired, reloaded };
}

async function readConcurrency(t: ResolvedTransport): Promise<number> {
  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [['x:DnsResolver/get', { accountId: ADMIN_ACCOUNT_ID, ids: ['singleton'] }, 'g']],
  });
  const list = (res.methodResponses[0]?.[1] as { list?: unknown })?.list;
  const raw = Array.isArray(list) ? (list[0] as { concurrency?: unknown } | undefined)?.concurrency : undefined;
  if (typeof raw !== 'number') {
    throw new JmapError('x:DnsResolver/get returned no singleton concurrency — Stalwart bootstrap may not be complete',
      'malformedResponse', res.methodResponses);
  }
  return raw;
}

/** Start the reconciler: one tick now, then every 10 minutes. Returns a stop function. */
export function startDnsResolverReconciler(
  deps: DnsResolverReconcilerDeps = {},
  tickMs: number = DNS_RESOLVER_RECONCILER_TICK_MS,
): () => void {
  const tick = async (): Promise<void> => { await runDnsResolverReconcilerTick(deps); };
  safeTick('dns-resolver-reconciler', tick, log);
  const timer = setInterval(() => safeTick('dns-resolver-reconciler', tick, log), tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
