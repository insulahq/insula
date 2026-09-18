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
import { tenantSafeCertError } from './tenant-error.js';
import crypto from 'crypto';
import { certCoversHostname } from '@insula/api-contracts';
import { domains, sslCertificates, tenants } from '../../db/schema.js';
import { tlsSecretNameFor } from './service.js';
import { listCertificateHealth, shouldFallBack } from './status.js';
import type { CertificateHealth } from './status.js';
import {
  notifyAdminCertCheckResumed,
  notifyAdminCertCheckUnavailable,
  notifyAdminCertExpiring,
  notifyAdminCertIssuanceFailed,
  notifyAdminCertRecovered,
  notifyAdminCertRenewalFailed,
  notifyTenantCertificateFailed,
  notifyTenantCertificateFallback,
  notifyTenantCertificateIssued,
} from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import { createWedgeMemory } from './acme-challenges.js';
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
      // Needed to tell a RENEWAL failure from a first-issuance failure, and to
      // recognise a recovery. Without it every failure read as issuance.
      lastIssuedAt: sslCertificates.lastIssuedAt,
      expiresAt: sslCertificates.expiresAt,
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
  // A certificate that HAS been issued before and is now failing is a renewal
  // failure; one that never issued is a first-issuance failure. The category
  // seed has always claimed this distinction ("Distinct from
  // cert_renewal_failed: this is FIRST issuance") — nothing implemented it, so
  // every renewal failure was reported as issuance, and the renewal category
  // was left to be fired by a code path that only ever read Secrets.
  const everIssued = existing?.lastIssuedAt != null;
  if (failed && !wasFailed) {
    const dedupeKey = `cert-failed:${d.domainName}:${health.lastFailureAt?.toISOString() ?? now.toISOString()}`;
    // The tenant gets a translation; the OPERATOR gets the raw cert-manager
    // text, because that is the half that actually diagnoses the failure.
    await notifyTenantCertificateFailed(
      db,
      d.tenantId,
      { hostname: d.domainName, errorMessage: tenantSafeCertError(errorMessage) },
      dedupeKey,
    );
    if (everIssued) {
      await notifyAdminCertRenewalFailed(
        db,
        { certSubject: d.domainName, errorMessage },
        dedupeKey,
      );
    } else {
      await notifyAdminCertIssuanceFailed(
        db,
        { certSubject: d.domainName, errorMessage },
        dedupeKey,
      );
    }
  }

  // The closing half. Two real wildcard failures on production were reported
  // twice each and their successful retry was never announced, so the newest
  // word an operator had was "failed" — seventeen days after it was fine.
  if (wasFailed && health.state === 'issued') {
    const dedupeKey = `cert-recovered:${d.domainName}:${(health.notAfter ?? now).toISOString()}`;
    await notifyAdminCertRecovered(
      db,
      {
        certSubject: health.wildcard ? `*.${d.domainName}` : d.domainName,
        expiresAt: (health.notAfter ?? now).toISOString(),
        previousState: everIssued ? 'failing to renew' : 'failing to be issued',
      },
      dedupeKey,
    );
    // The tenant was told it failed, so the tenant is told it is fixed. This
    // category and its templates already existed; nothing called them on a
    // recovery.
    await notifyTenantCertificateIssued(
      db,
      d.tenantId,
      { hostname: d.domainName, expiresAt: (health.notAfter ?? now).toISOString() },
      dedupeKey,
    );
  }

  const wasFallback = (existing?.fallbackActive ?? 0) === 1;
  if (fallback && !wasFallback) {
    await notifyTenantCertificateFallback(
      db,
      d.tenantId,
      { hostname: d.domainName, errorMessage: tenantSafeCertError(errorMessage) },
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

/**
 * Did this error mean "the Kubernetes API was not reachable", as opposed to
 * "the API answered, and the answer was bad news about this one certificate"?
 *
 * The distinction is the whole reason this helper exists. A brief API blackout
 * once produced dozens of notifications in one second — one per domain, every
 * one titled "Cert renewal failed", none of them true. Nothing had failed to
 * renew: the reconciler simply could not READ the Secrets.
 *
 * undici reports a connection it never completed as the bare string
 * `fetch failed`, with the real reason on `.cause`. Both are checked, plus the
 * status codes an overloaded or restarting apiserver returns.
 */
function isDependencyUnreachable(err: unknown): boolean {
  const code = k8sStatusCode(err);
  // 503/504 come from an apiserver that is up but not serving; 502 from a
  // proxy in front of one that is not.
  if (code === 502 || code === 503 || code === 504) return true;

  const codesInCauseChain: string[] = [];
  const messages: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const e = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.message === 'string') messages.push(e.message);
    if (typeof e.code === 'string') codesInCauseChain.push(e.code);
    cur = e.cause;
  }

  const TRANSPORT_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
    'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ]);
  if (codesInCauseChain.some((c) => TRANSPORT_CODES.has(c))) return true;

  // undici's generic surface for a request that never completed. Matched as a
  // whole message, not a substring of a longer sentence, so a cert-manager
  // error that happens to contain the words cannot be mistaken for one.
  return messages.some((m) => m.trim() === 'fetch failed' || m.trim() === 'TypeError: fetch failed');
}

