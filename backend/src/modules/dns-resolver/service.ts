/**
 * Unified DNS resolver for every platform-initiated lookup.
 *
 * BEFORE THIS MODULE there were two independent resolver paths:
 *
 *   domains/verification.ts  → `import dns from 'node:dns/promises'`, i.e. the
 *                              POD resolver: CoreDNS → node /etc/resolv.conf →
 *                              whatever owns it (on a mesh-joined node, the
 *                              NetBird agent rewrites that file).
 *   mail-admin/deliverability.ts → a private `externalDnsServers()` hardcoded
 *                              to 1.1.1.1 / 8.8.8.8.
 *
 * So two lookups of the same name could legitimately disagree, and the
 * operator had no way to see or change either. This module makes the resolver
 * one explicit, operator-visible setting.
 *
 * Modes:
 *   host   — inherit the pod resolver (previous verification behaviour).
 *   custom — up to 4 explicit upstreams (IPv4 and/or IPv6), bypassing CoreDNS.
 */

import dnsPromises, { Resolver } from 'node:dns/promises';
import dns from 'node:dns';
import { eq, inArray } from 'drizzle-orm';
import {
  dnsResolverSettingsSchema,
  type DnsResolverSettings,
  type DnsResolverStatus,
  MAX_DNS_RESOLVER_SERVERS,
} from '@insula/api-contracts';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export const DNS_RESOLVER_MODE_KEY = 'dns_resolver_mode';
export const DNS_RESOLVER_SERVERS_KEY = 'dns_resolver_servers';

/**
 * The lookup surface platform code needs. Structural on purpose: both
 * `node:dns/promises` and a configured `Resolver` satisfy it, so a call site
 * can default to the pod resolver and be handed a custom one without changing
 * shape — and a test can pass a stub with no c-ares involved at all.
 */
export interface DnsLike {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  resolveNs(hostname: string): Promise<string[]>;
  resolveCname(hostname: string): Promise<string[]>;
}

/**
 * Short, like system-settings: with N replicas only the pod that handled the
 * PUT drops its cache, so a long TTL turns "operator changed the resolver"
 * into flaky behaviour as requests round-robin.
 */
const CACHE_TTL_MS = 5_000;

/**
 * A blackholed upstream must not hang a verification request. c-ares retries
 * `tries` times with `timeout` ms each, so worst case here is ~10s per lookup
 * rather than the default ~75s.
 */
const RESOLVER_TIMEOUT_MS = 5_000;
const RESOLVER_TRIES = 2;

export const DEFAULT_DNS_RESOLVER_SETTINGS: DnsResolverSettings = { mode: 'host', servers: [] };

interface CacheEntry {
  settings: DnsResolverSettings;
  resolver: DnsLike;
  at: number;
}
let cache: CacheEntry | null = null;

/** Test seam — drop the memoised settings + resolver. */
export function resetDnsResolverCache(): void {
  cache = null;
}

/**
 * Warm the cache at boot so the SYNC accessor below has something to return
 * before the first lookup. Safe to call repeatedly; failures are swallowed
 * because a cold cache degrades to previous behaviour rather than breaking.
 */
export async function primeDnsResolverCache(db: Database): Promise<void> {
  try {
    await getDnsResolverSettings(db);
  } catch {
    /* cold cache → callers fall back to their own defaults */
  }
}

/**
 * Synchronous view of the configured upstreams, for call sites that have no
 * `db` handle (mail deliverability's default dependency functions).
 *
 * Returns null in `host` mode or when the cache is cold — callers MUST then
 * keep their own default. In particular mail must NOT fall back to the pod
 * resolver: routing PTR lookups through CoreDNS is what made a correctly
 * configured staging cluster report the wrong PTR on 2026-05-27, because
 * CoreDNS's automatic node-name records shadowed the real answer. `host` mode
 * therefore leaves mail on its explicit external resolver.
 */
export function getCachedCustomServers(): string[] | null {
  if (!cache) return null;
  if (cache.settings.mode !== 'custom') return null;
  return cache.settings.servers.length > 0 ? [...cache.settings.servers] : null;
}

/**
 * The addresses the POD inherited. Reported to the UI so `host` mode is not a
 * black box — an operator can see that it currently means "the mesh resolver"
 * without shelling into a pod.
 */
export function hostResolverServers(): string[] {
  try {
    return dns.getServers();
  } catch {
    return [];
  }
}

