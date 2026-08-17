/**
 * Unified cert-manager Certificate provisioning.
 *
 * Phase 2c replaced two overlapping cert code paths (annotation-driven
 * from `domains/k8s-ingress.ts` + explicit `ssl-certs/cert-manager.ts
 * provisionCertificate`) with this single module. It is the only place
 * in the backend that creates, updates, or deletes cert-manager
 * Certificate CRs. Callers:
 *
 *   - domains/service.ts createDomain/updateDomain/deleteDomain
 *   - ingress-routes/routes.ts createRoute/deleteRoute
 *   - email-domains/service.ts enableEmail/disableEmail (for webmail)
 *
 * Strategy — see docs/architecture/TLS_CERTIFICATE_STRATEGY.md for the
 * full write-up. Summary:
 *
 *   - dnsMode=primary + PowerDNS + production → wildcard DNS-01 cert
 *     covering [<domain>, *.<domain>], shared secret
 *   - everything else → per-hostname HTTP-01 cert (one per ingress
 *     route), existing secret-per-hostname layout preserved
 *   - dev environment → local-ca-issuer (self-signed), no ACME
 *
 * All Certificate CRs live in the tenant's kubernetesNamespace so that
 * the Ingress that references them can find the TLS secret (cert-manager
 * secrets are namespace-scoped).
 */

import { eq } from 'drizzle-orm';
import {
  certCoversHostname,
  certDnsNamesForHostname,
  isWildcardHostname,
  normalizeHostname,
  wildcardBase,
} from '@insula/api-contracts';
import { domains, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { isAutoTlsEnabled, getClusterIssuerName } from '../tls-settings/service.js';
import { getActiveServersForDomain } from '../dns-servers/service.js';
import {
  selectIssuerForDomain,
  type CertEnvironment,
  type ConfiguredIssuers,
} from './issuer-selector.js';
import { readCertificateHealth, shouldFallBack } from './status.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface CertLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: CertLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Naming helpers ───────────────────────────────────────────────────────

/**
 * Convert a hostname to a DNS-1123 safe slug, max 50 chars, no trailing
 * hyphens. Matches the legacy ssl-certs/cert-manager.ts domainToSecretName
 * algorithm so existing secrets keep their names and don't need migration.
 */
function slugify(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\*/g, 'wildcard') // wildcard certs include * in dnsNames
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, ''); // re-strip after slice
}

export function certificateNameFor(domainName: string, wildcard: boolean): string {
  const base = slugify(domainName);
  const suffix = wildcard ? '-wildcard-cert' : '-cert';
  // Ensure the total length stays within k8s DNS-1123 label limit (63)
  const maxBase = 63 - suffix.length;
  return `${base.slice(0, maxBase)}${suffix}`;
}

export function tlsSecretNameFor(domainName: string, wildcard: boolean): string {
  const base = slugify(domainName);
  const suffix = wildcard ? '-wildcard-tls' : '-tls';
  const maxBase = 63 - suffix.length;
  return `${base.slice(0, maxBase)}${suffix}`;
}

// ─── Issuer configuration ─────────────────────────────────────────────────

function getEnvironment(): CertEnvironment {
  const raw = process.env.CERT_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';
  if (raw === 'production' || raw === 'staging') return raw;
  return 'development';
}

/**
 * ClusterIssuer names that mean "the stock public/self-signed issuers". Any
 * OTHER value of CLUSTER_ISSUER_NAME means the operator deliberately pointed
 * this cluster at a different ACME endpoint.
 */
const STOCK_CLUSTER_ISSUERS: ReadonlySet<string> = new Set([
  'letsencrypt-prod-http01',
  'letsencrypt-staging-http01',
  'local-ca-issuer',
  'selfsigned-issuer',
]);

/**
 * The cluster-wide ACME issuer when it is a CUSTOM one, else null.
 *
 * `bootstrap.sh --acme-server` pins CLUSTER_ISSUER_NAME to acme-custom-http01
 * so the platform's own hostnames (admin/tenant/dex/webmail) are issued by that
 * endpoint. Per-DOMAIN certificates used to ignore it entirely and always pick a
 * Let's Encrypt issuer from `getEnvironment()`, which cannot work on the very
 * clusters that need a custom endpoint: LE has no HTTP-01 route to a private
 * apex, so every tenant order fails and Traefik serves its default certificate.
 * Observed on a private-apex cluster — a tenant hostname stayed on
 * cn=TRAEFIKDEFAULTCERT while every platform hostname had a valid cert.
 *
 * Note this deliberately does NOT touch `dns01Issuers`: a custom HTTP-01 issuer
 * cannot solve a DNS-01 wildcard order, so silently substituting it there would
 * break real dns01 wildcard setups. Wildcards on a custom ACME endpoint need
 * their own issuer, configured explicitly via CERT_ISSUER_DNS01_*.
 */
