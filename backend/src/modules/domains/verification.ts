import dns from 'node:dns/promises';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VerificationCheck {
  readonly type: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
}

export interface PlatformConfig {
  readonly nameservers: readonly string[];
  readonly ingressHostname: string;
}

// ─── DNS Verification Functions ─────────────────────────────────────────────

export async function verifyNsDelegation(
  domain: string,
  expectedNs: readonly string[],
): Promise<VerificationCheck> {
  try {
    const actualNs = await dns.resolveNs(domain);
    const normalizedActual = actualNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));
    const normalizedExpected = expectedNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));

    const allMatch = normalizedExpected.every((ns) => normalizedActual.includes(ns));

    return {
      type: 'ns_delegation',
      status: allMatch ? 'pass' : 'fail',
      detail: allMatch
        ? `NS records correctly delegated to: ${normalizedActual.join(', ')}`
        : `Expected NS: ${normalizedExpected.join(', ')} — found: ${normalizedActual.join(', ')}`,
    };
  } catch (err) {
    return {
      type: 'ns_delegation',
      status: 'fail',
      detail: `NS lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * @deprecated Use verifyResolvesToIngress for cname-mode domains instead.
 * This function does an exact CNAME match which rejects CDN/proxy setups.
 */
export async function verifyCnameRecord(
  hostname: string,
  expectedTarget: string,
): Promise<VerificationCheck> {
  try {
    const cnames = await dns.resolveCname(hostname);
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
 * dns.resolve4/6 follow CNAME chains transparently.
 * Returns an empty array (and optionally logs into `errors`) if no records exist.
 */
async function resolveAllIps(
  hostname: string,
  errors: string[],
): Promise<string[]> {
  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const ips: string[] = [];

  if (v4Result.status === 'fulfilled') {
    ips.push(...v4Result.value);
  } else {
    const code = (v4Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`A lookup error: ${v4Result.reason instanceof Error ? v4Result.reason.message : String(v4Result.reason)}`);
    }
  }

  if (v6Result.status === 'fulfilled') {
    ips.push(...v6Result.value);
  } else {
    const code = (v6Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`AAAA lookup error: ${v6Result.reason instanceof Error ? v6Result.reason.message : String(v6Result.reason)}`);
    }
  }

  return ips;
}

/**
 * Verify that a customer hostname ultimately resolves to one or more IPs
 * that are also served by the ingress base domain.
 *
 * Pass/fail is determined by IP-set intersection — any CDN or proxy chain
 * that ends at the platform's ingress IPs will pass.
 *
 * The CNAME chain is also walked (informational only) and included in the
 * detail message.
 */
export async function verifyResolvesToIngress(
  hostname: string,
  ingressBaseDomain: string,
): Promise<VerificationCheck> {
  // Resolve ingress base IPs first — if this fails it's an operator config problem
  const ingressErrors: string[] = [];
  const ingressIps = await resolveAllIps(ingressBaseDomain, ingressErrors);

  if (ingressIps.length === 0) {
    const detail = ingressErrors.length > 0
      ? `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration (${ingressErrors.join('; ')})`
      : `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration`;
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // Resolve customer hostname IPs (follows CNAME chain transparently)
  const customerErrors: string[] = [];
  const customerIps = await resolveAllIps(hostname, customerErrors);

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
    const cnames = await dns.resolveCname(hostname);
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
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
  try {
    const activeServers = await getActiveServers(db);
    for (const server of activeServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (provider.getZoneAxfrStatus) {
          const axfrStatus = await provider.getZoneAxfrStatus(domainName);
          return {
            type: 'axfr_sync',
            status: axfrStatus.synced ? 'pass' : 'fail',
            detail: axfrStatus.synced
              ? `AXFR synced — SOA serial: ${axfrStatus.lastSoaSerial ?? 'unknown'}`
              : 'AXFR not yet synced — SOA record not found',
          };
        }
        // Fallback: check if zone exists with SOA via getZone
        const zone = await provider.getZone(domainName);
        return {
          type: 'axfr_sync',
          status: zone ? 'pass' : 'fail',
          detail: zone
            ? `Slave zone exists — serial: ${zone.serial}`
            : 'Slave zone not found on DNS server',
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

export async function verifyDomain(
  domain: string,
  dnsMode: 'primary' | 'cname' | 'secondary',
  platformConfig: PlatformConfig,
  db: Database,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  switch (dnsMode) {
    case 'primary': {
      const nsCheck = await verifyNsDelegation(domain, platformConfig.nameservers);
      checks.push(nsCheck);
      break;
    }
    case 'cname': {
      // Use IP-set intersection instead of exact CNAME match so CDN/proxy
      // chains (e.g. customer.com → CDN → platform IP) are accepted.
      const cnameCheck = await verifyResolvesToIngress(domain, platformConfig.ingressHostname);
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
