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

import { X509Certificate } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { domains, tenants, sslCertificates } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { tlsSecretNameFor } from '../certificates/service.js';
import type { CertBundleSource } from '@insula/api-contracts';

/** Mirrors certificates/cert-reconciler.ts — a 404 is "absent", anything else is a fault. */
function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number } };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (err instanceof Error) {
    const m = err.message.match(/HTTP-Code:\s*(\d{3})/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function isK8s404(err: unknown): boolean {
  return k8sStatusCode(err) === 404;
}

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

/**
 * Leaf expiry, or null when the PEM cannot be parsed.
 *
 * Uses a TOP-LEVEL import. An earlier revision lazily `require()`d node:crypto
 * here, which is a silent no-op trap: the backend is ESM (`"type": "module"`),
 * so `require` is not defined at runtime and the call threw `ReferenceError`
 * into this function's own catch — meaning `expiresAt` was null for EVERY
 * managed certificate in production while every test passed, because Vitest's
 * runner polyfills `require`. Keep this a static import.
 */
function parseExpiry(certPem: string): Date | null {
  try {
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
async function readManagedSecret(
  k8s: K8sClients,
  namespace: string,
  domainName: string,
  want: 'cert-only' | 'cert-and-key',
): Promise<{ certPem: string; keyPem: string | null } | null> {
  for (const wildcard of [true, false]) {
    const name = tlsSecretNameFor(domainName, wildcard);
    let secret: { data?: Record<string, string> };
    try {
      secret = await k8s.core.readNamespacedSecret({ name, namespace }) as typeof secret;
    } catch (err) {
      // Only "the Secret isn't there" means try the next variant. Anything
      // else — an RBAC 403, a network blip, a malformed response — must NOT
      // masquerade as "no certificate exists": that silently degrades a
      // managed domain to its (possibly superseded) uploaded certificate, or
      // to a 404, with nothing for an operator to go on.
      if (!isK8s404(err)) throw err;
      continue;
    }
    const crt = secret.data?.['tls.crt'];
    if (!crt) continue;
    const key = secret.data?.['tls.key'];
    // A Secret with no key cannot produce a usable bundle; keep looking.
    if (want === 'cert-and-key' && !key) continue;
    return {
      certPem: Buffer.from(crt, 'base64').toString('utf8'),
      keyPem: key ? Buffer.from(key, 'base64').toString('utf8') : null,
    };
  }
  return null;
}

/**
 * Does this domain have something downloadable, and when does it expire?
 *
 * Deliberately separate from `buildCertBundle`: the availability probe fires
 * on every SSL-tab page load, including for `support`, who is barred from ever
 * holding the private key. Reusing the full builder decrypted the customer's
 * key into process memory just to render a boolean and a date. This path
 * touches `tls.crt` / `certificate` only and never the key.
 */
export async function probeCertAvailability(
  db: Database,
  k8s: K8sClients | null,
  domain: DomainRef,
): Promise<{ source: CertBundleSource; expiresAt: Date | null } | null> {
  if (k8s && domain.namespace) {
    const managed = await readManagedSecret(k8s, domain.namespace, domain.domainName, 'cert-only');
    if (managed) return { source: 'managed', expiresAt: parseExpiry(managed.certPem) };
  }
  const [row] = await db
    .select({ certificate: sslCertificates.certificate, expiresAt: sslCertificates.expiresAt })
    .from(sslCertificates)
    .where(and(
      eq(sslCertificates.domainId, domain.domainId),
      eq(sslCertificates.tenantId, domain.tenantId),
    ))
    .limit(1);
  if (!row) return null;
  return { source: 'uploaded', expiresAt: row.expiresAt ?? parseExpiry(row.certificate) };
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
    const managed = await readManagedSecret(k8s, domain.namespace, domain.domainName, 'cert-and-key');
    if (managed?.keyPem) {
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