function customClusterAcmeIssuer(): string | null {
  const name = process.env.CLUSTER_ISSUER_NAME?.trim();
  if (!name || STOCK_CLUSTER_ISSUERS.has(name)) return null;
  // The stock DNS-01 issuers are per-provider, not a cluster-wide ACME choice.
  if (name.startsWith('letsencrypt-prod-dns01-')) return null;
  return name;
}

/**
 * Default ClusterIssuer names, matching the manifests in
 * k8s/base/cert-manager/ and k8s/overlays/dind/cert-manager/. Can be
 * overridden per-issuer via env vars for custom cluster setups; an explicit
 * CERT_ISSUER_* always wins over the cluster-wide custom issuer.
 */
export function getConfiguredIssuers(operatorIssuer?: string | null): ConfiguredIssuers {
  // Operator intent order: an explicit per-issuer env var, then the
  // cluster-wide custom ACME endpoint (whether it came from the admin
  // UI's TLS settings or `bootstrap --acme-server`), then the stock name.
  const custom = customIssuerName(operatorIssuer) ?? customClusterAcmeIssuer();
  return {
    letsencryptProdHttp01:
      process.env.CERT_ISSUER_PROD_HTTP01 ?? custom ?? 'letsencrypt-prod-http01',
    letsencryptStagingHttp01:
      process.env.CERT_ISSUER_STAGING_HTTP01 ?? custom ?? 'letsencrypt-staging-http01',
    // Solved by the platform's own webhook (ADR-058) — one issuer per
    // ACME environment, provider-agnostic.
    platformDns01Prod:
      process.env.CERT_ISSUER_DNS01_PLATFORM ?? 'letsencrypt-prod-dns01-insula',
    platformDns01Staging:
      process.env.CERT_ISSUER_DNS01_PLATFORM_STAGING ?? 'letsencrypt-staging-dns01-insula',
    // Legacy per-provider issuers: honoured only when the operator set
    // one explicitly. They used to be defaulted, which is how every
    // wildcard order ended up pointed at a webhook nobody installed.
    dns01Issuers: {
      ...(process.env.CERT_ISSUER_DNS01_POWERDNS ? { powerdns: process.env.CERT_ISSUER_DNS01_POWERDNS } : {}),
      ...(process.env.CERT_ISSUER_DNS01_CLOUDFLARE ? { cloudflare: process.env.CERT_ISSUER_DNS01_CLOUDFLARE } : {}),
      ...(process.env.CERT_ISSUER_DNS01_ROUTE53 ? { route53: process.env.CERT_ISSUER_DNS01_ROUTE53 } : {}),
      ...(process.env.CERT_ISSUER_DNS01_HETZNER ? { hetzner: process.env.CERT_ISSUER_DNS01_HETZNER } : {}),
      ...(process.env.CERT_ISSUER_DNS01_CLOUDNS ? { cloudns: process.env.CERT_ISSUER_DNS01_CLOUDNS } : {}),
    },
    localCaIssuer:
      process.env.CERT_ISSUER_LOCAL_CA ?? 'local-ca-issuer',
    fallbackIssuer:
      process.env.CERT_ISSUER_FALLBACK ?? custom ?? 'letsencrypt-prod-http01',
  };
}

/** A non-stock issuer name, or null when it's one of the built-ins. */
function customIssuerName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || STOCK_CLUSTER_ISSUERS.has(trimmed)) return null;
  if (trimmed.startsWith('letsencrypt-prod-dns01-')) return null;
  if (trimmed.startsWith('letsencrypt-staging-dns01-')) return null;
  return trimmed;
}

// ─── k8s error helpers ────────────────────────────────────────────────────

