/**
 * SPF check_host() (RFC 7208 §4) — does a domain's CURRENT SPF record allow an
 * address to send for it?
 *
 * Used by the DMARC source list's SPF badge. A report says what the receiver
 * concluded for the envelope sender it saw, and a forwarder rewrites that to
 * its own domain (Gmail's forwarding shows `gmail.com`), so the report cannot
 * say whether the policy domain's own record lists the server. This asks DNS.
 *
 * Implemented: `all`, `include`, `a`, `mx`, `ip4`, `ip6`, `exists` (without
 * macros), `redirect=`, qualifiers, dual CIDR lengths, and the 10-lookup and
 * 2-void-lookup limits. NOT implemented, reported as `unknown` instead of
 * guessed: macros (`%{i}` …) — they need the envelope sender and HELO name,
 * which a report does not carry — and the deprecated `ptr` mechanism.
 *
 * The record is the tenant's to write, and this runs inside an API request,
 * so the work is capped beyond what RFC 7208 asks: a record longer than any
 * real one, or an evaluation needing more DNS queries than the RFC's limits
 * plausibly allow (an `mx` term's address lookups are not counted by the
 * RFC), stops with `unknown`.
 */
import { BlockList, isIP } from 'node:net';

export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';
/** `unknown`: the record uses a term this check does not evaluate. */
export type SpfCheckResult = SpfResult | 'unknown';

export interface SpfDns {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
}

const MAX_LOOKUPS = 10;
const MAX_VOID_LOOKUPS = 2;
const MAX_MX_NAMES = 10;
/** Every DNS query of one evaluation, whatever the RFC counts. */
const MAX_QUERIES = 30;
/** A real SPF record is a few hundred characters; providers stay far under these. */
const MAX_RECORD_CHARS = 2_048;
const MAX_TERMS = 128;

/** NXDOMAIN / no records of that type — an answer, unlike a timeout or SERVFAIL. */
function isNoRecord(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

/**
 * Lookups shared across every address checked against one domain: the record
 * tree is the same for all of them, so N addresses cost the DNS of one.
 */
export function memoSpfDns(dns: SpfDns): SpfDns {
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    let p = memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = run();
      memo.set(key, p);
    }
    return p;
  };
  return {
    resolveTxt: (n) => once(`txt:${n}`, () => dns.resolveTxt(n)),
    resolve4: (n) => once(`a:${n}`, () => dns.resolve4(n)),
    resolve6: (n) => once(`aaaa:${n}`, () => dns.resolve6(n)),
    resolveMx: (n) => once(`mx:${n}`, () => dns.resolveMx(n)),
  };
}

/** Thrown to end the whole evaluation with a result. */
class Verdict extends Error {
  constructor(readonly result: SpfCheckResult) {
    super(result);
  }
}

interface Ctx {
  readonly dns: SpfDns;
  readonly ip: string;
  readonly family: 4 | 6;
  lookups: number;
  voids: number;
  queries: number;
}

/** Before each DNS query: past the budget, stop without a verdict. */
function countQuery(ctx: Ctx): void {
  ctx.queries += 1;
  if (ctx.queries > MAX_QUERIES) throw new Verdict('unknown');
}

function countLookup(ctx: Ctx): void {
  ctx.lookups += 1;
  if (ctx.lookups > MAX_LOOKUPS) throw new Verdict('permerror');
}

function countVoid(ctx: Ctx): void {
  ctx.voids += 1;
  if (ctx.voids > MAX_VOID_LOOKUPS) throw new Verdict('permerror');
}

function normDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, '');
}

/** A domain-spec this check can use as-is: no macros, something left after normalising. */
function plainDomain(spec: string): string {
  if (spec.includes('%')) throw new Verdict('unknown');
  const d = normDomain(spec);
  if (d.length === 0) throw new Verdict('permerror');
  return d;
}

/** `::ffff:192.0.2.1` is checked as the IPv4 address it carries (RFC 7208 §5). */
export function canonicalIp(ip: string): { ip: string; family: 4 | 6 } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  const candidate = mapped ? mapped[1] : ip.trim();
  const fam = isIP(candidate);
  if (fam === 4) return { ip: candidate, family: 4 };
  if (fam === 6) return { ip: candidate, family: 6 };
  return null;
}

function inSubnet(ctx: Ctx, network: string, prefix: number): boolean {
  const fam = isIP(network);
  if (fam !== ctx.family) return false;
  const list = new BlockList();
  list.addSubnet(network, prefix, fam === 4 ? 'ipv4' : 'ipv6');
  return list.check(ctx.ip, ctx.family === 4 ? 'ipv4' : 'ipv6');
}

/** `name/24//64` → name + the prefix that applies to the address being checked. */
function splitCidr(arg: string, ctx: Ctx): { name: string; prefix: number } {
  const m = /^(.*?)(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/.exec(arg);
  // `host/123` must not backtrack into a host name containing a slash.
  if (!m || m[1].includes('/')) throw new Verdict('permerror');
  const v4 = m[2] === undefined ? 32 : Number(m[2]);
  const v6 = m[3] === undefined ? 128 : Number(m[3]);
  if (v4 > 32 || v6 > 128) throw new Verdict('permerror');
  return { name: m[1], prefix: ctx.family === 4 ? v4 : v6 };
}

async function addresses(ctx: Ctx, name: string): Promise<string[]> {
  countQuery(ctx);
  try {
    const list = ctx.family === 4 ? await ctx.dns.resolve4(name) : await ctx.dns.resolve6(name);
    if (list.length === 0) countVoid(ctx);
    return list;
  } catch (err) {
    if (err instanceof Verdict) throw err;
    if (isNoRecord(err)) {
      countVoid(ctx);
      return [];
    }
    throw new Verdict('temperror');
  }
}

async function spfRecord(ctx: Ctx, domain: string): Promise<string | null> {
  let txt: string[][];
  countQuery(ctx);
  try {
    txt = await ctx.dns.resolveTxt(domain);
  } catch (err) {
    if (isNoRecord(err)) return null;
    throw new Verdict('temperror');
  }
  const records = txt.map((parts) => parts.join('')).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (records.length > 1) throw new Verdict('permerror');
  return records[0] ?? null;
}

const QUALIFIED: Record<string, SpfResult> = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };

