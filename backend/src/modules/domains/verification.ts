import dns from 'node:dns/promises';
import { getPlatformResolver, type DnsLike } from '../dns-resolver/service.js';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VerificationCheck {
  readonly type: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
  /**
   * What the platform required, and what DNS actually returned.
   *
   * These exist so the UI can show the comparison instead of a prose sentence.
   * The NS check used to render its PASS message from the values it FOUND
   * ("NS records correctly delegated to: <whatever was there>"), which reads as
   * confirmation while asserting nothing — that phrasing is what made a
   * vacuously-passing check look convincing on production for months.
   */
  readonly expected?: readonly string[];
  readonly actual?: readonly string[];
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
}

export interface PlatformConfig {
  readonly nameservers: readonly string[];
  readonly ingressHostname: string;
}

export interface PlatformIngressIps {
  readonly v4: Set<string>;
  readonly v6: Set<string>;
  readonly source: 'cluster_nodes' | 'dns' | 'mixed' | 'none';
}

// ─── Platform IP Detector ────────────────────────────────────────────────────

/**
 * Build the set of IPs that identify this platform's ingress.
 *
 * Sources (both merged):
 * 1. All cluster_nodes rows with role in ('server','worker') active in the
 *    last 7 days — uses publicIp for v4.
 * 2. DNS resolution of the ingressBaseDomain — A + AAAA records.
 *
 * Survives empty cluster_nodes table (falls back to DNS-only).
 * Survives DNS failure (falls back to cluster_nodes-only).
 */
export async function getPlatformIngressIps(
  db: Database,
  ingressBaseDomain?: string,
  resolver: DnsLike = dns,
): Promise<PlatformIngressIps> {
  const v4Set = new Set<string>();
  const v6Set = new Set<string>();
  let hasNodes = false;
  let hasDns = false;

  // Source 1: cluster_nodes table
  // Use dynamic imports to keep drizzle-orm out of the top-level imports
  // (the test environment cannot resolve drizzle-orm as a package — see
  // the getPlatformConfig function below for the same pattern).
  try {
    const { clusterNodes } = await import('../../db/schema.js');
    const { and, gt, inArray, ne } = await import('drizzle-orm');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // HIGH fix from code review: explicit role filter — both server and
    // worker run the ingress DaemonSet today, but documenting the intent
    // protects us against a future role (e.g. `storage_only`) that
    // shouldn't accept tenant ingress traffic.
    //
    // ingress_mode='none' is excluded because this set decides whether a
    // cname-mode domain VERIFIES. A node the operator has explicitly taken out
    // of ingress still has a public IP, so counting it meant a customer could
    // point their domain at a node that will never serve their traffic and be
    // told the domain was correctly configured — then get no site. Traefik
    // already refuses to schedule there (the DaemonSet's nodeAffinity excludes
    // `none`), so the two now agree on what "an ingress node" is.
    const nodes = await db
      .select({ publicIp: clusterNodes.publicIp, publicIpv6: clusterNodes.publicIpv6 })
      .from(clusterNodes)
      .where(
        and(
          gt(clusterNodes.lastSeenAt, sevenDaysAgo),
          inArray(clusterNodes.role, ['server', 'worker']),
          ne(clusterNodes.ingressMode, 'none'),
        ),
      );
    for (const node of nodes) {
      // public_ip / public_ipv6 are separate columns (migration 0080) so the
      // family is known, not sniffed. The `includes(':')` test stays as a
      // belt-and-braces guard for legacy rows written before the split, when
      // public_ip was `inet` and could in principle hold either family.
      if (node.publicIp) {
        const ip = String(node.publicIp);
        if (ip.includes(':')) v6Set.add(ip);
        else v4Set.add(ip);
        hasNodes = true;
      }
      if (node.publicIpv6) {
        v6Set.add(String(node.publicIpv6));
        hasNodes = true;
      }
    }
  } catch {
    // cluster_nodes unavailable — will rely on DNS
  }

  // Source 2: DNS resolution of the ingress base domain
  if (ingressBaseDomain) {
    try {
      const [v4Result, v6Result] = await Promise.allSettled([
        resolver.resolve4(ingressBaseDomain),
        resolver.resolve6(ingressBaseDomain),
      ]);
      if (v4Result.status === 'fulfilled') {
        for (const ip of v4Result.value) {
          v4Set.add(ip);
          hasDns = true;
        }
      }
      if (v6Result.status === 'fulfilled') {
        for (const ip of v6Result.value) {
          v6Set.add(ip);
          hasDns = true;
        }
      }
    } catch {
      // DNS resolution failed — cluster_nodes is the only source
    }
  }

  const source: PlatformIngressIps['source'] =
    hasNodes && hasDns ? 'mixed'
    : hasNodes ? 'cluster_nodes'
    : hasDns ? 'dns'
    : 'none';

  return { v4: v4Set, v6: v6Set, source };
}