function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number }; code?: number };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (typeof e?.code === 'number') return e.code;
  if (err instanceof Error) {
    const m = err.message.match(/HTTP-Code:\s*(\d{3})/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function isK8s404(err: unknown): boolean {
  return k8sStatusCode(err) === 404;
}

function isK8s409(err: unknown): boolean {
  return k8sStatusCode(err) === 409;
}

/**
 * Apply a cert-manager Certificate CR idempotently (create-or-replace).
 *
 * Kubernetes requires `metadata.resourceVersion` on every PUT for optimistic
 * concurrency — omitting it returns HTTP 422 and the reconciler silently
 * falls back to "no TLS" for the route. So on 409 we GET the existing
 * object, copy its resourceVersion into the new body, then replace. If the
 * object was deleted in the narrow window between the 409 and the GET, we
 * retry the create instead of erroring.
 *
 * Returns when the apply succeeded. Throws any other underlying k8s error
 * so callers can wrap it into their own ApiError with context.
 */
async function applyCertificateCR(
  k8s: K8sClients,
  namespace: string,
  certName: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await k8s.custom.createNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      body,
    });
    return;
  } catch (err) {
    if (!isK8s409(err)) throw err;
  }

  // 409 — object exists. Read it so we can PUT with the right resourceVersion.
  let existing: { metadata?: { resourceVersion?: string } } | null = null;
  try {
    existing = await k8s.custom.getNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      name: certName,
    }) as { metadata?: { resourceVersion?: string } };
  } catch (getErr) {
    if (!isK8s404(getErr)) throw getErr;
    // Vanished between our create and get — retry the create. If this one
    // also 409s, cert-manager is racing us and we let the caller retry.
    await k8s.custom.createNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      body,
    });
    return;
  }

  const rv = existing.metadata?.resourceVersion;
  const bodyWithRv = rv
    ? { ...body, metadata: { ...(body.metadata as object | undefined ?? {}), resourceVersion: rv } }
    : body;

  await k8s.custom.replaceNamespacedCustomObject({
    group: 'cert-manager.io',
    version: 'v1',
    namespace,
    plural: 'certificates',
    name: certName,
    body: bodyWithRv,
  });
}

// ─── Certificate CR builder ───────────────────────────────────────────────

function buildCertificateResource(params: {
  readonly name: string;
  readonly namespace: string;
  readonly secretName: string;
  readonly dnsNames: readonly string[];
  readonly issuerName: string;
  readonly domainId?: string;
}) {
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': 'insula',
        'app.kubernetes.io/component': 'tls-cert',
        // Lets the status reconciler enumerate every Certificate that
        // belongs to a domain — including sub-wildcards and per-host
        // fallbacks, which name-guessing from the domain alone misses.
        ...(params.domainId ? { 'insula.host/domain-id': params.domainId } : {}),
      },
    },
    spec: {
      secretName: params.secretName,
      dnsNames: [...params.dnsNames],
      issuerRef: {
        name: params.issuerName,
        kind: 'ClusterIssuer',
        group: 'cert-manager.io',
      },
      duration: '2160h', // 90 days (Let's Encrypt max)
      renewBefore: '360h', // 15 days before expiry
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface EnsureCertificateResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly issuerName?: string;
  readonly certificateName?: string;
  readonly secretName?: string;
  readonly dnsNames?: readonly string[];
  readonly wildcard?: boolean;
}

/**
 * Ensure a TLS certificate exists for the given domain.
 *
 * Idempotent: safe to call repeatedly. If the Certificate CR already
 * exists, it's replaced (not left stale), so changes to the selector
 * logic (e.g. wildcard → non-wildcard) propagate on next reconcile.
 *
 * Behaviour matrix:
 *   - auto-TLS disabled → no-op, returns { skipped: true }
 *   - no k8s tenant → no-op, returns { skipped: true }
 *   - otherwise → create/replace Certificate CR in the tenant namespace
 */
