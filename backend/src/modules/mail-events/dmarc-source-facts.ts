/**
 * What the DMARC source list says about a sending address besides its counts:
 * the badges (CLUSTER, SPF, RELAY) and its reverse DNS.
 *
 * Why: the list read as "every server that sent as you", so a recipient's own
 * mail filter re-delivering a message we sent looked like a stranger forging
 * the domain. On a production domain all four non-cluster addresses were
 * receiving-side servers — Gmail forwarding, an ISP forwarder, a Microsoft 365
 * customer's inline scanner (Microsoft reports every message twice: once from
 * our server, passing, and once from the scanner, failing where it added a
 * banner), and a filtering MX in front of another tenant of Microsoft's.
 *
 *   CLUSTER  the address belongs to one of this cluster's nodes.
 *   SPF      the policy domain's CURRENT SPF record allows the address
 *            (spf-check.ts — the report cannot say: a forwarder rewrites the
 *            envelope sender the receiver checked).
 *   RELAY    not ours, yet passing on mail we signed. A failed signature
 *            alone is no evidence — anyone can paste a `DKIM-Signature: d=…;
 *            s=dkim-1` header onto forged mail — so it takes either our
 *            signature VERIFYING from that address, or the receiver reporting,
 *            in the same report, our own copy of the same messages (same
 *            recipient domain, same count, passing SPF and DKIM). The second is
 *            the inline-scanner case. A filter whose first hop the receiver
 *            never saw, and that breaks every signature, gets no badge: from
 *            the report alone it cannot be told from a forger.
 *
 * Bounded throughout: per-lookup timeout, an overall deadline after which
 * outstanding queries are cancelled, caps on the SPF work a tenant-written
 * record can cause, no lookups for addresses no report source can have
 * (private, loopback, link-local), and caches. Anything that did not finish,
 * or failed, reads as unknown — never as "no", and never as an error for the
 * list itself.
 */
import { BlockList } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { DmarcSourceSummary } from '@insula/api-contracts';
import { domains, emailDomains } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { DKIM_SELECTOR_A, DKIM_SELECTOR_B } from '../email-dkim/selectors.js';
import { canonicalIp, checkSpf, memoSpfDns, type SpfDns } from './spf-check.js';
import type { DmarcSourceCounts } from './dmarc-summary.js';

export interface SourceFactsDns extends SpfDns {
  reverse(ip: string): Promise<string[]>;
  /** Cancels outstanding queries (node's Resolver has it). */
  cancel?(): void;
}

export interface SourceFactsDeps {
  readonly dns: SourceFactsDns;
  /** Every address of every cluster node. Throws when the node list cannot be read. */
  readonly clusterAddresses: () => Promise<readonly string[]>;
  readonly log?: { warn(obj: unknown, msg: string): void };
  readonly now?: () => number;
}

/** One lookup: a slow name server must not hold the page. */
const LOOKUP_TIMEOUT_MS = 2_500;
/** Everything of one request. What has not finished by then is unknown. */
const DEADLINE_MS = 6_000;
const PTR_CONCURRENCY = 16;
/** The SPF check runs for the worst-first rows only; the rest read as unknown. */
const SPF_MAX_SOURCES = 100;
const PTR_TTL_MS = 60 * 60_000;
const PTR_NONE_TTL_MS = 10 * 60_000;
const SPF_TTL_MS = 5 * 60_000;
/** A temperror or a capped evaluation is asked again soon, not on every page view. */
const SPF_UNKNOWN_TTL_MS = 60_000;
const SIGNED_TTL_MS = 60_000;
const CLUSTER_TTL_MS = 60_000;
const CACHE_MAX = 5_000;

type PtrAnswer = { readonly name: string | null; readonly status: 'found' | 'none' };
interface Cached<V> { readonly at: number; readonly ttl: number; readonly value: V }
interface RelayCounts { readonly signed: number; readonly evidenced: number }

const ptrCache = new Map<string, Cached<PtrAnswer>>();
const spfCache = new Map<string, Cached<boolean | null>>();
const signedCache = new Map<string, Cached<Map<string, RelayCounts>>>();
let clusterCache: { readonly at: number; readonly list: BlockList } | null = null;

/** Test seam. */
export function resetDmarcSourceFactCaches(): void {
  ptrCache.clear();
  spfCache.clear();
  signedCache.clear();
  clusterCache = null;
}

function fresh<V>(cache: Map<string, Cached<V>>, key: string, now: number): V | undefined {
  const hit = cache.get(key);
  return hit && now - hit.at < hit.ttl ? hit.value : undefined;
}