// ─── DNS Verification Functions ─────────────────────────────────────────────

export async function verifyNsDelegation(
  domain: string,
  expectedNs: readonly string[],
  resolver: DnsLike = dns,
): Promise<VerificationCheck> {
  const normalizedExpected = expectedNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));

  // FAIL CLOSED on an empty expectation. `[].every(...)` is `true`, so with no
  // configured nameservers this check reported PASS for every domain whose NS
  // lookup merely succeeded — it asserted "the domain exists in DNS" while
  // claiming "delegated correctly". On production that marked 11 domains
  // verified, including one delegated to an unrelated third party, and
  // verification gates ACME issuance.
  if (normalizedExpected.length === 0) {
    return {
      type: 'ns_delegation',
      status: 'fail',
      detail: 'No platform nameservers are configured, so delegation cannot be verified. '
        + "Set the NS hostnames on this domain's DNS provider group.",
      expected: [],
      actual: [],
    };
  }

  try {
    const actualNs = await resolver.resolveNs(domain);
    const normalizedActual = actualNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));

    const allMatch = normalizedExpected.every((ns) => normalizedActual.includes(ns));

    return {
      type: 'ns_delegation',
      status: allMatch ? 'pass' : 'fail',
      // Both branches state the EXPECTATION, so a pass is readable as a claim
      // about what was required rather than an echo of what was found.
      detail: allMatch
        ? `Delegated to the expected nameservers: ${normalizedExpected.join(', ')}`
        : `Expected NS: ${normalizedExpected.join(', ')} — found: ${normalizedActual.join(', ') || '(none)'}`,
      expected: normalizedExpected,
      actual: normalizedActual,
    };
  } catch (err) {
    return {
      type: 'ns_delegation',
      status: 'fail',
      detail: `NS lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      expected: normalizedExpected,
      actual: [],
    };
  }
}

/**
 * @deprecated Use verifyResolvesToPlatform for cname-mode domains instead.
 * This function does an exact CNAME match which rejects CDN/proxy setups.
 */
export async function verifyCnameRecord(
  hostname: string,
  expectedTarget: string,
  resolver: DnsLike = dns,
): Promise<VerificationCheck> {
  try {
    const cnames = await resolver.resolveCname(hostname);
    const normalizedCnames = cnames.map((c) => c.toLowerCase().replace(/\.$/, ''));
    const normalizedTarget = expectedTarget.toLowerCase().replace(/\.$/, '');

    const matches = normalizedCnames.includes(normalizedTarget);

    return {
      type: 'cname_record',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `CNAME correctly points to ${normalizedTarget}`
        : `Expected CNAME target: ${normalizedTarget} — found: ${normalizedCnames.join(', ') || 'none'}`,
    };
  } catch (err) {
    return {
      type: 'cname_record',
      status: 'fail',
      detail: `CNAME lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Resolve IPs for a hostname using both A and AAAA queries.
 * resolve4/6 follow CNAME chains transparently.
 * Returns an empty array (and optionally logs into `errors`) if no records exist.
 */
async function resolveAllIps(
  hostname: string,
  errors: string[],
  resolver: DnsLike = dns,
): Promise<{ v4: string[]; v6: string[] }> {
  const [v4Result, v6Result] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);

  const v4: string[] = [];
  const v6: string[] = [];

  if (v4Result.status === 'fulfilled') {
    v4.push(...v4Result.value);
  } else {
    const code = (v4Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`A lookup error: ${v4Result.reason instanceof Error ? v4Result.reason.message : String(v4Result.reason)}`);
    }
  }

  if (v6Result.status === 'fulfilled') {
    v6.push(...v6Result.value);
  } else {
    const code = (v6Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`AAAA lookup error: ${v6Result.reason instanceof Error ? v6Result.reason.message : String(v6Result.reason)}`);
    }
  }

  return { v4, v6 };
}