export async function ensureDomainCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  logger: CertLogger = noopLogger,
): Promise<EnsureCertificateResult> {
  if (!(await isAutoTlsEnabled(db))) {
    logger.info({ domainId }, 'ensureDomainCertificate: auto-TLS disabled, skipping');
    return { skipped: true, reason: 'auto-TLS disabled' };
  }

  if (!k8s) {
    logger.warn({ domainId }, 'ensureDomainCertificate: no k8s tenant, skipping');
    return { skipped: true, reason: 'no k8s tenant' };
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, domain.tenantId));
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${domain.tenantId}' not found`, 404);
  }
  const namespace = tenant.kubernetesNamespace;

  // Resolve DNS authority inputs.
  //
  // The operator's TLS-settings issuer is now an INPUT, not a log line:
  // it used to be read below purely to note that the selector disagreed
  // with it, so an admin pointing the platform at their own ACME
  // endpoint had no effect on tenant domains at all.
  const activeServers = await getActiveServersForDomain(db, domainId);
  const environment = getEnvironment();
  const operatorIssuer = await getClusterIssuerName(db).catch(() => null);
  const issuers = getConfiguredIssuers(operatorIssuer);

  // For customer domains we always try to issue a wildcard if possible —
  // it covers apex, all existing subdomains, and anything we add in the
  // future (webmail, mail, autodiscover, …) with one cert.
  const selection = selectIssuerForDomain({
    dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
    wildcardRequested: true,
    environment,
    issuers,
  });

  const wildcard = selection.wildcardCapable && selection.challengeType !== 'http01';
  const dnsNames = wildcard
    ? [domain.domainName, `*.${domain.domainName}`]
    : [domain.domainName];

  const certName = certificateNameFor(domain.domainName, wildcard);
  const secretName = tlsSecretNameFor(domain.domainName, wildcard);

  const body = buildCertificateResource({
    name: certName,
    namespace,
    secretName,
    dnsNames,
    issuerName: selection.issuerName,
    domainId,
  });

  try {
    await applyCertificateCR(k8s, namespace, certName, body);
  } catch (err) {
    logger.error(
      { err, domain: domain.domainName, certName },
      'ensureDomainCertificate: apply failed',
    );
    throw new ApiError(
      'CERT_PROVISIONING_FAILED',
      `Failed to replace Certificate for '${domain.domainName}': ${(err as Error).message}`,
      502,
      { domain: domain.domainName },
    );
  }

  logger.info(
    { domain: domain.domainName, issuer: selection.issuerName, wildcard, dnsNames },
    'ensureDomainCertificate: Certificate ensured',
  );

  return {
    skipped: false,
    issuerName: selection.issuerName,
    certificateName: certName,
    secretName,
    dnsNames,
    wildcard,
  };
}

/**
 * Delete the Certificate CR and TLS Secret for a domain. Idempotent.
 *
 * Called when a customer domain is deleted. Safe on 404 (already gone).
 * Tries BOTH the wildcard and non-wildcard cert names so stale certs
 * from before a dnsMode transition also get cleaned up.
 */
export async function deleteDomainCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  logger: CertLogger = noopLogger,
): Promise<void> {
  if (!k8s) {
    logger.warn({ domainId }, 'deleteDomainCertificate: no k8s tenant, skipping');
    return;
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    logger.info({ domainId }, 'deleteDomainCertificate: domain not found, no-op');
    return;
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, domain.tenantId));
  if (!tenant) {
    logger.info({ domainId }, 'deleteDomainCertificate: tenant not found, no-op');
    return;
  }
  const namespace = tenant.kubernetesNamespace;

  // Delete both wildcard and non-wildcard variants since we may be in
  // the middle of a dnsMode transition where both previously existed.
  const names: ReadonlyArray<{ cert: string; secret: string }> = [
    {
      cert: certificateNameFor(domain.domainName, true),
      secret: tlsSecretNameFor(domain.domainName, true),
    },
    {
      cert: certificateNameFor(domain.domainName, false),
      secret: tlsSecretNameFor(domain.domainName, false),
    },
  ];

  for (const { cert, secret } of names) {
    try {
      await k8s.custom.deleteNamespacedCustomObject({
        group: 'cert-manager.io',
        version: 'v1',
        namespace,
        plural: 'certificates',
        name: cert,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        logger.warn(
          { err, domain: domain.domainName, cert },
          'deleteDomainCertificate: Certificate delete failed (non-404)',
        );
      }
    }

    try {
      await k8s.core.deleteNamespacedSecret({
        namespace,
        name: secret,
      });
    } catch (err) {
      if (!isK8s404(err)) {
        logger.warn(
          { err, domain: domain.domainName, secret },
          'deleteDomainCertificate: Secret delete failed (non-404)',
        );
      }
    }
  }

  logger.info({ domain: domain.domainName }, 'deleteDomainCertificate: cleanup complete');
}

