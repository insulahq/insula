/**
 * Resolve a downloadable PEM bundle for a domain.
 *
 * A domain's certificate can come from one of two places and the caller should
 * not have to care which:
 *
 *   managed   cert-manager issued it (Let's Encrypt, or the internal CA). The
 *             material lives in the tenant namespace's TLS Secret. This is the
 *             common case and the one that makes unattended download worth
 *             building — Let's Encrypt renews every 90 days.
 *   uploaded  the customer supplied it. `ssl_certificates` holds the PEM and
 *             an encrypted private key.
 *
 * Managed wins when both exist, because that is what the ingress is actually
 * serving: `applyPVC`-style upload is a staging step, and the reconciler keeps
 * the Secret authoritative.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { domains, tenants, sslCertificates } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { tlsSecretNameFor } from '../certificates/service.js';
import type { CertBundleSource } from '@insula/api-contracts';

export interface CertBundle {
  readonly source: CertBundleSource;
  /** Full PEM: private key, leaf certificate, then any chain. */
  readonly pem: string;
  /** Leaf certificate only — used to derive the expiry for the audit row. */
  readonly certificatePem: string;
  readonly domainName: string;
  readonly expiresAt: Date | null;
}

export interface DomainRef {
  readonly domainId: string;
  readonly tenantId: string;
  readonly domainName: string;
  readonly namespace: string | null;
}

/** Look a domain up by id, scoped to its tenant. */
export async function resolveDomainById(
  db: Database,
  tenantId: string,
  domainId: string,
): Promise<DomainRef | null> {
  const [row] = await db
    .select({
      domainId: domains.id,
      tenantId: domains.tenantId,
      domainName: domains.domainName,
      namespace: tenants.kubernetesNamespace,
    })
    .from(domains)
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/**
 * Look a domain up by NAME, for the token route where the customer's script
 * knows `example.com` and not a UUID.
 *
 * Scoped to the token's tenant by the caller — a name alone is not an
 * authorisation, and two tenants may legitimately hold the same name at
 * different times.
 */
export async function resolveDomainByName(
  db: Database,
  tenantId: string,
  domainName: string,
): Promise<DomainRef | null> {
  const [row] = await db
    .select({
      domainId: domains.id,
      tenantId: domains.tenantId,
      domainName: domains.domainName,
      namespace: tenants.kubernetesNamespace,
    })
    .from(domains)
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(and(eq(domains.domainName, domainName), eq(domains.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

function parseExpiry(certPem: string): Date | null {
  try {
    // Imported lazily so this module stays usable in tests without the
    // node:crypto X509 surface being exercised on every import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { X509Certificate } = require('node:crypto') as typeof import('node:crypto');
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

/** Join PEM blocks with exactly one newline between them. */
function joinPem(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join('\n') + '\n';
}

/**
 * Read the cert-manager TLS Secret for a domain.
 *
 * Tries the wildcard Secret first and the per-hostname one second, mirroring
 * `cert-reconciler` — a domain in HTTP-01 mode has no wildcard, and a domain
 * that just moved to DNS-01 may briefly have both.
 */
async function readManagedBundle(
  k8s: K8sClients,
  namespace: string,
  domainName: string,
): Promise<{ certPem: string; keyPem: string } | null> {
  for (const wildcard of [true, false]) {
    const name = tlsSecretNameFor(domainName, wildcard);
    try {
      const secret = await k8s.core.readNamespacedSecret({ name, namespace }) as {
        data?: Record<string, string>;
      };
      const crt = secret.data?.['tls.crt'];
      const key = secret.data?.['tls.key'];
      if (!crt || !key) continue;
      return {
        certPem: Buffer.from(crt, 'base64').toString('utf8'),
        keyPem: Buffer.from(key, 'base64').toString('utf8'),
      };
    } catch {
      // 404 or unreadable — try the other variant.
    }
  }
  return null;
}

/**
 * Build the bundle for a domain, or null when there is nothing to hand out.
 *
 * Returning null rather than throwing lets the availability probe and the
 * download route share one code path — the probe renders a reason, the route
 * turns it into a 404.
 */
export async function buildCertBundle(
  db: Database,
  k8s: K8sClients | null,
  domain: DomainRef,
  encryptionKey: string,
): Promise<CertBundle | null> {
  // 1. Managed (cert-manager) — what the ingress is actually serving.
  if (k8s && domain.namespace) {
    const managed = await readManagedBundle(k8s, domain.namespace, domain.domainName);
    if (managed) {
      return {
        source: 'managed',
        // Key first: nginx/apache/haproxy all accept key-then-cert, and it
        // matches what `certbot` writes, so the file drops straight in.
        pem: joinPem(managed.keyPem, managed.certPem),
        certificatePem: managed.certPem,
        domainName: domain.domainName,
        expiresAt: parseExpiry(managed.certPem),
      };
    }
  }

  // 2. Customer-uploaded.
  const [row] = await db
    .select()
    .from(sslCertificates)
    .where(and(
      eq(sslCertificates.domainId, domain.domainId),
      eq(sslCertificates.tenantId, domain.tenantId),
    ))
    .limit(1);

  if (!row) return null;

  let keyPem: string;
  try {
    keyPem = decrypt(row.privateKeyEncrypted, encryptionKey);
  } catch {
    // A key we cannot decrypt is not a bundle. Surfacing null keeps the
    // failure honest instead of handing out a cert with no usable key.
    return null;
  }

  return {
    source: 'uploaded',
    pem: joinPem(keyPem, row.certificate, row.caBundle),
    certificatePem: row.certificate,
    domainName: domain.domainName,
    expiresAt: row.expiresAt ?? parseExpiry(row.certificate),
  };
}
