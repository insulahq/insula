/**
 * On-demand certificate reissue.
 *
 * Automatic issuance is the normal path; this is the escape hatch for
 * when it has failed and the tenant has just fixed the cause — pointed
 * DNS at the platform, enabled primary DNS mode, corrected provider
 * credentials. cert-manager's own retry backoff can be an hour long at
 * that point, and "wait, it might fix itself" is not an answer to give
 * someone staring at a browser warning.
 *
 * Deleting the Certificate CR and recreating it forces a brand-new
 * order instead of waiting for the renewal window, which is what makes
 * this actually do something.
 */

import { eq } from 'drizzle-orm';
import { toSafeText } from '@insula/api-contracts';
import { domains, sslCertificates, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import * as tasks from '../tasks/service.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { deleteDomainCertificate, ensureDomainCertificate, certificateNameFor } from './service.js';
import { readCertificateHealth } from './status.js';
import { notifyTenantCertificateIssued } from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Minimum gap between manual reissues of the same domain.
 *
 * Let's Encrypt caps duplicate certificates — the same exact SAN set —
 * at 5 per week. An unthrottled button lets a tenant burn that in a
 * minute and then be locked out for seven days, which is a far worse
 * outcome than waiting an hour.
 */
export const REISSUE_COOLDOWN_MS = 60 * 60 * 1000;

/** How long the task waits for cert-manager before reporting back. */
const ISSUANCE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

export interface ReissueRequest {
  readonly domainId: string;
  readonly tenantId: string;
  readonly userId: string;
  /** 'tenant' for the tenant panel, 'admin' for the admin panel. */
  readonly scope: 'tenant' | 'admin';
}

export interface ReissueResult {
  readonly taskId: string;
  readonly domainId: string;
  readonly certificateName: string;
}

function cooldownRemaining(lastReissueAt: Date | null, now: Date): number {
  if (!lastReissueAt) return 0;
  return Math.max(0, REISSUE_COOLDOWN_MS - (now.getTime() - lastReissueAt.getTime()));
}

/**
 * Start a reissue. Returns as soon as the task exists — the work runs in
 * the background and reports through the task centre.
 */
export async function requestCertificateReissue(
  db: Database,
  k8s: K8sClients | null,
  request: ReissueRequest,
): Promise<ReissueResult> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, request.domainId));
  if (!domain || domain.tenantId !== request.tenantId) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${request.domainId}' not found`, 404);
  }

  if (!k8s) {
    throw new ApiError(
      'CLUSTER_UNAVAILABLE',
      'The platform cannot reach the cluster, so no certificate can be requested right now.',
      503,
      {
        operatorError: {
          code: 'CLUSTER_UNAVAILABLE',
          title: 'Cluster unavailable',
          detail: 'platform-api has no Kubernetes client, so cert-manager resources cannot be written.',
          remediation: ['Check platform-api logs and the cluster connection, then retry.'],
          retryable: true,
        },
      },
    );
  }

  if (!(await isAutoTlsEnabled(db))) {
    throw new ApiError(
      'AUTO_TLS_DISABLED',
      'Automatic TLS is disabled for this platform, so certificates are not managed here.',
      409,
      {
        operatorError: {
          code: 'AUTO_TLS_DISABLED',
          title: 'Automatic TLS is off',
          detail: 'Certificates are managed outside the platform while auto-TLS is disabled.',
          remediation: ['Enable automatic TLS in Settings → TLS, or upload a certificate manually.'],
          retryable: false,
        },
      },
    );
  }

  const [certRow] = await db
    .select({ id: sslCertificates.id, lastReissueAt: sslCertificates.lastReissueAt })
    .from(sslCertificates)
    .where(eq(sslCertificates.domainId, request.domainId));

  const now = new Date();
  const remaining = cooldownRemaining(certRow?.lastReissueAt ?? null, now);
  if (remaining > 0) {
    const availableAt = new Date(now.getTime() + remaining);
    throw new ApiError(
      'REISSUE_COOLDOWN',
      `A certificate for '${domain.domainName}' was already requested recently. Try again after ${availableAt.toISOString()}.`,
      429,
      {
        availableAt: availableAt.toISOString(),
        operatorError: {
          code: 'REISSUE_COOLDOWN',
          title: 'Recently requested',
          detail:
            `A new certificate for ${domain.domainName} was requested less than an hour ago. ` +
            `Certificate authorities limit how many identical certificates may be issued per week, so the ` +
            `platform spaces manual requests out.`,
          remediation: [
            'Wait for the cooldown to expire, then try again.',
            'Check the certificate status — an order may already be in progress.',
          ],
          retryable: true,
        },
      },
    );
  }

  const { id: taskId } = await tasks.start(db, {
    kind: 'tls.cert-reissue',
    refId: request.domainId,
    scope: request.scope,
    userId: request.userId,
    tenantId: request.tenantId,
    label: toSafeText(`Reissue TLS certificate for ${domain.domainName}`),
    // The admin panel's task chip can re-open a progress modal; the
    // tenant panel's chip deliberately carries no modal registry, so a
    // modal target there would be a dead click. Send tenants to the page
    // that shows the same state instead.
    target:
      request.scope === 'admin'
        ? { type: 'modal', modal: 'tls-cert-reissue', modalProps: {} }
        : { type: 'route', href: '/domains' },
    progressPct: 0,
    progressText: toSafeText('Starting'),
    details: {
      domainName: domain.domainName,
      steps: REISSUE_STEPS.map((name) => ({ name, state: 'pending' as const })),
    },
  });

  await db
    .update(sslCertificates)
    .set({ lastReissueAt: now })
    .where(eq(sslCertificates.domainId, request.domainId));

  // Fire-and-forget with a mandatory catch: an unhandled rejection here
  // takes the API process down.
  void runReissue(db, k8s, taskId, request).catch(async (err) => {
    await tasks
      .finish(db, taskId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
      .catch(() => undefined);
  });

  return {
    taskId,
    domainId: request.domainId,
    certificateName: certificateNameFor(domain.domainName, false),
  };
}