/**
 * Re-run ensureDomainCertificate for every domain belonging to a tenant.
 *
 * Used when something changes that affects issuer selection for all of
 * the tenant's domains — for example, a new DNS provider is added to
 * their group, or an operator flips auto-TLS on/off.
 */
export async function recomputeAllCertificatesForTenant(
  db: Database,
  k8s: K8sClients | undefined,
  tenantId: string,
  logger: CertLogger = noopLogger,
): Promise<void> {
  const rows = await db
    .select({ id: domains.id, domainName: domains.domainName })
    .from(domains)
    .where(eq(domains.tenantId, tenantId));
  for (const row of rows) {
    try {
      await ensureDomainCertificate(db, k8s, row.id, logger);
    } catch (err) {
      logger.error(
        { err, domainId: row.id, domain: row.domainName },
        'recomputeAllCertificatesForTenant: ensureDomainCertificate failed',
      );
    }
  }
}

// ─── Mail server certificate ──────────────────────────────────────────────

const MAIL_NAMESPACE = 'mail';
const STALWART_CERT_NAME = 'stalwart-mail-cert';
const STALWART_SECRET_NAME = 'stalwart-tls';

// Basic hostname validation — no trailing/leading dots, no empty labels.
// We keep it permissive because the mail hostname can include local
// development values like `mail.dind.local`, which the webmail-domains
// reserved-TLD denylist does NOT apply to (this is a PLATFORM setting
// not a user-picked domain).
function validateMailHostname(hostname: string): void {
  const trimmed = hostname.trim();
  if (!trimmed) {
    throw new ApiError('INVALID_FIELD_VALUE', 'mail hostname is empty', 400);
  }
  if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      'mail hostname must not start or end with a dot',
      400,
      { hostname: trimmed },
    );
  }
  if (trimmed.includes('..')) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      'mail hostname contains empty label',
      400,
      { hostname: trimmed },
    );
  }
  // No whitespace anywhere
  if (/\s/.test(trimmed)) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      'mail hostname contains whitespace',
      400,
      { hostname: trimmed },
    );
  }
}

export interface EnsureMailServerCertificateResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly namespace?: string;
  readonly certificateName?: string;
  readonly secretName?: string;
  readonly issuerName?: string;
  readonly dnsNames?: readonly string[];
}

/**
 * Ensure a cert-manager Certificate exists for the platform's Stalwart
 * mail server hostname, in the shared `mail` namespace.
 *
 * Unlike `ensureDomainCertificate` (which is per-customer-domain), this
 * is a single platform-wide cert for the global mail hostname (e.g.
 * `mail.platform.net`). Customer-specific `mail.<customer>.com`
 * hostnames CNAME to this global hostname and tenants accept the cert
 * because the CNAME chain is transparent at the TLS layer.
 *
 * Selection:
 *   - dev → local-ca-issuer
 *   - staging → letsencrypt-staging-http01
 *   - production → letsencrypt-prod-http01 (the mail hostname is a
 *     platform-owned, ICANN-routable name, so HTTP-01 works fine; we
 *     don't need DNS-01 here because we're not issuing wildcards)
 *
 * Secret name is fixed at `stalwart-tls` (in the `mail` namespace) so
 * operators know exactly which Secret to mount into the Stalwart
 * StatefulSet via their production overlay. See
 * `k8s/overlays/production/stalwart/` for the overlay patch pattern
 * and `docs/operations/MAIL_SERVER_OPERATIONS.md` for the manual
 * bootstrap steps.
 */
