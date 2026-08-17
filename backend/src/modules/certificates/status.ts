/**
 * Reading what cert-manager actually thinks of a Certificate.
 *
 * The status reconciler used to infer state purely from the presence of
 * a TLS Secret: Secret there → issued, Secret absent → "still pending,
 * skip". That reads a permanently failed order as an in-progress one
 * forever, which is why a wildcard order pointed at a missing solver
 * could stall for weeks with nothing reported to anyone.
 *
 * The Certificate CR carries the truth in `status.conditions`, plus a
 * failure counter and timestamp. This module turns that into a small
 * closed set of states the rest of the platform can act on.
 */

import { CERTMANAGER_GROUP, CERTMANAGER_VERSION, CERTIFICATE_PLURAL } from '../ingress-routes/traefik-types.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type CertificateState = 'issued' | 'issuing' | 'failed' | 'unknown';

export interface CertificateCondition {
  readonly type?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
}

export interface CertificateResourceStatus {
  readonly conditions?: readonly CertificateCondition[];
  readonly notAfter?: string;
  readonly notBefore?: string;
  readonly renewalTime?: string;
  readonly lastFailureTime?: string;
  readonly failedIssuanceAttempts?: number;
}

export interface CertificateResource {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly spec?: {
    readonly dnsNames?: readonly string[];
    readonly secretName?: string;
    readonly issuerRef?: { readonly name?: string };
  };
  readonly status?: CertificateResourceStatus;
}

export interface CertificateHealth {
  readonly name: string;
  /** From the `insula.host/domain-id` label, when the CR carries one. */
  readonly domainId?: string;
  readonly state: CertificateState;
  readonly secretName?: string;
  readonly issuerName?: string;
  readonly dnsNames: readonly string[];
  /** Operator-facing reason the order is not complete. */
  readonly message?: string;
  readonly failedAttempts: number;
  readonly lastFailureAt?: Date;
  readonly notAfter?: Date;
  /** True when the SANs include a wildcard. */
  readonly wildcard: boolean;
}

function condition(
  status: CertificateResourceStatus | undefined,
  type: string,
): CertificateCondition | undefined {
  return status?.conditions?.find((c) => c.type === type);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Classify a Certificate CR.
 *
 * `issuing` and `failed` are deliberately distinct: cert-manager retries
 * a failed order with backoff, so "failed" does not mean "given up" —
 * it means at least one attempt has been rejected and the operator has
 * something to act on. A cert with no status at all is `unknown`, not
 * `issuing`, so a CR the API has not observed yet cannot be mistaken for
 * healthy progress.
 */
export function classifyCertificate(resource: CertificateResource): CertificateHealth {
  const status = resource.status;
  const ready = condition(status, 'Ready');
  const issuing = condition(status, 'Issuing');
  const dnsNames = resource.spec?.dnsNames ?? [];
  const failedAttempts = status?.failedIssuanceAttempts ?? 0;
  const lastFailureAt = parseDate(status?.lastFailureTime);

  let state: CertificateState;
  if (ready?.status === 'True') {
    state = 'issued';
  } else if (failedAttempts > 0 || lastFailureAt) {
    state = 'failed';
  } else if (ready?.status === 'False' || issuing?.status === 'True') {
    state = 'issuing';
  } else {
    state = 'unknown';
  }

  // Prefer whichever condition actually explains the hold-up. The Ready
  // message on a stuck order is often the generic "Issuing certificate
  // as Secret does not exist", while Issuing carries the real reason.
  const message =
    (state === 'issued' ? undefined : issuing?.message || ready?.message) ?? undefined;

  return {
    name: resource.metadata?.name ?? '(unnamed)',
    domainId: resource.metadata?.labels?.['insula.host/domain-id'],
    state,
    secretName: resource.spec?.secretName,
    issuerName: resource.spec?.issuerRef?.name,
    dnsNames,
    message,
    failedAttempts,
    lastFailureAt,
    notAfter: parseDate(status?.notAfter),
    wildcard: dnsNames.some((n) => n.startsWith('*.')),
  };
}

/**
 * How long an order may sit un-issued before the platform stops waiting
 * and puts a working per-hostname certificate in front of the tenant.
 *
 * 15 minutes is comfortably longer than a healthy DNS-01 round trip
 * (propagation self-check plus validation is usually well under two),
 * and short enough that a tenant is not looking at a browser warning for
 * an hour while an operator debugs their DNS credentials.
 */
export const FALLBACK_GRACE_MS = 15 * 60 * 1000;

/**
 * Should we stop waiting for this certificate and fall back?
 *
 * Only wildcard certs are eligible: a failing per-hostname cert has
 * nothing to fall back TO, and falling back from a wildcard is exactly
 * the capability downgrade (one cert for the zone → one cert per
 * hostname) that keeps sites serving valid TLS while the wildcard is
 * retried in the background.
 */
export function shouldFallBack(
  health: CertificateHealth,
  now: Date,
  graceMs = FALLBACK_GRACE_MS,
): boolean {
  if (!health.wildcard) return false;
  if (health.state === 'issued') return false;
  if (health.state !== 'failed') return false;
  if (!health.lastFailureAt) return false;
  return now.getTime() - health.lastFailureAt.getTime() >= graceMs;
}

/** Fetch and classify one Certificate CR. Returns null on 404. */
export async function readCertificateHealth(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<CertificateHealth | null> {
  try {
    const resource = (await k8s.custom.getNamespacedCustomObject({
      group: CERTMANAGER_GROUP,
      version: CERTMANAGER_VERSION,
      namespace,
      plural: CERTIFICATE_PLURAL,
      name,
    } as never)) as CertificateResource;
    return classifyCertificate(resource);
  } catch {
    return null;
  }
}

/** All platform-managed Certificates in a namespace, classified. */
export async function listCertificateHealth(
  k8s: K8sClients,
  namespace: string,
): Promise<readonly CertificateHealth[]> {
  try {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: CERTMANAGER_GROUP,
      version: CERTMANAGER_VERSION,
      namespace,
      plural: CERTIFICATE_PLURAL,
      labelSelector: 'app.kubernetes.io/managed-by=insula',
    } as never)) as { items?: CertificateResource[] };
    return (list.items ?? []).map(classifyCertificate);
  } catch {
    return [];
  }
}
