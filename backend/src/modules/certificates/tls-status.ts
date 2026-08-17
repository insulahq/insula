/**
 * The per-domain TLS view both panels render.
 *
 * Assembles what cert-manager reports (live, from the Certificate CRs)
 * with what the platform decided (wildcard capability, fallback state,
 * reissue cooldown) so the operator sees one story instead of three
 * half-answers.
 */

import { eq } from 'drizzle-orm';
import { certCoversHostname } from '@insula/api-contracts';
import type { DomainTlsStatus, CertificateDetail } from '@insula/api-contracts';
import { domains, sslCertificates, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { canIssueWildcardCert, canManageDnsZone, DNS01_SOLVER_PROVIDERS } from '../dns-servers/authority.js';
import { getActiveServersForDomain } from '../dns-servers/service.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { listCertificateHealth } from './status.js';
import type { CertificateHealth } from './status.js';
import { REISSUE_COOLDOWN_MS } from './reissue.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Why this domain cannot have a wildcard, in the operator's terms.
 *
 * Returning null means it can. The three causes are genuinely different
 * fixes, so "wildcard unavailable" on its own would send people looking
 * in the wrong place.
 */
export function wildcardBlockedReason(
  dnsMode: string,
  servers: ReadonlyArray<{ providerType: string; enabled: number; role: string }>,
): string | null {
  const authority = {
    dnsMode: dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: servers.map((s, i) => ({ id: String(i), ...s })),
  };
  if (canIssueWildcardCert(authority)) return null;

  if (!canManageDnsZone(authority)) {
    return dnsMode === 'primary'
      ? 'The domain is in primary DNS mode but has no enabled primary DNS server, so the platform cannot publish the DNS-01 challenge record.'
      : `Wildcard certificates are validated over DNS, which requires the platform to manage the zone. This domain is in '${dnsMode}' mode, so its DNS is managed elsewhere.`;
  }
  const types = [...new Set(servers.filter((s) => s.enabled === 1 && s.role === 'primary').map((s) => s.providerType))];
  return `None of the domain's primary DNS providers (${types.join(', ') || 'none'}) support writing challenge records. Supported: ${[...DNS01_SOLVER_PROVIDERS].join(', ')}.`;
}

function toDetail(health: CertificateHealth): CertificateDetail {
  return {
    name: health.name,
    state: health.state,
    dnsNames: [...health.dnsNames],
    wildcard: health.wildcard,
    secretName: health.secretName ?? null,
    issuerName: health.issuerName ?? null,
    message: health.message ?? null,
    failedAttempts: health.failedAttempts,
    lastFailureAt: health.lastFailureAt?.toISOString() ?? null,
    expiresAt: health.notAfter?.toISOString() ?? null,
  };
}

/** Aggregate several certificates into the badge state for a domain. */
export function aggregateState(certs: readonly CertificateDetail[]): DomainTlsStatus['state'] {
  if (certs.length === 0) return 'unknown';
  // Worst-first: one failing certificate means some hostname is serving
  // a browser warning, which matters more than the others being fine.
  if (certs.some((c) => c.state === 'failed')) return 'failed';
  if (certs.some((c) => c.state === 'issuing')) return 'issuing';
  if (certs.every((c) => c.state === 'issued')) return 'issued';
  return 'unknown';
}

export async function getDomainTlsStatus(
  db: Database,
  k8s: K8sClients | null,
  domainId: string,
  tenantId: string,
): Promise<DomainTlsStatus> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain || domain.tenantId !== tenantId) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, domain.tenantId));

  const servers = await getActiveServersForDomain(db, domainId);
  const [certRow] = await db
    .select({
      fallbackActive: sslCertificates.fallbackActive,
      lastReissueAt: sslCertificates.lastReissueAt,
    })
    .from(sslCertificates)
    .where(eq(sslCertificates.domainId, domainId));

  const namespace = tenant?.kubernetesNamespace;
  const all = k8s && namespace ? await listCertificateHealth(k8s, namespace) : [];
  const mine = all.filter(
    (c) => c.domainId === domainId || certCoversHostname(domain.domainName, c.dnsNames),
  );
  const certificates = mine.map(toDetail);

  const cooldownEnd = certRow?.lastReissueAt
    ? new Date(certRow.lastReissueAt.getTime() + REISSUE_COOLDOWN_MS)
    : null;

  return {
    domainId,
    domainName: domain.domainName,
    state: aggregateState(certificates),
    wildcardCapable: wildcardBlockedReason(domain.dnsMode, servers) === null,
    wildcardBlockedReason: wildcardBlockedReason(domain.dnsMode, servers),
    fallbackActive: (certRow?.fallbackActive ?? 0) === 1,
    autoTlsEnabled: await isAutoTlsEnabled(db),
    certificates,
    reissueAvailableAt:
      cooldownEnd && cooldownEnd.getTime() > Date.now() ? cooldownEnd.toISOString() : null,
  };
}