/** Insert or refresh; evicts the oldest entry only to make room for a NEW key. */
function remember<V>(cache: Map<string, Cached<V>>, key: string, value: Cached<V>): void {
  if (!cache.delete(key) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), ms);
    // Through a then(), so a synchronous throw becomes a rejection too.
    Promise.resolve().then(run).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e: unknown) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Each DNS call under the per-lookup timeout. */
function bounded(dns: SourceFactsDns): SourceFactsDns {
  return {
    resolveTxt: (n) => withTimeout(() => dns.resolveTxt(n), LOOKUP_TIMEOUT_MS),
    resolve4: (n) => withTimeout(() => dns.resolve4(n), LOOKUP_TIMEOUT_MS),
    resolve6: (n) => withTimeout(() => dns.resolve6(n), LOOKUP_TIMEOUT_MS),
    resolveMx: (n) => withTimeout(() => dns.resolveMx(n), LOOKUP_TIMEOUT_MS),
    reverse: (ip) => withTimeout(() => dns.reverse(ip), LOOKUP_TIMEOUT_MS),
  };
}

/**
 * Addresses no DMARC report source can genuinely have. A report is mail a
 * tenant can send to its own `rua=` address, so its source IPs are input: a
 * forged 10.x or mesh address must not become a probe of the cluster's node
 * list, of an internal resolver's PTR names, or of internal names in SPF.
 * (The documentation ranges stay allowed; they route nowhere and the tests
 * use them.)
 */
const NOT_GLOBAL = (() => {
  const list = new BlockList();
  for (const [net, len] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) list.addSubnet(net, len, 'ipv4');
  for (const [net, len] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
    list.addSubnet(net, len, 'ipv6');
  }
  return list;
})();

/** The address in canonical form when it is a global unicast one, else null. */
function globalAddress(raw: string): { ip: string; family: 'ipv4' | 'ipv6' } | null {
  const c = canonicalIp(raw);
  if (!c) return null;
  const family = c.family === 4 ? 'ipv4' : 'ipv6';
  return NOT_GLOBAL.check(c.ip, family) ? null : { ip: c.ip, family };
}

async function clusterList(deps: SourceFactsDeps, now: number): Promise<BlockList | null> {
  if (clusterCache && now - clusterCache.at < CLUSTER_TTL_MS) return clusterCache.list;
  try {
    const list = new BlockList();
    for (const raw of await withTimeout(() => deps.clusterAddresses(), DEADLINE_MS)) {
      const c = canonicalIp(raw);
      if (c) list.addAddress(c.ip, c.family === 4 ? 'ipv4' : 'ipv6');
    }
    clusterCache = { at: now, list };
    return list;
  } catch (err) {
    deps.log?.warn({ err: err instanceof Error ? err.message : String(err) },
      'dmarc sources: cluster node addresses unreadable; CLUSTER and RELAY left unknown');
    return null;
  }
}

/**
 * DKIM selectors the platform signs with for this domain: the fixed A/B pair
 * plus the domain's active selector (a Stalwart-created one until its first
 * rotation). Never "every `_domainkey` record in the zone": a tenant publishes
 * its other providers' keys there too (Microsoft 365's `selector1`), and their
 * mail is not ours.
 */
async function ourSelectors(db: Database, policyDomain: string): Promise<string[]> {
  const rows = await db
    .select({ selector: emailDomains.dkimActiveSelector })
    .from(emailDomains)
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(eq(sql`lower(${domains.domainName})`, policyDomain));
  const out = new Set<string>([DKIM_SELECTOR_A, DKIM_SELECTOR_B]);
  for (const r of rows) if (r.selector) out.add(r.selector.toLowerCase());
  return [...out];
}

/**
 * Per source address, from the stored reports (`raw`, the only place that
 * keeps a record's DKIM domain, selector and recipient domain):
 *
 *   signed     messages that carried our signature, whatever the verdict;
 *   evidenced  those of them that show the address passed on OUR mail: the
 *              signature verified, or the same report holds our own copy —
 *              another address's record for the same recipient domain with
 *              the same count, passing both SPF and DKIM with our signature.
 *
 * The scope — domain, window, tenant — is the source list's, so the counts
 * describe the same reports.
 */