/**
 * Sweep-availability state.
 *
 * Survives ticks, not restarts — deliberately, like `wedgeMemory` above. A
 * fresh process starts with no strikes, so the first sweep after a deploy only
 * observes. Each replica in an HA deployment keeps its own count; the dedupe
 * key (one per outage day) is what stops two replicas double-notifying.
 */
let consecutiveUnavailableSweeps = 0;
let unavailableSince: Date | null = null;
let unavailableNotified = false;

/**
 * A single failed sweep is not worth an operator's attention.
 *
 * The reconciler runs every 60 seconds. The production outage that prompted
 * all of this lasted 21 seconds: by the time anyone could have read a
 * notification about it, the next sweep had already succeeded. So the alarm
 * waits for a SECOND consecutive failure — i.e. the fault has outlived a
 * retry — and then fires exactly once, for the outage rather than for each
 * certificate.
 */
const UNAVAILABLE_SWEEPS_BEFORE_ALARM = 2;

function humaniseDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins === 1) return 'about a minute';
  if (mins < 60) return `about ${mins} minutes`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? 'about an hour' : `about ${hrs} hours`;
}

async function reportSweepAvailability(
  db: Database,
  unreachable: CertReconcileResult['unreachable'],
  now: Date,
): Promise<void> {
  if (unreachable) {
    consecutiveUnavailableSweeps++;
    unavailableSince ??= now;
    if (consecutiveUnavailableSweeps >= UNAVAILABLE_SWEEPS_BEFORE_ALARM && !unavailableNotified) {
      unavailableNotified = true;
      await notifyAdminCertCheckUnavailable(
        db,
        {
          dependency: 'the Kubernetes API',
          uncheckedCount: String(unreachable.unchecked),
          // The raw transport error, labelled as what it is. "fetch failed"
          // alone was the whole message operators used to get.
          detail: `The platform reported: ${unreachable.reason}`,
          recommendedAction:
            'Check the cluster control plane — this is a connectivity problem, not a certificate '
            + 'problem. Checks resume automatically within a minute of the API answering again.',
        },
        // One per outage, per day: a multi-hour outage does not re-alarm every
        // minute, and a new outage tomorrow is still reported.
        `cert-check-unavailable:${now.toISOString().slice(0, 10)}`,
      );
    }
    return;
  }

  if (unavailableNotified) {
    const outageMs = now.getTime() - (unavailableSince?.getTime() ?? now.getTime());
    await notifyAdminCertCheckResumed(
      db,
      {
        dependency: 'the Kubernetes API',
        outageLabel: humaniseDuration(outageMs),
        certificateSummary: 'Certificate status is being read again; nothing expired meanwhile.',
      },
      `cert-check-resumed:${now.toISOString()}`,
    );
  }
  consecutiveUnavailableSweeps = 0;
  unavailableSince = null;
  unavailableNotified = false;
}