/**
 * Verify that a customer hostname ultimately resolves to one or more IPs
 * that overlap with the platform's known ingress IPs (from cluster_nodes
 * table + DNS resolution of the ingressBaseDomain).
 *
 * Pass/fail is determined by IP-set intersection — any CDN or proxy chain
 * that ends at the platform's ingress IPs will pass. Checks both v4 and v6.
 *
 * Pre-fetched platformIps can be passed to avoid redundant lookups across
 * multiple domains in the same cron tick.
 */
export async function verifyResolvesToPlatform(
  hostname: string,
  ingressBaseDomain: string,
  db: Database,
  precomputedPlatformIps?: PlatformIngressIps,
  resolver: DnsLike = dns,
): Promise<VerificationCheck> {
  // Get platform IPs (from cache if pre-fetched by cron)
  const platformIps = precomputedPlatformIps ?? await getPlatformIngressIps(db, ingressBaseDomain, resolver);

  if (platformIps.v4.size === 0 && platformIps.v6.size === 0) {
    const detail = platformIps.source === 'none'
      ? `Platform ingress has no resolvable A/AAAA records — operator misconfiguration (ingress_base_domain not set or DNS not resolving)`
      : `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration`;
    return { type: 'cname_to_ingress', status: 'fail', detail, expected: [], actual: [] };
  }

  // Resolve customer hostname IPs (follows CNAME chain transparently)
  const customerErrors: string[] = [];
  const customerIps = await resolveAllIps(hostname, customerErrors, resolver);
  const allCustomerIps = [...customerIps.v4, ...customerIps.v6];

  if (allCustomerIps.length === 0) {
    let detail = `No A/AAAA records resolve for ${hostname}`;
    if (customerErrors.length > 0) {
      detail += ` (${customerErrors.join('; ')})`;
    }
    return {
      type: 'cname_to_ingress', status: 'fail', detail,
      expected: [...platformIps.v4, ...platformIps.v6],
      actual: [],
    };
  }

  // IP-set intersection check — v4 and v6 independently
  const v4Overlap = customerIps.v4.filter((ip) => platformIps.v4.has(ip));
  const v6Overlap = customerIps.v6.filter((ip) => platformIps.v6.has(ip));
  const passes = v4Overlap.length > 0 || v6Overlap.length > 0;

  // Build a friendly CNAME-chain prefix for the detail message (best-effort)
  let chainPrefix = '';
  try {
    const cnames = await resolver.resolveCname(hostname);
    if (cnames.length > 0) {
      chainPrefix = `${hostname} → ${cnames.join(' → ')} → `;
    }
  } catch {
    // CNAME chain is informational only — ignore lookup failures
  }

  const resolvedDisplay = `${chainPrefix}${allCustomerIps.join(', ')}`;
  const platformDisplay = [...platformIps.v4, ...platformIps.v6].join(', ');

  const detail = passes
    ? `${resolvedDisplay} (matches platform IPs: ${[...v4Overlap, ...v6Overlap].join(', ')})`
    : `Resolved IPs (${resolvedDisplay}) do not overlap with platform IPs (${platformDisplay})`;

  return {
    type: 'cname_to_ingress',
    status: passes ? 'pass' : 'fail',
    detail,
    expected: [...platformIps.v4, ...platformIps.v6],
    actual: allCustomerIps,
  };
}

/**
 * Legacy shim — resolves ingress IPs via DNS only (no cluster_nodes lookup).
 * Used by the routes.ts verify endpoint which passes an explicit
 * ingressBaseDomain string. Keep for backwards compat with existing tests.
 *
 * @deprecated Prefer verifyResolvesToPlatform(hostname, ingressBaseDomain, db)
 */
