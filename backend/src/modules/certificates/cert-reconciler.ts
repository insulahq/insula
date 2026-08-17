/**
 * Certificate status reconciler.
 *
 * Runs every 60 seconds (registered from app.ts alongside the deployment
 * status reconciler). For each domain with `sslAutoRenew = 1` it:
 *
 *   1. Reads the TLS Secret created by cert-manager (wildcard first, then
 *      per-hostname) in the tenant's kubernetesNamespace.
 *   2. Parses the X.509 certificate from the Secret to extract issuer,
 *      subject, and expiry.
 *   3. Upserts a row into `ssl_certificates` so the admin/tenant panels
 *      can display real certificate status without live K8s queries on
 *      every page load.
 *
 * Design notes:
 *   - The reconciler never overwrites `certificate` / `privateKeyEncrypted`
 *     for rows that already exist — those fields are only meaningful for
 *     manually uploaded certs (via ssl-certs/service.ts). For cert-manager
 *     managed rows the actual PEM lives in the K8s Secret; the DB row
 *     stores a sentinel placeholder.
 *   - If no TLS Secret exists yet (cert still pending), the reconciler
 *     skips the domain — the UI falls back to "Pending" from the
 *     enrichment logic.
 */

import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { certCoversHostname } from '@insula/api-contracts';
import { domains, sslCertificates, tenants } from '../../db/schema.js';
import { tlsSecretNameFor } from './service.js';
import { listCertificateHealth, shouldFallBack } from './status.js';
import type { CertificateHealth } from './status.js';
import {
  notifyAdminCertExpiring,
  notifyAdminCertIssuanceFailed,
  notifyAdminCertRenewalFailed,
  notifyTenantCertificateFailed,
  notifyTenantCertificateFallback,
} from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface DomainRow {
  readonly domainId: string;
  readonly domainName: string;
  readonly tenantId: string;
  readonly namespace: string | null;
}

/**
 * The Certificate that represents a domain's TLS state.
 *
 * A domain can own several: the domain-level cert, per-hostname certs,
 * and sub-wildcards from wildcard routes. The domain-level one is what
 * the panels report on, so prefer a cert whose SANs actually cover the
 * domain name, wildcard first.
 */
export function pickDomainCertificate(
  certs: readonly CertificateHealth[],
  domainId: string,
  domainName: string,
): CertificateHealth | null {
  const mine = certs.filter(
    (c) => c.domainId === domainId || certCoversHostname(domainName, c.dnsNames),
  );
  if (mine.length === 0) return null;
  return (
    mine.find((c) => c.wildcard && certCoversHostname(domainName, c.dnsNames)) ??
    mine.find((c) => certCoversHostname(domainName, c.dnsNames)) ??
    mine[0]
  );
}

/**
 * Persist what cert-manager reports, and tell someone when it is bad.
 *
 * Notifications are edge-triggered on the stored status, so a domain
 * stuck failing for a week produces one notification, not one per
 * reconcile tick. `dispatchSafe` never throws.
 */
async function recordCertificateState(
  db: Database,
  d: DomainRow,
  health: CertificateHealth,
): Promise<void> {
  const [existing] = await db
    .select({
      id: sslCertificates.id,
      status: sslCertificates.status,
      fallbackActive: sslCertificates.fallbackActive,
    })
    .from(sslCertificates)
    .where(eq(sslCertificates.domainId, d.domainId));

  const now = new Date();
  const failed = health.state === 'failed';
  const fallback = shouldFallBack(health, now);
  const errorMessage = health.message?.slice(0, 500);

  const stateFields = {
    status: health.state,
    issuerName: health.issuerName ?? null,
    isWildcard: health.wildcard ? 1 : 0,
    fallbackActive: fallback ? 1 : 0,
    ...(failed ? { lastError: errorMessage ?? null, lastErrorAt: health.lastFailureAt ?? now } : {}),
    ...(health.state === 'issued' ? { lastIssuedAt: now, lastError: null } : {}),
    updatedAt: now,
  };

  if (existing) {
    await db.update(sslCertificates).set(stateFields).where(eq(sslCertificates.id, existing.id));
  } else {
    // No row yet: the domain has NEVER had a certificate parsed from a
    // Secret. That is exactly the case the old reconciler dropped on the
    // floor — and the one an operator most needs to see.
    await db.insert(sslCertificates).values({
      id: crypto.randomUUID(),
      domainId: d.domainId,
      tenantId: d.tenantId,
      certificate: '# Managed by cert-manager',
      privateKeyEncrypted: '# Managed by cert-manager',
      subject: health.wildcard ? `*.${d.domainName}` : d.domainName,
      createdAt: now,
      ...stateFields,
    });
  }

  const wasFailed = existing?.status === 'failed';
  if (failed && !wasFailed) {
    const dedupeKey = `cert-failed:${d.domainName}:${health.lastFailureAt?.toISOString() ?? now.toISOString()}`;
    await notifyTenantCertificateFailed(
      db,
      d.tenantId,
      { hostname: d.domainName, errorMessage },
      dedupeKey,
    );
    await notifyAdminCertIssuanceFailed(
      db,
      { certSubject: d.domainName, errorMessage },
      dedupeKey,
    );
  }

  const wasFallback = (existing?.fallbackActive ?? 0) === 1;
  if (fallback && !wasFallback) {
    await notifyTenantCertificateFallback(
      db,
      d.tenantId,
      { hostname: d.domainName, errorMessage },
      `cert-fallback:${d.domainName}:${health.lastFailureAt?.toISOString() ?? now.toISOString()}`,
    );
  }
}

// ─── K8s error helpers ──────────────────────────────────────────────────────

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

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CertReconcileResult {
  readonly checked: number;
  readonly synced: number;
  readonly errors: readonly string[];
}

