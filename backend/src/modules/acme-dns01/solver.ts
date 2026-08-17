/**
 * ACME DNS-01 solver, backed by the platform's own DNS provider groups.
 *
 * WHY THIS EXISTS (ADR-058): wildcard certificates are DNS-01 only, and
 * cert-manager has no built-in solver for PowerDNS — our primary target.
 * The shipped `letsencrypt-prod-dns01-powerdns` ClusterIssuer pointed at
 * a third-party webhook chart that bootstrap never installed and a
 * hardcoded `apiUrl`, so every wildcard order sat Pending forever while
 * the platform already held working API credentials for that exact zone
 * in `dns_servers.connection_config_encrypted`.
 *
 * Instead of copying those credentials into the cert-manager namespace
 * once per provider type, the platform serves ONE solver webhook that
 * writes the challenge TXT through the same `DnsProviderAdapter` the
 * rest of the platform uses. Consequences worth keeping:
 *
 *   - Every provider type gets wildcard support for free, including any
 *     future one — the provider-group abstraction is the only contract.
 *   - No DNS credential ever leaves the platform database.
 *   - Authority is enforced from OUR records, not from whatever zone the
 *     ACME server happened to resolve: we only ever write into a zone
 *     the platform is authoritative for.
 */

import { ne } from 'drizzle-orm';
import {
  isAtOrUnder,
  longestMatchingDomain,
  normalizeHostname,
  relativeRecordName,
} from '@insula/api-contracts';
import { domains } from '../../db/schema.js';
import { canManageDnsZone } from '../dns-servers/authority.js';
import { getActiveServersForDomain, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';
import type { DnsProviderAdapter, DnsRecordInput } from '../dns-servers/providers/types.js';
import type { ChallengeRequest } from './types.js';

/** TXT TTL for challenge records — short so cleanup is not cached. */
export const CHALLENGE_TTL_SECONDS = 60;

export interface SolverLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface SolverDeps {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly logger: SolverLogger;
}

export class SolverError extends Error {}

export interface ResolvedTarget {
  readonly domainId: string;
  readonly domainName: string;
  /** Record name relative to `domainName`, e.g. `_acme-challenge.a`. */
  readonly recordName: string;
  readonly providers: ReadonlyArray<DnsProviderAdapter>;
}

/**
 * Strip the trailing dot cert-manager always sends and lowercase.
 */
function fqdn(value: string | undefined): string {
  return normalizeHostname(value ?? '');
}

/**
 * Find the platform domain that owns this challenge, and the providers
 * to write it through.
 *
 * We deliberately resolve against OUR `domains` table rather than
 * trusting `resolvedZone`: cert-manager derives that by SOA lookup, so a
 * stray child zone in the provider (a real failure mode on this
 * platform) would point us at a zone we do not manage. Longest suffix
 * wins so `x.a.example.test` lands on the `a.example.test` domain when
 * both are registered.
 */
export async function resolveChallengeTarget(
  deps: SolverDeps,
  request: ChallengeRequest,
): Promise<ResolvedTarget> {
  const challengeFqdn = fqdn(request.resolvedFQDN);
  if (!challengeFqdn) {
    throw new SolverError('resolvedFQDN is empty');
  }

  // Every domain except deleted ones: a certificate is legitimately
  // ordered for a domain that is still `unverified` or `pending`
  // (ensureDomainCertificate does not gate on status either), so
  // filtering on `active` here would make first-issuance fail for
  // exactly the domains that have never had a cert.
  const rows = await deps.db
    .select({ id: domains.id, domainName: domains.domainName, dnsMode: domains.dnsMode })
    .from(domains)
    .where(ne(domains.status, 'deleted'));

  // `longestMatchingDomain` expects a hostname; the challenge FQDN is
  // `_acme-challenge.<name>` which is exactly that, one label deeper.
  const match = longestMatchingDomain(challengeFqdn, rows);
  if (!match) {
    throw new SolverError(
      `No active platform domain owns '${challengeFqdn}' — refusing to write a challenge record`,
    );
  }

  // Sanity: the ACME-resolved zone must sit at or above the domain we
  // matched. If it is BELOW, a child zone exists that we are not
  // authoritative for and writing into the parent would never be seen.
  const acmeZone = fqdn(request.resolvedZone);
  if (acmeZone && !isAtOrUnder(match.domainName, acmeZone) && !isAtOrUnder(acmeZone, match.domainName)) {
    deps.logger.warn(
      { challengeFqdn, acmeZone, domain: match.domainName },
      'acme-dns01: resolved zone and platform domain disagree',
    );
  }

  const servers = await getActiveServersForDomain(deps.db, match.id);
  const authoritative = canManageDnsZone({
    dnsMode: match.dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: servers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
  });
  if (!authoritative) {
    throw new SolverError(
      `Platform is not authoritative for '${match.domainName}' (dnsMode=${match.dnsMode}) — ` +
        `a DNS-01 challenge cannot be solved for a customer-managed zone`,
    );
  }

  // Primaries only. Secondaries replicate by AXFR and reject writes.
  const primaries = servers.filter((s) => s.enabled === 1 && s.role === 'primary');
  if (primaries.length === 0) {
    throw new SolverError(`No enabled primary DNS server for '${match.domainName}'`);
  }

  return {
    domainId: match.id,
    domainName: match.domainName,
    recordName: relativeRecordName(challengeFqdn, match.domainName),
    providers: primaries.map((s) => getProviderForServer(s, deps.encryptionKey)),
  };
}

function challengeRecord(target: ResolvedTarget, key: string): DnsRecordInput {
  return {
    type: 'TXT',
    name: target.recordName,
    content: key,
    ttl: CHALLENGE_TTL_SECONDS,
  };
}

/**
 * Publish the challenge TXT on every primary of the owning zone.
 *
 * Adding (not replacing) matters: an order for `example.test` plus
 * `*.example.test` produces two DIFFERENT keys on the same
 * `_acme-challenge.example.test` name, and both must be present at the
 * same time or one of the two authorizations fails.
 */
export async function presentChallenge(
  deps: SolverDeps,
  request: ChallengeRequest,
): Promise<void> {
  const target = await resolveChallengeTarget(deps, request);
  const record = challengeRecord(target, request.key);

  const failures: string[] = [];
  for (const provider of target.providers) {
    try {
      await provider.createRecord(target.domainName, record);
    } catch (err) {
      failures.push(`${provider.providerType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length === target.providers.length) {
    throw new SolverError(
      `Failed to publish challenge for '${request.dnsName}' on every primary — ${failures.join('; ')}`,
    );
  }
  if (failures.length > 0) {
    // Partial success still validates (any authoritative server answering
    // is enough), but a silently half-broken provider set is exactly the
    // state that makes the NEXT renewal fail.
    deps.logger.warn(
      { dnsName: request.dnsName, failures },
      'acme-dns01: challenge published on some primaries only',
    );
  }

  deps.logger.info(
    { dnsName: request.dnsName, zone: target.domainName, record: target.recordName },
    'acme-dns01: challenge presented',
  );
}

/**
 * Remove this challenge's TXT value, leaving any other value at the same
 * name intact — see `deleteRecordValue` in the provider interface.
 *
 * Cleanup failures are logged, never thrown: cert-manager treats a failed
 * CleanUp as a challenge failure and retries the whole order, and a stale
 * 60-second TXT record is harmless next to that.
 */
export async function cleanupChallenge(
  deps: SolverDeps,
  request: ChallengeRequest,
): Promise<void> {
  const target = await resolveChallengeTarget(deps, request);
  const record = challengeRecord(target, request.key);

  for (const provider of target.providers) {
    try {
      if (provider.deleteRecordValue) {
        await provider.deleteRecordValue(target.domainName, record);
        continue;
      }
      // Providers that address records individually: find this exact
      // value's id and delete just it.
      const existing = await provider.listRecords(target.domainName);
      const wanted = `${target.recordName}.${target.domainName}`;
      const hit = existing.find(
        (r) =>
          r.type === 'TXT' &&
          normalizeHostname(r.name) === normalizeHostname(wanted) &&
          r.content.replace(/^"|"$/g, '') === request.key,
      );
      if (hit) await provider.deleteRecord(target.domainName, hit.id);
    } catch (err) {
      deps.logger.warn(
        { dnsName: request.dnsName, err: err instanceof Error ? err.message : String(err) },
        'acme-dns01: challenge cleanup failed (record will expire on its own)',
      );
    }
  }

  deps.logger.info(
    { dnsName: request.dnsName, zone: target.domainName },
    'acme-dns01: challenge cleaned up',
  );
}

/** Dispatch a validated request to the right side-effect. */
export async function solveChallenge(
  deps: SolverDeps,
  request: ChallengeRequest,
): Promise<void> {
  if (request.action === 'Present') return presentChallenge(deps, request);
  return cleanupChallenge(deps, request);
}