export async function signedMessagesBySource(
  db: Database,
  policyDomain: string,
  opts: { since: Date; tenantId?: string },
): Promise<Map<string, RelayCounts>> {
  const domain = policyDomain.toLowerCase();
  const selectors = await ourSelectors(db, domain);
  const ours = sql.join(selectors.map((s) => sql`${s}`), sql`, `);
  // A record's DKIM results whose domain and selector are ours. dkimResults is
  // an object keyed "0", "1", … like records, or an array.
  const ourDkim = sql`
    SELECT value AS d FROM jsonb_each(CASE WHEN jsonb_typeof(recs.rec->'dkimResults') = 'object'
                                           THEN recs.rec->'dkimResults' ELSE '{}'::jsonb END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(recs.rec->'dkimResults') = 'array'
                                                THEN recs.rec->'dkimResults' ELSE '[]'::jsonb END)`;
  const isOurs = sql`lower(y.d->>'domain') IN (${domain}, lower(recs.rec->>'headerFrom'))
                     AND lower(y.d->>'selector') IN (${ours})`;
  const res = await db.execute<{ ip: string; signed: number; evidenced: number }>(sql`
    WITH recs AS (
      SELECT r.id AS report_id, x.rec,
             left(x.rec->>'sourceIp', 64) AS ip,
             lower(x.rec->>'envelopeTo') AS env_to,
             CASE WHEN jsonb_typeof(x.rec->'count') = 'number' AND (x.rec->>'count')::numeric > 0
                  THEN floor((x.rec->>'count')::numeric) ELSE 0 END AS n,
             (lower(x.rec->>'evaluatedDkim') = 'pass' AND lower(x.rec->>'evaluatedSpf') = 'pass') AS both_pass
        FROM email_dmarc_reports r
        CROSS JOIN LATERAL (
          SELECT value AS rec FROM jsonb_each(CASE WHEN jsonb_typeof(r.raw->'report'->'records') = 'object'
                                                   THEN r.raw->'report'->'records' ELSE '{}'::jsonb END)
          UNION ALL
          SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.raw->'report'->'records') = 'array'
                                                      THEN r.raw->'report'->'records' ELSE '[]'::jsonb END)
        ) x
       WHERE r.policy_domain = ${domain}
         AND r.received_at >= ${opts.since.toISOString()}::timestamptz
         ${opts.tenantId ? sql`AND r.tenant_id = ${opts.tenantId}` : sql``}
    ), signed AS (
      SELECT recs.report_id, recs.ip, recs.env_to, recs.n, recs.both_pass,
             EXISTS (SELECT 1 FROM (${ourDkim}) y WHERE ${isOurs} AND lower(y.d->>'result') = 'pass') AS verified
        FROM recs
       WHERE EXISTS (SELECT 1 FROM (${ourDkim}) y WHERE ${isOurs})
    )
    SELECT s.ip,
           SUM(s.n)::bigint AS signed,
           SUM(CASE WHEN s.verified OR EXISTS (
                 SELECT 1 FROM signed c
                  WHERE c.report_id = s.report_id AND c.ip IS DISTINCT FROM s.ip
                    AND c.both_pass AND c.verified
                    AND c.env_to IS NOT DISTINCT FROM s.env_to AND c.n = s.n
               ) THEN s.n ELSE 0 END)::bigint AS evidenced
      FROM signed s
     GROUP BY s.ip
  `);
  const out = new Map<string, RelayCounts>();
  for (const r of res.rows ?? []) {
    if (r.ip) out.set(r.ip, { signed: Number(r.signed) || 0, evidenced: Number(r.evidenced) || 0 });
  }
  return out;
}

/** signedMessagesBySource, cached briefly, and null (unknown) when it fails or overruns. */
async function relayCounts(
  db: Database, domain: string, opts: { since: Date; tenantId?: string }, deps: SourceFactsDeps, now: number,
): Promise<Map<string, RelayCounts> | null> {
  // Minute resolution: the window moves with every request, the answer does not.
  const key = `${opts.tenantId ?? '*'}|${domain}|${Math.floor(opts.since.getTime() / 60_000)}`;
  const hit = fresh(signedCache, key, now);
  if (hit) return hit;
  try {
    const value = await withTimeout(() => signedMessagesBySource(db, domain, opts), DEADLINE_MS);
    remember(signedCache, key, { at: now, ttl: SIGNED_TTL_MS, value });
    return value;
  } catch (err) {
    deps.log?.warn({ err: err instanceof Error ? err.message : String(err) },
      'dmarc sources: signed-message counts unavailable; RELAY left unknown');
    return null;
  }
}

async function lookupPtr(dns: SourceFactsDns, ip: string, now: number): Promise<PtrAnswer | null> {
  const hit = fresh(ptrCache, ip, now);
  if (hit) return hit;
  try {
    const names = await dns.reverse(ip);
    const name = names.map((n) => n.replace(/\.$/, '')).find((n) => n.length > 0) ?? null;
    const value: PtrAnswer = name ? { name, status: 'found' } : { name: null, status: 'none' };
    remember(ptrCache, ip, { at: now, ttl: name ? PTR_TTL_MS : PTR_NONE_TTL_MS, value });
    return value;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      const value: PtrAnswer = { name: null, status: 'none' };
      remember(ptrCache, ip, { at: now, ttl: PTR_NONE_TTL_MS, value });
      return value;
    }
    return null; // timeout, SERVFAIL: unknown, and asked again next time
  }
}