export async function reconcileCertificateStatuses(
  db: Database,
  k8s: K8sClients,
): Promise<CertReconcileResult> {
  // Get all domains with auto-TLS enabled, joined with their tenant's namespace
  const domainsWithTenants = await db
    .select({
      domainId: domains.id,
      domainName: domains.domainName,
      tenantId: domains.tenantId,
      namespace: tenants.kubernetesNamespace,
    })
    .from(domains)
    .innerJoin(tenants, eq(domains.tenantId, tenants.id))
    .where(eq(domains.sslAutoRenew, 1));

  let checked = 0;
  let synced = 0;
  const errors: string[] = [];
  // One Certificate list per namespace, not per domain — a tenant with
  // twenty domains would otherwise issue twenty identical LISTs.
  const certsByNamespace = new Map<string, readonly CertificateHealth[]>();

  for (const d of domainsWithTenants) {
    if (!d.namespace) continue;
    checked++;

    // What cert-manager reports, independent of whether a Secret exists.
    // This is the half that was missing: a Certificate that never
    // completed produced no Secret, and "no Secret" was read as "still
    // issuing, skip", so a permanently failed order was silent forever.
    try {
      if (!certsByNamespace.has(d.namespace)) {
        certsByNamespace.set(d.namespace, await listCertificateHealth(k8s, d.namespace));
      }
      const health = pickDomainCertificate(
        certsByNamespace.get(d.namespace) ?? [],
        d.domainId,
        d.domainName,
      );
      if (health) {
        await recordCertificateState(db, d, health);
      }
    } catch (err) {
      errors.push(`${d.domainName}: status read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      // Try to read the TLS secret for this domain.
      // Wildcard first (covers apex + all immediate subdomains), then
      // per-hostname as fallback (HTTP-01 mode).
      const wildcardSecretName = tlsSecretNameFor(d.domainName, true);
      const perHostSecretName = tlsSecretNameFor(d.domainName, false);

      let secretData: Record<string, string> | undefined;
      let isWildcard = false;

      for (const [name, wc] of [[wildcardSecretName, true], [perHostSecretName, false]] as const) {
        try {
          const result = await k8s.core.readNamespacedSecret({
            name,
            namespace: d.namespace,
          });
          if (result?.data?.['tls.crt']) {
            secretData = result.data;
            isWildcard = wc;
            break;
          }
        } catch (err: unknown) {
          if (!isK8s404(err)) throw err;
          // 404 = secret doesn't exist yet, try next variant
        }
      }

      if (!secretData?.['tls.crt']) {
        // No TLS secret found — cert is still pending or not provisioned.
        // Don't write anything to DB — the badge will show "Pending" from
        // the enrichment logic.
        continue;
      }

      // Decode the base64 PEM cert and extract metadata via Node's
      // built-in X509Certificate API.
      const pemB64 = secretData['tls.crt'];
      const pem = Buffer.from(pemB64, 'base64').toString('utf8');

      let issuer = 'Unknown';
      let subject = d.domainName;
      let expiresAt: Date | null = null;

      try {
        const x509 = new crypto.X509Certificate(pem);
        issuer =
          x509.issuer
            .split('\n')
            .find((l) => l.startsWith('O='))
            ?.replace('O=', '') ?? x509.issuer;
        subject =
          x509.subject
            .split('\n')
            .find((l) => l.startsWith('CN='))
            ?.replace('CN=', '') ?? d.domainName;
        expiresAt = new Date(x509.validTo);
      } catch {
        // PEM parsing failed — still write the row with defaults
      }

      // Upsert into ssl_certificates
      const [existing] = await db
        .select({ id: sslCertificates.id })
        .from(sslCertificates)
        .where(eq(sslCertificates.domainId, d.domainId));

      const now = new Date();

      if (existing) {
        await db
          .update(sslCertificates)
          .set({
            issuer,
            subject: isWildcard ? `*.${d.domainName}` : subject,
            expiresAt,
            updatedAt: now,
            // Don't overwrite certificate/privateKeyEncrypted — those are
            // only for manually uploaded certs
          })
          .where(eq(sslCertificates.id, existing.id));
      } else {
        await db.insert(sslCertificates).values({
          id: crypto.randomUUID(),
          domainId: d.domainId,
          tenantId: d.tenantId,
          // Store a placeholder — the actual cert is in the K8s Secret
          certificate: '# Managed by cert-manager',
          privateKeyEncrypted: '# Managed by cert-manager',
          issuer,
          subject: isWildcard ? `*.${d.domainName}` : subject,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });
      }
      synced++;

      // Phase 6A: emit `admin.cert_expiring` when this cert is within
      // 15 days of expiry. The dispatcher's dedupeKey suppresses
      // re-fires within the 30-day audit window, so the reconciler
      // ticking every N minutes only sends each operator one warning
      // per (cert, expiry-date).
      if (expiresAt) {
        const daysUntilExpiry = Math.floor((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        if (daysUntilExpiry <= 15) {
          const dedupeKey = `cert-expiring:${d.domainName}:${expiresAt.toISOString().slice(0, 10)}`;
          await notifyAdminCertExpiring(db, {
            certSubject: isWildcard ? `*.${d.domainName}` : (subject ?? d.domainName),
            expiresAt: expiresAt.toISOString(),
          }, dedupeKey);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${d.domainName}: ${msg}`);
      // Phase 6A: cert sync failure → admin.cert_renewal_failed.
      // Best-effort: dispatchSafe never throws so a notification path
      // error doesn't compound the original failure.
      await notifyAdminCertRenewalFailed(db, {
        certSubject: d.domainName,
        errorMessage: msg.slice(0, 500),
      });
    }
  }

  return { checked, synced, errors };
}