export async function verifyResolvesToIngress(
  hostname: string,
  ingressBaseDomain: string,
  resolver: DnsLike = dns,
): Promise<VerificationCheck> {
  // Resolve ingress base IPs first — if this fails it's an operator config problem
  const ingressErrors: string[] = [];
  const ingressIpsResult = await resolveAllIps(ingressBaseDomain, ingressErrors, resolver);
  const ingressIps = [...ingressIpsResult.v4, ...ingressIpsResult.v6];

  if (ingressIps.length === 0) {
    const detail = ingressErrors.length > 0
      ? `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration (${ingressErrors.join('; ')})`
      : `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration`;
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // Resolve customer hostname IPs (follows CNAME chain transparently)
  const customerErrors: string[] = [];
  const customerIpsResult = await resolveAllIps(hostname, customerErrors, resolver);
  const customerIps = [...customerIpsResult.v4, ...customerIpsResult.v6];

  if (customerIps.length === 0) {
    let detail = `No A/AAAA records resolve for ${hostname}`;
    if (customerErrors.length > 0) {
      detail += ` (${customerErrors.join('; ')})`;
    }
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // IP-set intersection check
  const ingressSet = new Set(ingressIps);
  const overlap = customerIps.filter((ip) => ingressSet.has(ip));
  const passes = overlap.length > 0;

  // Build a friendly CNAME-chain prefix for the detail message (best-effort)
  let chainPrefix = '';
  try {
    const cnames = await resolver.resolveCname(hostname);
    if (cnames.length > 0) {
      chainPrefix = `${hostname} → ${cnames.join(' → ')} → `;
    }
  } catch {
    // CNAME chain is informational only — ignore lookup failures
  }

  const resolvedDisplay = `${chainPrefix}${customerIps.join(', ')}`;

  const detail = passes
    ? `${resolvedDisplay} (matches ingress base IPs: ${[...ingressSet].join(', ')})`
    : `Resolved IPs (${resolvedDisplay}) do not overlap with ingress base IPs (${ingressIps.join(', ')})`;

  return {
    type: 'cname_to_ingress',
    status: passes ? 'pass' : 'fail',
    detail,
  };
}

export async function verifyAxfrSync(
  db: Database,
  domainName: string,
): Promise<VerificationCheck> {
  const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires PLATFORM_ENCRYPTION_KEY env var */;
  try {
    const activeServers = await getActiveServers(db);
    for (const server of activeServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (provider.getZoneAxfrStatus) {
          const axfrStatus = await provider.getZoneAxfrStatus(domainName);
          const serial = axfrStatus.lastSoaSerial;
          const primarySerial = axfrStatus.primarySoaSerial;
          // "Has an SOA record" is not "is synchronised". A slave zone that was
          // created but never transferred, or one that is badly stale, still
          // carries an SOA — so the serial has to be compared against the
          // primary before this can claim sync.
          const inSync = axfrStatus.synced
            && (primarySerial === undefined || serial === primarySerial);
          return {
            type: 'axfr_sync',
            status: inSync ? 'pass' : 'fail',
            detail: !axfrStatus.synced
              ? 'AXFR not yet synced — SOA record not found on the slave'
              : inSync
                ? `AXFR synced — SOA serial ${serial ?? 'unknown'}`
                : `Slave zone is STALE — slave SOA serial ${serial ?? 'unknown'}, primary ${primarySerial}`,
            expected: primarySerial !== undefined ? [`SOA serial ${primarySerial}`] : ['a zone transferred from the primary'],
            actual: serial !== undefined ? [`SOA serial ${serial}`] : ['no SOA on the slave'],
          };
        }
        // No AXFR-status support on this provider. Only powerdns and mock
        // implement getZoneAxfrStatus; rndc/cloudflare/route53/hetzner/cloudns
        // land here. The old fallback asked getZone and passed on the zone
        // merely EXISTING, reported as "Slave zone exists" — presence, not
        // synchronisation, under a check named axfr_sync. Refuse to make a
        // claim the provider cannot support.
        const zone = await provider.getZone(domainName);
        return {
          type: 'axfr_sync',
          status: 'fail',
          detail: zone
            ? `Cannot verify AXFR sync: the ${server.providerType} provider does not report transfer status. `
              + `A slave zone exists (serial ${zone.serial}), but its freshness is unknown.`
            : 'Slave zone not found on DNS server',
          expected: ['a provider that reports AXFR transfer status'],
          actual: [`${server.providerType} (no AXFR status support)`],
        };
      } catch {
        // Try next server
      }
    }
    return {
      type: 'axfr_sync',
      status: 'fail',
      detail: 'No DNS server available to check AXFR status',
    };
  } catch {
    return {
      type: 'axfr_sync',
      status: 'fail',
      detail: 'Failed to check AXFR status — no DNS servers configured',
    };
  }
}

// ─── Main Verification Dispatcher ───────────────────────────────────────────

/**
 * NS hostnames this domain is expected to be delegated to.
 *
 * Reads the domain's DNS provider group, which is the platform's modelled
 * source of truth for nameservers (ADR-022 provider groups). Falls back to the
 * supplied list only when the group has none, and returns an empty array when
 * neither is configured — the caller must fail closed on that, never treat it
 * as "nothing to check".
 *
 * Drizzle is imported dynamically to match the rest of this module: it is not
 * resolvable in the unit-test environment, and a static import here would break
 * every test in the file.
 */
async function getExpectedNameservers(
  db: Database,
  domainName: string,
  fallback: readonly string[],
): Promise<readonly string[]> {
  try {
    const { domains } = await import('../../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ dnsGroupId: domains.dnsGroupId })
      .from(domains)
      .where(eq(domains.domainName, domainName))
      .limit(1);
    const groupId = rows[0]?.dnsGroupId;
    if (groupId) {
      const { getProviderGroupById } = await import('../dns-servers/service.js');
      const group = await getProviderGroupById(db, groupId);
      const ns = group?.nsHostnames ?? [];
      if (ns.length > 0) return ns;
    }
  } catch {
    // DB unavailable or schema unresolvable (unit tests) — use the fallback.
  }
  return fallback;
}

export async function verifyDomain(
  domain: string,
  dnsMode: 'primary' | 'cname' | 'secondary',
  platformConfig: PlatformConfig,
  db: Database,
  precomputedPlatformIps?: PlatformIngressIps,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  // Resolve the operator-configured resolver ONCE per verification and thread
  // it through every lookup. Omitting it here is not a compile error — the
  // params default to the pod resolver — so the setting would silently do
  // nothing. That is precisely the failure this module exists to end.
  const resolver = await getPlatformResolver(db);

  switch (dnsMode) {
    case 'primary': {
      // Group first, env second. The provider group is where this platform
      // MODELS nameservers (dns_provider_groups.ns_hostnames, populated on
      // every real cluster); PLATFORM_NAMESERVERS is a global env var that is
      // read in exactly one place and set in none — no overlay, no bootstrap
      // script, no ConfigMap — so on every cluster it resolved to [] and made
      // the check below vacuous. Reading the per-domain group also gets the
      // answer right when domains sit in different groups, which a single
      // global list cannot express.
      const expectedNs = await getExpectedNameservers(db, domain, platformConfig.nameservers);
      const nsCheck = await verifyNsDelegation(domain, expectedNs, resolver);
      checks.push(nsCheck);
      break;
    }
    case 'cname': {
      // Use platform IP-set intersection (cluster_nodes + DNS) so worker IPs
      // and IPv6 addresses are included in the match set.
      const cnameCheck = await verifyResolvesToPlatform(
        domain,
        platformConfig.ingressHostname,
        db,
        precomputedPlatformIps,
        resolver,
      );
      checks.push(cnameCheck);
      break;
    }
    case 'secondary': {
      const axfrCheck = await verifyAxfrSync(db, domain);
      checks.push(axfrCheck);
      break;
    }
  }

  const verified = checks.length > 0 && checks.every((c) => c.status === 'pass');

  return { verified, checks };
}

// ─── Config Helper ──────────────────────────────────────────────────────────

/**
 * Read platform configuration.
 * ingressHostname is read from platform_settings.ingress_base_domain (DB-first),
 * then falls back to the PLATFORM_INGRESS_HOSTNAME env var, then empty string.
 *
 * The DB lookup is delegated to the caller to keep verification.ts free of
 * direct ORM imports (drizzle-orm is not available in the test environment).
 * Pass a pre-fetched `dbIngressBaseDomain` value; the function will fall back
 * to the env var if it is null/undefined.
 */
export async function getPlatformConfig(db: Database): Promise<PlatformConfig> {
  const nameserversEnv = process.env.PLATFORM_NAMESERVERS ?? '';
  const nameservers = nameserversEnv
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean);

  // DB-first for ingressHostname — delegate to ingress-routes service to avoid
  // direct drizzle-orm imports here.
  let ingressHostname = '';
  try {
    const { getIngressSettings } = await import('../ingress-routes/service.js');
    const settings = await getIngressSettings(db);
    ingressHostname = settings.ingressBaseDomain;
  } catch {
    // DB unavailable — fall through to env fallback
  }

  if (!ingressHostname) {
    ingressHostname = process.env.PLATFORM_INGRESS_HOSTNAME ?? '';
  }

  return { nameservers, ingressHostname };
}