export async function getDnsResolverSettings(db: Database): Promise<DnsResolverSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.settings;

  // A settings read must never be able to break every DNS lookup the platform
  // makes. If the row is unreadable — DB blip, migration mid-flight, a caller
  // holding a stub db — degrade to `host`, which is exactly the behaviour
  // domain verification had before this module existed.
  let settings: DnsResolverSettings;
  try {
    const rows = await db
      .select()
      .from(platformSettings)
      .where(inArray(platformSettings.key, [DNS_RESOLVER_MODE_KEY, DNS_RESOLVER_SERVERS_KEY]));

    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    settings = parseStoredSettings(byKey.get(DNS_RESOLVER_MODE_KEY), byKey.get(DNS_RESOLVER_SERVERS_KEY));
  } catch {
    settings = DEFAULT_DNS_RESOLVER_SETTINGS;
  }

  cache = { settings, resolver: buildResolver(settings), at: now };
  return settings;
}

/**
 * Stored values are parsed defensively: a hand-edited or half-written row must
 * degrade to `host` (the safe, previous behaviour) rather than throw on every
 * DNS lookup the platform makes.
 */
function parseStoredSettings(rawMode: string | undefined, rawServers: string | undefined): DnsResolverSettings {
  let servers: unknown = [];
  if (rawServers) {
    try {
      servers = JSON.parse(rawServers);
    } catch {
      servers = [];
    }
  }
  const parsed = dnsResolverSettingsSchema.safeParse({ mode: rawMode ?? 'host', servers });
  return parsed.success ? parsed.data : DEFAULT_DNS_RESOLVER_SETTINGS;
}

function buildResolver(settings: DnsResolverSettings): DnsLike {
  // `host` mode returns the node:dns/promises default export itself — the pod
  // resolver, byte-for-byte the behaviour verification had before this module
  // existed. Constructing a fresh Resolver would be *almost* the same thing
  // (c-ares also reads resolv.conf) but not identical: it would not follow a
  // process-wide dns.setServers(), and it opens a channel we do not need.
  if (settings.mode !== 'custom' || settings.servers.length === 0) {
    return dnsPromises;
  }
  const r = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: RESOLVER_TRIES });
  r.setServers([...settings.servers]);
  return r;
}

/**
 * The resolver every platform lookup should use. Memoised with the settings so
 * we are not building a c-ares channel per request.
 */
export async function getPlatformResolver(db: Database): Promise<DnsLike> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.resolver;
  await getDnsResolverSettings(db); // repopulates `cache`
  return cache!.resolver;
}

export async function updateDnsResolverSettings(
  db: Database,
  input: unknown,
): Promise<DnsResolverSettings> {
  // Throws ZodError on bad input; the route layer maps it to a 400.
  const settings = dnsResolverSettingsSchema.parse(input);

  // `host` mode keeps the list rather than discarding it, so an operator can
  // toggle back to `custom` without retyping four addresses.
  const rows: Array<{ key: string; value: string }> = [
    { key: DNS_RESOLVER_MODE_KEY, value: settings.mode },
    { key: DNS_RESOLVER_SERVERS_KEY, value: JSON.stringify(settings.servers) },
  ];

  for (const row of rows) {
    await db
      .insert(platformSettings)
      .values(row)
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: row.value } });
  }

  cache = { settings, resolver: buildResolver(settings), at: Date.now() };
  return settings;
}

export async function getDnsResolverStatus(db: Database): Promise<DnsResolverStatus> {
  const settings = await getDnsResolverSettings(db);
  const hostServers = hostResolverServers();
  return {
    mode: settings.mode,
    servers: settings.servers,
    // In `host` mode the platform genuinely does not choose the addresses, so
    // effectiveServers is empty rather than a guess — the UI shows hostServers
    // next to the option instead.
    effectiveServers: settings.mode === 'custom' ? settings.servers : [],
    hostServers,
    maxServers: MAX_DNS_RESOLVER_SERVERS,
  };
}

/**
 * One-shot connectivity probe for the admin UI's "Test" button: resolve a
 * well-known name through the CANDIDATE servers without persisting them, so an
 * operator cannot lock the platform onto a blackholed upstream.
 */
export async function probeDnsResolver(
  servers: readonly string[],
  probeName = 'example.com',
): Promise<{ ok: boolean; detail: string }> {
  const r = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
  if (servers.length > 0) r.setServers([...servers]);
  try {
    const addrs = await r.resolve4(probeName);
    return { ok: true, detail: `resolved ${probeName} → ${addrs.slice(0, 3).join(', ')}` };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    return { ok: false, detail: `lookup of ${probeName} failed${code ? ` (${code})` : ''}` };
  }
}

/** Narrow helper so callers can drop `eq` import churn. */
export async function readRawSetting(db: Database, key: string): Promise<string | undefined> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value;
}