export async function ensureMailServerCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  hostname: string,
  logger: CertLogger = noopLogger,
): Promise<EnsureMailServerCertificateResult> {
  validateMailHostname(hostname);
  const cleanHostname = hostname.trim().toLowerCase();

  if (!(await isAutoTlsEnabled(db))) {
    logger.info(
      { hostname: cleanHostname },
      'ensureMailServerCertificate: auto-TLS disabled, skipping',
    );
    return { skipped: true, reason: 'auto-TLS disabled' };
  }

  if (!k8s) {
    logger.warn(
      { hostname: cleanHostname },
      'ensureMailServerCertificate: no k8s tenant, skipping',
    );
    return { skipped: true, reason: 'no k8s tenant' };
  }

  const environment = getEnvironment();
  const issuers = getConfiguredIssuers();
  // Mail server is never in cname/secondary mode — it's a platform
  // hostname under a domain we control. HTTP-01 is fine; no wildcard.
  const selection = selectIssuerForDomain({
    dnsMode: 'primary',
    activeServers: [],
    wildcardRequested: false,
    environment,
    issuers,
  });

  const body = buildCertificateResource({
    name: STALWART_CERT_NAME,
    namespace: MAIL_NAMESPACE,
    secretName: STALWART_SECRET_NAME,
    dnsNames: [cleanHostname],
    issuerName: selection.issuerName,
  });

  try {
    await applyCertificateCR(k8s, MAIL_NAMESPACE, STALWART_CERT_NAME, body);
  } catch (err) {
    logger.error(
      { err, hostname: cleanHostname },
      'ensureMailServerCertificate: apply failed',
    );
    throw new ApiError(
      'CERT_PROVISIONING_FAILED',
      `Failed to apply mail server Certificate for '${cleanHostname}': ${(err as Error).message}`,
      502,
      { hostname: cleanHostname },
    );
  }

  logger.info(
    { hostname: cleanHostname, issuer: selection.issuerName },
    'ensureMailServerCertificate: Certificate ensured',
  );

  return {
    skipped: false,
    namespace: MAIL_NAMESPACE,
    certificateName: STALWART_CERT_NAME,
    secretName: STALWART_SECRET_NAME,
    issuerName: selection.issuerName,
    dnsNames: [cleanHostname],
  };
}

// ─── Per-hostname certificate provisioning ───────────────────────────────

/**
 * Check whether a hostname is covered by a domain's wildcard cert.
 *
 * A wildcard cert `*.acme.com` covers immediate subdomains (one label
 * deep) of `acme.com`. It does NOT cover `acme.com` itself (that's why
 * we also include the apex as a second SAN) and does NOT cover
 * deeper hostnames like `foo.bar.acme.com`.
 */
export function hostnameIsCoveredByDomainCert(
  hostname: string,
  domainName: string,
  wildcard: boolean,
): boolean {
  // Delegates to the shared SAN matcher so the panels, the reconciler
  // and this module cannot disagree about what a certificate covers.
  const sans = wildcard
    ? certDnsNamesForHostname(`*.${normalizeHostname(domainName)}`)
    : [normalizeHostname(domainName)];
  return certCoversHostname(hostname, sans);
}

export interface EnsureRouteCertificateResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly secretName?: string;
  readonly sharedWithDomain?: boolean; // true if reusing the domain-level cert
  readonly issuerName?: string;
}

/**
 * Ensure a TLS cert exists for a specific ingress-route hostname.
 *
 * Strategy:
 *   1. Call ensureDomainCertificate for the owning domain first — if
 *      that produces a wildcard cert that covers this hostname, we're
 *      done and return the shared secret name.
 *   2. If the hostname isn't covered by the domain cert (e.g. not in
 *      wildcard mode, or the hostname is too deep), create a
 *      per-hostname Certificate CR alongside the domain cert.
 */
