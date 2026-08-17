/**
 * Certificate ClusterIssuer selection.
 *
 * Given a domain's DNS state (mode, providers, whether a wildcard is
 * wanted) and the runtime environment, picks which cert-manager
 * ClusterIssuer should sign the certificate. Pure function — no DB,
 * no k8s calls. Callers resolve the inputs and pass them in.
 *
 * Selection matrix:
 *
 *   environment=development        → local-ca-issuer            (no ACME)
 *   environment=staging:
 *     wildcard wanted AND the platform can write the zone
 *                                  → letsencrypt-staging-dns01-insula
 *     everything else              → letsencrypt-staging-http01
 *   environment=production:
 *     wildcard wanted AND the platform can write the zone
 *                                  → letsencrypt-prod-dns01-insula
 *     everything else              → letsencrypt-prod-http01
 *
 * Wildcard certs are DNS-01 only (Let's Encrypt policy). DNS-01 is solved
 * by the platform's OWN webhook (ADR-058), which writes the challenge TXT
 * through whichever provider the domain's group is configured with — so
 * there is one issuer per environment instead of one per provider type,
 * and adding a provider needs no cert-manager change at all.
 *
 * The previous per-provider issuers (`…-dns01-powerdns`, `-cloudflare`,
 * `-route53`, `-hetzner`, `-cloudns`) are still honoured when an operator
 * sets the matching CERT_ISSUER_DNS01_* env var, so a cluster that had
 * hand-wired a working solver keeps it.
 */

import {
  canIssueWildcardCert,
  type DomainAuthorityInput,
  type DomainAuthorityServer,
} from '../dns-servers/authority.js';

export type CertEnvironment = 'development' | 'staging' | 'production';
export type ChallengeType = 'dns01' | 'http01' | 'ca';

export interface ConfiguredIssuers {
  readonly letsencryptProdHttp01: string;
  readonly letsencryptStagingHttp01: string;
  /** Platform solver-webhook issuers, per ACME environment. */
  readonly platformDns01Prod: string;
  readonly platformDns01Staging: string;
  /** Legacy per-provider overrides; a set entry wins for that provider. */
  readonly dns01Issuers: Readonly<Record<string, string>>;
  readonly localCaIssuer: string;
  readonly fallbackIssuer: string;
}

export interface IssuerSelectorInput {
  readonly dnsMode: 'primary' | 'cname' | 'secondary';
  readonly activeServers: readonly DomainAuthorityServer[];
  readonly wildcardRequested: boolean;
  readonly environment: CertEnvironment;
  readonly issuers: ConfiguredIssuers;
}

export interface IssuerSelection {
  readonly issuerName: string;
  readonly challengeType: ChallengeType;
  readonly wildcardCapable: boolean;
}

/**
 * A provider-specific DNS-01 issuer the operator explicitly configured,
 * else null. Checked before the platform solver so an existing hand-wired
 * setup is never silently repointed.
 */
function explicitProviderIssuer(input: IssuerSelectorInput): string | null {
  for (const server of input.activeServers) {
    if (server.enabled !== 1 || server.role !== 'primary') continue;
    const configured = input.issuers.dns01Issuers[server.providerType];
    if (configured) return configured;
  }
  return null;
}

export function selectIssuerForDomain(input: IssuerSelectorInput): IssuerSelection {
  if (input.environment === 'development') {
    return {
      issuerName: input.issuers.localCaIssuer,
      challengeType: 'ca',
      wildcardCapable: true, // a local CA signs wildcards happily
    };
  }

  const authorityInput: DomainAuthorityInput = {
    dnsMode: input.dnsMode,
    activeServers: input.activeServers,
  };

  // Wildcards need DNS-01, and DNS-01 needs the platform to be able to
  // write TXT records in the zone. Staging gets the same treatment as
  // production now that the solver is ours — a staging cluster that
  // could never issue a wildcard was unable to exercise this path at
  // all, which is how the broken issuer shipped in the first place.
  if (input.wildcardRequested && canIssueWildcardCert(authorityInput)) {
    const issuerName =
      explicitProviderIssuer(input) ??
      (input.environment === 'staging'
        ? input.issuers.platformDns01Staging
        : input.issuers.platformDns01Prod);
    return {
      issuerName,
      challengeType: 'dns01' as ChallengeType,
      wildcardCapable: true,
    };
  }

  return {
    issuerName:
      input.environment === 'staging'
        ? input.issuers.letsencryptStagingHttp01
        : input.issuers.letsencryptProdHttp01,
    challengeType: 'http01',
    wildcardCapable: false,
  };
}
