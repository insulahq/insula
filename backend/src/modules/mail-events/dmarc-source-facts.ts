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
import { sql } from 'drizzle-orm';
import type { DmarcSourceSummary } from '@insula/api-contracts';
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
/** The relay query behind the recommendation; past it the recommendation counts everything. */
const RELAY_STATEMENT_TIMEOUT_MS = 5_000;
const CLUSTER_TTL_MS = 60_000;
const CACHE_MAX = 5_000;

type PtrAnswer = { readonly name: string | null; readonly status: 'found' | 'none' };
interface Cached<V> { readonly at: number; readonly ttl: number; readonly value: V }
interface RelayCounts { readonly signed: number; readonly evidenced: number; readonly evidencedFail: number }

const ptrCache = new Map<string, Cached<PtrAnswer>>();
const spfCache = new Map<string, Cached<boolean | null>>();
const signedCache = new Map<string, Cached<Map<string, RelayCounts>>>();
const relayCopyCache = new Map<string, Cached<Map<string, RelayCopies>>>();
let clusterCache: { readonly at: number; readonly list: BlockList } | null = null;

/** Test seam. */
export function resetDmarcSourceFactCaches(): void {
  ptrCache.clear();
  spfCache.clear();
  signedCache.clear();
  relayCopyCache.clear();
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

async function clusterList(deps: Pick<SourceFactsDeps, 'clusterAddresses' | 'log'>, now: number): Promise<BlockList | null> {
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
 * Per policy domain and source address, from the stored reports (`raw`, the
 * only place that keeps a record's DKIM domain, selector and recipient
 * domain):
 *
 *   signed         messages that carried our signature, whatever the verdict;
 *   evidenced      those of them that show the address passed on OUR mail: the
 *                  signature verified, or the same report holds our own copy —
 *                  another address's record for the same recipient domain with
 *                  the same count, passing both SPF and DKIM with our signature;
 *   evidencedFail  the evidenced ones that failed DMARC there.
 *
 * "Our signature" is the domain's (or the From subdomain's) DKIM signature
 * with a platform selector: the fixed A/B pair, plus the domain's active
 * selector (a Stalwart-created one until its first rotation). Never "every
 * `_domainkey` record in the zone": a tenant publishes its other providers'
 * keys there too (Microsoft 365's `selector1`), and their mail is not ours.
 *
 * One statement for any number of domains: the admin overview asks for all.
 */
export async function relayEvidence(
  db: Database,
  policyDomains: readonly string[],
  opts: { since: Date; tenantId?: string },
): Promise<Map<string, Map<string, RelayCounts>>> {
  const out = new Map<string, Map<string, RelayCounts>>();
  const wanted = [...new Set(policyDomains.map((d) => d.toLowerCase()))];
  if (wanted.length === 0) return out;
  const doms = sql.join(wanted.map((d) => sql`${d}`), sql`, `);
  // A record's DKIM results whose domain and selector are ours. dkimResults is
  // an object keyed "0", "1", … like records, or an array.
  const ourDkim = sql`
    SELECT value AS d FROM jsonb_each(CASE WHEN jsonb_typeof(recs.rec->'dkimResults') = 'object'
                                           THEN recs.rec->'dkimResults' ELSE '{}'::jsonb END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(recs.rec->'dkimResults') = 'array'
                                                THEN recs.rec->'dkimResults' ELSE '[]'::jsonb END)`;
  const isOurs = sql`lower(y.d->>'domain') IN (recs.dom, lower(recs.rec->>'headerFrom'))
                     AND (lower(y.d->>'selector') IN (${DKIM_SELECTOR_A}, ${DKIM_SELECTOR_B})
                          OR lower(y.d->>'selector') IN (SELECT a.sel FROM active a WHERE a.dom = recs.dom))`;
  const res = await db.execute<{ dom: string; ip: string; signed: number; evidenced: number; evidenced_fail: number }>(sql`
    WITH active AS (
      SELECT lower(d.domain_name) AS dom, lower(ed.dkim_active_selector) AS sel
        FROM email_domains ed JOIN domains d ON d.id = ed.domain_id
       WHERE lower(d.domain_name) IN (${doms}) AND ed.dkim_active_selector IS NOT NULL
    ), recs AS (
      SELECT r.id AS report_id, r.policy_domain AS dom, x.rec,
             left(x.rec->>'sourceIp', 64) AS ip,
             lower(x.rec->>'envelopeTo') AS env_to,
             CASE WHEN jsonb_typeof(x.rec->'count') = 'number' AND (x.rec->>'count')::numeric > 0
                  THEN floor((x.rec->>'count')::numeric) ELSE 0 END AS n,
             (lower(x.rec->>'evaluatedDkim') = 'pass' AND lower(x.rec->>'evaluatedSpf') = 'pass') AS both_pass,
             (lower(x.rec->>'evaluatedDkim') = 'pass' OR lower(x.rec->>'evaluatedSpf') = 'pass') AS dmarc_pass
        FROM email_dmarc_reports r
        CROSS JOIN LATERAL (
          SELECT value AS rec FROM jsonb_each(CASE WHEN jsonb_typeof(r.raw->'report'->'records') = 'object'
                                                   THEN r.raw->'report'->'records' ELSE '{}'::jsonb END)
          UNION ALL
          SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.raw->'report'->'records') = 'array'
                                                      THEN r.raw->'report'->'records' ELSE '[]'::jsonb END)
        ) x
       WHERE r.policy_domain IN (${doms})
         AND r.received_at >= ${opts.since.toISOString()}::timestamptz
         ${opts.tenantId ? sql`AND r.tenant_id = ${opts.tenantId}` : sql``}
    ), signed AS (
      SELECT recs.report_id, recs.dom, recs.ip, recs.env_to, recs.n, recs.both_pass, recs.dmarc_pass,
             EXISTS (SELECT 1 FROM (${ourDkim}) y WHERE ${isOurs} AND lower(y.d->>'result') = 'pass') AS verified
        FROM recs
       WHERE EXISTS (SELECT 1 FROM (${ourDkim}) y WHERE ${isOurs})
    ), copies AS (
      -- Our own copies: passing SPF and DKIM with our signature. A record that
      -- is its own copy is verified anyway, so no address test is needed.
      SELECT DISTINCT report_id, coalesce(env_to, '') AS env_to, n
        FROM signed WHERE both_pass AND verified
    ), judged AS (
      SELECT s.*, (s.verified OR c.report_id IS NOT NULL) AS evidenced
        FROM signed s
        LEFT JOIN copies c
          ON c.report_id = s.report_id AND c.env_to = coalesce(s.env_to, '') AND c.n = s.n
    )
    SELECT dom, ip,
           SUM(n)::bigint AS signed,
           SUM(CASE WHEN evidenced THEN n ELSE 0 END)::bigint AS evidenced,
           SUM(CASE WHEN evidenced AND NOT dmarc_pass THEN n ELSE 0 END)::bigint AS evidenced_fail
      FROM judged
     GROUP BY dom, ip
  `);
  for (const r of res.rows ?? []) {
    if (!r.dom || !r.ip) continue;
    const byIp = out.get(r.dom) ?? new Map<string, RelayCounts>();
    byIp.set(r.ip, {
      signed: Number(r.signed) || 0,
      evidenced: Number(r.evidenced) || 0,
      evidencedFail: Number(r.evidenced_fail) || 0,
    });
    out.set(r.dom, byIp);
  }
  return out;
}

/** relayEvidence for one domain: its sources' counts, keyed by address. */
export async function signedMessagesBySource(
  db: Database,
  policyDomain: string,
  opts: { since: Date; tenantId?: string },
): Promise<Map<string, RelayCounts>> {
  return (await relayEvidence(db, [policyDomain], opts)).get(policyDomain.toLowerCase()) ?? new Map();
}

/** What a domain's recommendation leaves out: the proven relay copies. */
export interface RelayCopies {
  /** Relayed copies, passing or failing DMARC at the receiver. */
  readonly messages: number;
  readonly passMessages: number;
  /** Per relay address, its relayed copies that failed. */
  readonly failByIp: ReadonlyMap<string, number>;
  /** Relay addresses the copies came from. */
  readonly sources: number;
}

/**
 * Proven relay copies per domain, for the policy recommendation: messages from
 * addresses that are not ours (global, not a cluster node) and that the
 * reports show passing on mail we signed — see relayEvidence. Null when either
 * half is unknown (node list or reports unreadable): the recommendation then
 * counts everything, as it did before relays were recognised.
 */
export async function provenRelayCopies(
  db: Database,
  policyDomains: readonly string[],
  opts: { since: Date; tenantId?: string },
  deps: Pick<SourceFactsDeps, 'clusterAddresses' | 'log' | 'now'>,
): Promise<Map<string, RelayCopies> | null> {
  const now = (deps.now ?? Date.now)();
  // Shared by the overview and the apply check, so the two judge alike within
  // the minute; and the statement is not re-run on every page view.
  const key = `${opts.tenantId ?? '*'}|${Math.floor(opts.since.getTime() / 60_000)}|${[...new Set(policyDomains.map((d) => d.toLowerCase()))].sort().join(',')}`;
  const hit = fresh(relayCopyCache, key, now);
  if (hit) return hit;
  try {
    const cluster = await clusterList(deps, now);
    if (!cluster) return null;
    // A real statement timeout: rejecting a promise would leave the query
    // running and holding a pool connection.
    const evidence = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${RELAY_STATEMENT_TIMEOUT_MS}`));
      return relayEvidence(tx as unknown as Database, policyDomains, opts);
    });
    const out = new Map<string, RelayCopies>();
    for (const [dom, byIp] of evidence) {
      let messages = 0;
      let passMessages = 0;
      const failByIp = new Map<string, number>();
      for (const [ip, c] of byIp) {
        const a = globalAddress(ip);
        if (!a || cluster.check(a.ip, a.family) || c.evidenced === 0) continue;
        messages += c.evidenced;
        passMessages += c.evidenced - c.evidencedFail;
        failByIp.set(ip, c.evidencedFail);
      }
      if (failByIp.size > 0) out.set(dom, { messages, passMessages, failByIp, sources: failByIp.size });
    }
    remember(relayCopyCache, key, { at: now, ttl: SIGNED_TTL_MS, value: out });
    return out;
  } catch (err) {
    deps.log?.warn({ err: err instanceof Error ? err.message : String(err) },
      'dmarc summary: relay copies unknown; the recommendation counts every message');
    return null;
  }
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
      const relay = signed ? signed.get(r.sourceIp) ?? { signed: 0, evidenced: 0, evidencedFail: 0 } : null;
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