export async function ensureRouteCertificate(
  db: Database,
  k8s: K8sClients | undefined,
  domainId: string,
  hostname: string,
  logger: CertLogger = noopLogger,
): Promise<EnsureRouteCertificateResult> {
  if (!(await isAutoTlsEnabled(db))) {
    return { skipped: true, reason: 'auto-TLS disabled' };
  }
  if (!k8s) {
    return { skipped: true, reason: 'no k8s tenant' };
  }

  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, domain.tenantId));
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${domain.tenantId}' not found`, 404);
  }
  const namespace = tenant.kubernetesNamespace;

  // Step 1: ensure the domain-level cert. If it produces a wildcard or
  // matches the hostname as apex, we can reuse its secret.
  const domainCert = await ensureDomainCertificate(db, k8s, domainId, logger);
  const coveredByDomainCert =
    !domainCert.skipped &&
    !!domainCert.secretName &&
    hostnameIsCoveredByDomainCert(hostname, domain.domainName, domainCert.wildcard === true);

  if (coveredByDomainCert) {
    // Covered on paper — but is that certificate actually ISSUED?
    //
    // Pointing an IngressRoute at the Secret of an order that has been
    // failing for an hour serves Traefik's default certificate, i.e. a
    // browser warning, with no signal anywhere. If the wildcard has been
    // failing past the grace period we fall through and give this
    // hostname its own HTTP-01 certificate instead; cert-manager keeps
    // retrying the wildcard, and the next reconcile switches back the
    // moment it goes Ready.
    const health = domainCert.certificateName
      ? await readCertificateHealth(k8s, namespace, domainCert.certificateName)
      : null;
    const degraded = health ? shouldFallBack(health, new Date()) : false;

    if (!degraded) {
      return {
        skipped: false,
        secretName: domainCert.secretName,
        sharedWithDomain: true,
        issuerName: domainCert.issuerName,
      };
    }

    // A wildcard ROUTE hostname has nothing to fall back to — no
    // per-hostname certificate can serve `*.a.example.test`.
    if (isWildcardHostname(hostname)) {
      return {
        skipped: true,
        reason:
          `The wildcard certificate for '${domain.domainName}' is failing (${health?.message ?? 'unknown error'}), ` +
          `and a wildcard hostname cannot be served by a per-hostname certificate.`,
      };
    }

    logger.warn(
      { hostname, domain: domain.domainName, message: health?.message },
      'ensureRouteCertificate: wildcard is failing past the grace period — issuing a per-hostname certificate',
    );
  }

  // Step 2: hostname not covered by the domain cert.
  //
  // A WILDCARD hostname (`*.a.example.test`, from a wildcard route) needs
  // its own DNS-01 order: it is not covered by the domain's `*.example.test`
  // (RFC 6125 wildcards are not recursive), and HTTP-01 cannot validate a
  // wildcard at all — issuing one through the HTTP-01 issuer would create
  // an order that can never succeed and would sit Pending forever.
  //
  // Anything else is a plain per-hostname cert on whichever issuer the
  // domain resolves to.
  const wildcardHostname = isWildcardHostname(hostname);
  const activeServers = await getActiveServersForDomain(db, domainId);
  const environment = getEnvironment();
  const issuers = getConfiguredIssuers(await getClusterIssuerName(db).catch(() => null));
  const selection = selectIssuerForDomain({
    dnsMode: domain.dnsMode as 'primary' | 'cname' | 'secondary',
    activeServers: activeServers.map((s) => ({
      id: s.id,
      providerType: s.providerType,
      enabled: s.enabled,
      role: s.role,
    })),
    wildcardRequested: wildcardHostname,
    environment,
    issuers,
  });

  if (wildcardHostname && (!selection.wildcardCapable || selection.challengeType === 'http01')) {
    logger.warn(
      { hostname, issuer: selection.issuerName, dnsMode: domain.dnsMode },
      'ensureRouteCertificate: wildcard hostname needs DNS-01 but the domain has no DNS-01-capable primary provider',
    );
    return {
      skipped: true,
      reason:
        `'${hostname}' needs a DNS-01 wildcard certificate, which requires the domain to be in ` +
        `primary DNS mode with an enabled primary provider the platform can write TXT records to.`,
    };
  }

  // A wildcard cert is named after the name it sits under, so
  // `*.a.example.test` and `*.example.test` get distinct CRs/Secrets
  // instead of colliding on one `example-test-wildcard-tls`.
  const certSubject = wildcardHostname ? (wildcardBase(hostname) as string) : hostname;
  const certName = certificateNameFor(certSubject, wildcardHostname);
  const secretName = tlsSecretNameFor(certSubject, wildcardHostname);

  // `*.a.example.test` is requested together with `a.example.test` so one
  // cert serves the wildcard route AND a route on the name itself.
  const dnsNames = certDnsNamesForHostname(hostname);

  const body = buildCertificateResource({
    name: certName,
    namespace,
    secretName,
    dnsNames,
    issuerName: selection.issuerName,
    domainId,
  });

  try {
    await applyCertificateCR(k8s, namespace, certName, body);
  } catch (err) {
    logger.error(
      { err, hostname, certName },
      'ensureRouteCertificate: apply failed',
    );
    throw new ApiError(
      'CERT_PROVISIONING_FAILED',
      `Failed to apply Certificate for '${hostname}': ${(err as Error).message}`,
      502,
      { hostname },
    );
  }

  logger.info(
    { hostname, issuer: selection.issuerName, dnsNames, wildcard: wildcardHostname },
    wildcardHostname
      ? 'ensureRouteCertificate: wildcard Certificate ensured'
      : 'ensureRouteCertificate: per-hostname Certificate ensured',
  );

  return {
    skipped: false,
    secretName,
    sharedWithDomain: false,
    issuerName: selection.issuerName,
  };
}