async function mechanismMatches(ctx: Ctx, domain: string, name: string, arg: string | null): Promise<boolean> {
  switch (name) {
    case 'all':
      return true;
    case 'include': {
      if (!arg) throw new Verdict('permerror');
      countLookup(ctx);
      const r = await evaluate(ctx, plainDomain(arg));
      if (r === 'pass') return true;
      if (r === 'fail' || r === 'softfail' || r === 'neutral') return false;
      if (r === 'temperror' || r === 'unknown') throw new Verdict(r);
      throw new Verdict('permerror'); // none, permerror
    }
    case 'a': {
      countLookup(ctx);
      const { name: target, prefix } = splitCidr(arg ?? '', ctx);
      const host = target ? plainDomain(target) : domain;
      return (await addresses(ctx, host)).some((a) => inSubnet(ctx, a, prefix));
    }
    case 'mx': {
      countLookup(ctx);
      const { name: target, prefix } = splitCidr(arg ?? '', ctx);
      const host = target ? plainDomain(target) : domain;
      let mx: Array<{ exchange: string }>;
      countQuery(ctx);
      try {
        mx = await ctx.dns.resolveMx(host);
        if (mx.length === 0) countVoid(ctx);
      } catch (err) {
        if (err instanceof Verdict) throw err;
        if (!isNoRecord(err)) throw new Verdict('temperror');
        countVoid(ctx);
        mx = [];
      }
      if (mx.length > MAX_MX_NAMES) throw new Verdict('permerror');
      for (const rec of mx) {
        const exchange = normDomain(rec.exchange);
        if (!exchange) continue; // null MX (RFC 7505): accepts no mail, names no host
        if ((await addresses(ctx, exchange)).some((a) => inSubnet(ctx, a, prefix))) return true;
      }
      return false;
    }
    case 'ip4':
    case 'ip6': {
      const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(arg ?? '');
      const fam = m ? isIP(m[1]) : 0;
      if (!m || fam !== (name === 'ip4' ? 4 : 6)) throw new Verdict('permerror');
      const prefix = m[2] === undefined ? (fam === 4 ? 32 : 128) : Number(m[2]);
      if (prefix > (fam === 4 ? 32 : 128)) throw new Verdict('permerror');
      return inSubnet(ctx, m[1], prefix);
    }
    case 'exists': {
      if (!arg) throw new Verdict('permerror');
      countLookup(ctx);
      const host = plainDomain(arg);
      countQuery(ctx);
      try {
        const list = await ctx.dns.resolve4(host);
        if (list.length === 0) countVoid(ctx);
        return list.length > 0;
      } catch (err) {
        if (err instanceof Verdict) throw err;
        if (!isNoRecord(err)) throw new Verdict('temperror');
        countVoid(ctx);
        return false;
      }
    }
    case 'ptr':
      countLookup(ctx);
      throw new Verdict('unknown');
    default:
      throw new Verdict('permerror');
  }
}

async function evaluate(ctx: Ctx, domain: string): Promise<SpfCheckResult> {
  const record = await spfRecord(ctx, domain);
  if (record === null) return 'none';
  const terms = record.trim().split(/\s+/).slice(1);
  if (record.length > MAX_RECORD_CHARS || terms.length > MAX_TERMS) throw new Verdict('unknown');
  let redirect: string | null = null;

  for (const term of terms) {
    const modifier = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(term);
    if (modifier) {
      if (modifier[1].toLowerCase() === 'redirect') {
        if (redirect !== null) throw new Verdict('permerror');
        redirect = modifier[2];
      }
      continue; // exp= and unknown modifiers do not change the result
    }
    const q = '+-~?'.includes(term[0]) ? term[0] : '+';
    const body = q === term[0] ? term.slice(1) : term;
    const m = /^([a-z][a-z0-9_.-]*)(?:[:/](.*))?$/i.exec(body);
    if (!m) throw new Verdict('permerror');
    const name = m[1].toLowerCase();
    // `a/24` carries its CIDR after a slash, `a:host/24` after the colon.
    const arg = m[2] === undefined ? null : body[name.length] === '/' ? `/${m[2]}` : m[2];
    if (await mechanismMatches(ctx, domain, name, arg)) return QUALIFIED[q];
  }

  if (redirect !== null) {
    countLookup(ctx);
    const r = await evaluate(ctx, plainDomain(redirect));
    return r === 'none' ? 'permerror' : r;
  }
  return 'neutral';
}

/** check_host(ip, domain). Never throws: every failure is a result. */
export async function checkSpf(dns: SpfDns, ip: string, domain: string): Promise<SpfCheckResult> {
  const addr = canonicalIp(ip);
  if (!addr) return 'permerror';
  const ctx: Ctx = { dns, ip: addr.ip, family: addr.family, lookups: 0, voids: 0, queries: 0 };
  try {
    return await evaluate(ctx, normDomain(domain));
  } catch (err) {
    if (err instanceof Verdict) return err.result;
    return 'temperror';
  }
}