const REISSUE_STEPS = [
  'Remove the previous certificate',
  'Request a new certificate',
  'Wait for the certificate authority',
  'Verify the certificate',
] as const;

type StepState = 'pending' | 'running' | 'done' | 'failed';

async function runReissue(
  db: Database,
  k8s: K8sClients,
  taskId: string,
  request: ReissueRequest,
): Promise<void> {
  const steps = REISSUE_STEPS.map((name) => ({
    name,
    state: 'pending' as StepState,
    note: undefined as string | undefined,
  }));

  const setStep = async (index: number, state: StepState, note?: string, pct?: number) => {
    steps[index] = { ...steps[index], state, note };
    await tasks.progress(db, taskId, {
      pct: pct ?? Math.round((index / steps.length) * 100),
      text: toSafeText(steps[index].name),
      detailsPatch: { steps },
    });
  };

  const [domain] = await db.select().from(domains).where(eq(domains.id, request.domainId));
  if (!domain) throw new Error('Domain disappeared while the reissue was starting');
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, domain.tenantId));
  const namespace = tenant?.kubernetesNamespace;
  if (!namespace) throw new Error(`Tenant ${domain.tenantId} has no Kubernetes namespace`);

  // 1 — drop the old CR + Secret so cert-manager starts a fresh order
  // rather than sitting on the existing one until its renewal window.
  await setStep(0, 'running');
  await deleteDomainCertificate(db, k8s, request.domainId);
  await setStep(0, 'done');

  // 2 — recreate
  await setStep(1, 'running');
  const ensured = await ensureDomainCertificate(db, k8s, request.domainId);
  if (ensured.skipped) {
    await setStep(1, 'failed', ensured.reason);
    await tasks.finish(db, taskId, {
      status: 'failed',
      error: ensured.reason ?? 'Certificate provisioning was skipped',
    });
    return;
  }
  await setStep(
    1,
    'done',
    `${ensured.issuerName} · ${(ensured.dnsNames ?? []).join(', ')}`,
  );

  // 3 — wait for the CA. Bounded: this task reports back either way.
  await setStep(2, 'running');
  const deadline = Date.now() + ISSUANCE_TIMEOUT_MS;
  let lastMessage: string | undefined;
  let issued = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const health = ensured.certificateName
      ? await readCertificateHealth(k8s, namespace, ensured.certificateName)
      : null;
    if (!health) continue;
    lastMessage = health.message;

    if (health.state === 'issued') {
      issued = true;
      break;
    }
    if (health.state === 'failed') {
      await setStep(2, 'failed', health.message);
      await tasks.finish(db, taskId, {
        status: 'failed',
        error: health.message ?? 'The certificate authority rejected the order',
      });
      return;
    }

    const elapsed = ISSUANCE_TIMEOUT_MS - (deadline - Date.now());
    await tasks.progress(db, taskId, {
      pct: 50 + Math.round((elapsed / ISSUANCE_TIMEOUT_MS) * 40),
      text: toSafeText(health.message ? `Waiting: ${health.message}` : 'Waiting for the certificate authority'),
      detailsPatch: { steps },
    });
  }

  if (!issued) {
    // Not a failure of the request — DNS-01 validation legitimately
    // takes longer than this sometimes. Say exactly that instead of
    // reporting an error the tenant cannot act on.
    await setStep(2, 'failed', lastMessage ?? 'Still pending when the task timed out');
    await tasks.finish(db, taskId, {
      status: 'failed',
      error:
        'The certificate had not been issued after 5 minutes. It may still complete — ' +
        'the certificate status on the domain will update when it does.',
    });
    return;
  }
  await setStep(2, 'done');

  // 4 — verify what we actually got, rather than trusting step 3.
  await setStep(3, 'running');
  const finalHealth = ensured.certificateName
    ? await readCertificateHealth(k8s, namespace, ensured.certificateName)
    : null;
  const sans = finalHealth?.dnsNames ?? ensured.dnsNames ?? [];
  await setStep(3, 'done', sans.join(', '), 100);

  await db
    .update(sslCertificates)
    .set({
      status: 'issued',
      lastIssuedAt: new Date(),
      lastError: null,
      fallbackActive: 0,
      issuerName: ensured.issuerName ?? null,
      isWildcard: ensured.wildcard ? 1 : 0,
    })
    .where(eq(sslCertificates.domainId, request.domainId));

  await notifyTenantCertificateIssued(
    db,
    request.tenantId,
    {
      hostname: domain.domainName,
      expiresAt: finalHealth?.notAfter?.toISOString(),
    },
    `cert-issued:${domain.domainName}:${finalHealth?.notAfter?.toISOString() ?? ''}`,
  );

  await tasks.finish(db, taskId, {
    status: 'succeeded',
    text: toSafeText(sans.join(', ')),
    detailsPatch: {
      steps,
      issuer: ensured.issuerName ?? null,
      dnsNames: sans,
      wildcard: ensured.wildcard === true,
    },
  });
}