/** Test seam: the module-level strike counter would otherwise leak between tests. */
export function __resetSweepAvailabilityForTests(): void {
  consecutiveUnavailableSweeps = 0;
  unavailableSince = null;
  unavailableNotified = false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CertReconcileResult {
  readonly checked: number;
  readonly synced: number;
  /** Wedged ACME challenges deleted so issuance could restart. */
  readonly healedChallenges: number;
  readonly errors: readonly string[];
  /**
   * Set when the sweep was abandoned because the Kubernetes API could not be
   * reached. `unchecked` counts the domains never looked at, so the operator
   * is told the scale of what is unknown rather than a per-domain verdict the
   * reconciler is in no position to give.
   */
  readonly unreachable: { readonly reason: string; readonly unchecked: number } | null;
}

/**
 * Clear wedged ACME challenges for one namespace.
 *
 * Runs on the same tick as the status sync because a wedge is invisible in the
 * Certificate CR — it looks like an order that is simply taking a while, and
 * cert-manager never times the challenge out on its own. Without this the
 * blockage is permanent and no amount of re-requesting clears it.
 */
/**
 * Survives ticks, not restarts — see WedgeMemory. A fresh process deliberately
 * starts with no strikes so the first sweep after any gap only observes.
 */
const wedgeMemory = createWedgeMemory();

/** Repeat clears per namespace, so a churn loop reads differently from a one-off. */
const healCounts = new Map<string, number>();

/**
 * Challenge sweeps run far less often than the 60s status tick. A wedge is
 * already 30 minutes old before it qualifies, so checking every 5 minutes
 * loses nothing and keeps the extra API-server LISTs proportionate at
 * 50-100 tenants.
 */
const NAMESPACE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const lastSweepAt = new Map<string, number>();

async function selfHealNamespace(
  k8s: K8sClients,
  namespace: string,
  errors: string[],
): Promise<number> {
  try {
    const { clearWedgedChallenges } = await import('./acme-challenges.js');
    const res = await clearWedgedChallenges(k8s, namespace, { memory: wedgeMemory });
    for (const e of res.errors) errors.push(`challenge cleanup ${namespace}: ${e}`);
    if (res.deleted.length > 0) {
      // Count repeats per namespace. A wedge with a permanent cause — a still
      // mispointed NS record — will be cleared, recreated, re-wedge and be
      // cleared again indefinitely. That is still better than silent permanent
      // failure, but it must not look like a one-off recovery in the log, or
      // nobody ever investigates the cause.
      const seen = (healCounts.get(namespace) ?? 0) + res.deleted.length;
      healCounts.set(namespace, seen);
      // eslint-disable-next-line no-console
      console.warn(
        `[cert-reconciler] cleared ${res.deleted.length} wedged ACME challenge(s) in ${namespace}: ${res.deleted.join(', ')}`
        + (seen > res.deleted.length
          ? ` — ${seen} cleared here since restart; a repeating wedge means the underlying cause is still present`
          : ''),
      );
    }
    return res.deleted.length;
  } catch (err) {
    errors.push(`challenge cleanup ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
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
  let healedChallenges = 0;
  const errors: string[] = [];
  let unreachable: CertReconcileResult['unreachable'] = null;
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
        // Sweep on a slower cadence than the 60s tick, rather than gating on
        // certificate health.
        //
        // The first version skipped a namespace whose certificates all looked
        // issued. That is wrong twice over: listCertificateHealth filters on
        // `app.kubernetes.io/managed-by=insula`, so anything else is invisible
        // to it, and a challenge ORPHANED by a deleted Certificate — the very
        // case this module exists to clear — leaves no unfinished certificate
        // behind to trigger the sweep. The gate made the self-heal unreachable
        // for the orphan it was written for.
        //
        // Time-based instead: correctness does not depend on what the gate can
        // see, and the API-server cost is still cut by the same order of
        // magnitude the gate was added for.
        const lastSwept = lastSweepAt.get(d.namespace) ?? 0;
        if (Date.now() - lastSwept >= NAMESPACE_SWEEP_INTERVAL_MS) {
          lastSweepAt.set(d.namespace, Date.now());
          healedChallenges += await selfHealNamespace(k8s, d.namespace, errors);
        }
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

      // A dependency that is DOWN is one event, not one event per domain.
      // Abandon the sweep: every remaining domain would fail identically, so
      // continuing buys 28 more failed requests and 28 more alarms. The
      // aggregate is reported by the caller instead — see `unreachable`.
      if (isDependencyUnreachable(err)) {
        unreachable = { reason: msg.slice(0, 300), unchecked: domainsWithTenants.length - checked + 1 };
        break;
      }

      // Anything else is specific to this one domain (an unparseable PEM, a
      // forbidden Secret, a failed write). It goes in `errors`, which the
      // caller logs as a warning. It deliberately does NOT notify: this block
      // only ever READS certificate state, so it can report that a check
      // failed but never that a renewal did. A genuine renewal failure is
      // detected where it is actually visible — in recordCertificateState,
      // when a certificate that WAS issued goes back to failed.
    }
  }

  await reportSweepAvailability(db, unreachable, new Date());

  return { checked, synced, healedChallenges, errors, unreachable };
}