async function lookupSpf(dns: SpfDns, domain: string, ip: string, now: number): Promise<boolean | null> {
  const key = `${domain}|${ip}`;
  const hit = spfCache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const r = await checkSpf(dns, ip, domain);
  const value = r === 'pass' ? true
    : r === 'fail' || r === 'softfail' || r === 'neutral' || r === 'none' ? false
      : null;
  remember(spfCache, key, { at: now, ttl: value === null ? SPF_UNKNOWN_TTL_MS : SPF_TTL_MS, value });
  return value;
}

/** Runs `work` over `items` with at most `limit` in flight, ignoring results past `deadline`. */
async function pooled<T, R>(items: readonly T[], limit: number, deadline: Promise<void>,
  work: (item: T) => Promise<R>): Promise<Map<T, R>> {
  const out = new Map<T, R>();
  if (items.length === 0) return out;
  let next = 0;
  let expired = false;
  void deadline.then(() => { expired = true; });
  const worker = async (): Promise<void> => {
    while (!expired && next < items.length) {
      const item = items[next++];
      const r = await work(item);
      if (!expired) out.set(item, r);
    }
  };
  await Promise.race([Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)), deadline]);
  expired = true;
  return out;
}

/** The source rows with their badges and reverse DNS. */
export async function enrichDmarcSources(
  db: Database,
  rows: readonly DmarcSourceCounts[],
  opts: { policyDomain: string; since: Date; tenantId?: string; deps: SourceFactsDeps },
): Promise<DmarcSourceSummary[]> {
  if (rows.length === 0) return [];
  const deps = opts.deps;
  const now = (deps.now ?? Date.now)();
  const domain = opts.policyDomain.toLowerCase();
  const dns = bounded(deps.dns);
  const spfDns = memoSpfDns(dns);

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, DEADLINE_MS); });
  const addr = new Map(rows.map((r) => [r.sourceIp, globalAddress(r.sourceIp)]));
  const lookable = [...new Set(rows.map((r) => addr.get(r.sourceIp)?.ip).filter((ip): ip is string => !!ip))];
  // Rows arrive worst first, so the cap keeps the ones that matter.
  const spfTargets = lookable.slice(0, SPF_MAX_SOURCES);

  try {
    const [cluster, signed, ptrs, spf] = await Promise.all([
      clusterList(deps, now),
      relayCounts(db, domain, { since: opts.since, tenantId: opts.tenantId }, deps, now),
      pooled(lookable, PTR_CONCURRENCY, deadline, (ip) => lookupPtr(dns, ip, now)),
      // One record tree for every address (memoised), so no pool limit is needed.
      pooled(spfTargets, spfTargets.length, deadline, (ip) => lookupSpf(spfDns, domain, ip, now)),
    ]);

    return rows.map((r) => {
      const a = addr.get(r.sourceIp) ?? null;
      const isCluster = a && cluster ? cluster.check(a.ip, a.family) : null;
      const relay = signed ? signed.get(r.sourceIp) ?? { signed: 0, evidenced: 0 } : null;
      const ptr = a ? ptrs.get(a.ip) ?? null : null;
      return {
        ...r,
        reverseDns: ptr?.name ?? null,
        reverseDnsStatus: ptr?.status ?? 'unknown',
        isCluster,
        inSpf: a ? spf.get(a.ip) ?? null : null,
        relayedCount: relay ? relay.signed : null,
        isRelay: isCluster === false && relay !== null && relay.evidenced > 0,
      };
    });
  } finally {
    clearTimeout(timer);
    // Nothing still in flight is waited for; let it stop instead of running on.
    try { deps.dns.cancel?.(); } catch { /* best effort */ }
  }
}

/**
 * Production dependencies: the mail health check's public resolver — the
 * receiver's view, and never CoreDNS, whose synthesised node-name PTRs once
 * shadowed the real ones — and the cluster's node list.
 */
export async function defaultSourceFactDeps(
  kubeconfigPath: string | undefined,
  log?: SourceFactsDeps['log'],
): Promise<SourceFactsDeps> {
  const { externalResolver } = await import('../mail-admin/deliverability.js');
  const resolver = externalResolver();
  return {
    dns: resolver,
    log,
    clusterAddresses: async () => {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const nodes = await createK8sClients(kubeconfigPath).core.listNode({}) as {
        items?: Array<{ status?: { addresses?: Array<{ type?: string; address?: string }> } }>;
      };
      return (nodes.items ?? []).flatMap((n) => (n.status?.addresses ?? [])
        .filter((a) => a.type === 'ExternalIP' || a.type === 'InternalIP')
        .map((a) => a.address ?? '')
        .filter((a) => a.length > 0));
    },
  };
}
