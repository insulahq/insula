/**
 * Post-restore reconcile for a recovered tenant (DR follow-ups).
 *
 * A bundle carries a tenant's DATA + DB rows, but not the live cluster objects
 * those rows imply. After the restore cart completes, this best-effort pass
 * re-establishes the platform-side state so a recovered (or re-created) tenant
 * comes back as close to live as possible in the SAME operator click:
 *
 *   1. Ingress   — rebuild the Traefik IngressRoute/Middleware from the restored
 *                  `ingress_routes` rows (`reconcileIngress`). Purely DB-driven;
 *                  the k8s objects materialise within seconds.
 *   2. Mail      — regenerate DKIM in Stalwart per email domain
 *                  (`normalizeDomainDkim`) so OUTBOUND mail is signed again. The
 *                  mailboxes restore already re-created the domain + mailbox
 *                  principals (delivery + login); this closes SEND-readiness.
 *   3. Workloads — redeploy each restored `deployments` row from its stored spec
 *                  (catalog via `redeployWithCurrentConfig`, custom via
 *                  `redeployCustomDeploymentRow`). The rows survive the bundle;
 *                  the pods do not.
 *
 * EVERY step is best-effort and independently guarded: a failure is counted in
 * the report + surfaced as a `residualGap`, and NEVER throws out of here — the
 * recover must not fail because a follow-up did. The genuinely external step
 * (client DNS re-point on a cross-cluster recover) is always listed as a gap.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { DrRecoverReconcile } from '@insula/api-contracts';
import { tenants, emailDomains, deployments } from '../../db/schema.js';

/** Deployment statuses that were intentionally NOT running pre-loss — leave them down. */
const REDEPLOY_SKIP_STATUSES: ReadonlySet<string> = new Set(['stopped', 'deleting', 'deleted']);

export interface ReconcileResult {
  readonly report: DrRecoverReconcile;
  /** Dynamic residual manual steps derived from what the reconcile could NOT close. */
  readonly residualGaps: readonly string[];
}

/** The irreducible external step — DNS is owned by the client / off-platform. */
const DNS_RESIDUAL_GAP =
  'Cross-cluster DNS: if recovered onto a different cluster or region, re-point client DNS '
  + '(apex A/AAAA, subdomain CNAME) at this cluster’s ingress, and re-publish mail DNS '
  + '(MX/SPF/DKIM/DMARC) for any domains the platform is not authoritative for.';

/**
 * Best-effort reconcile. Resolves the tenant's namespace + cluster clients once,
 * then runs the three steps independently. Returns a structured report + the
 * residual gaps the operator must still close by hand.
 */
export async function reconcileRecoveredTenant(
  app: FastifyInstance,
  tenantId: string,
): Promise<ReconcileResult> {
  const report: DrRecoverReconcile = {
    ingress: 'skipped',
    mail: { domainsTotal: 0, dkimRegenerated: 0, failed: 0 },
    workloads: { total: 0, redeployed: 0, failed: 0 },
  };
  const residualGaps: string[] = [];

  const [tenant] = await app.db
    .select({ namespace: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const namespace = tenant?.namespace ?? null;

  // Cluster clients are shared by the ingress + workload steps. If we can't get
  // them, both steps skip (mail still works — it's JMAP over HTTP, not k8s).
  let k8s: Awaited<ReturnType<typeof import('../k8s-provisioner/k8s-client.js')['createK8sClients']>> | undefined;
  try {
    const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ module: 'dr-reconcile', tenantId, err: errMsg(err) }, 'reconcile: k8s clients unavailable — ingress + workloads skipped');
  }

  await reconcileIngressStep(app, tenantId, namespace, k8s, report, residualGaps);
  await reconcileMailStep(app, tenantId, report, residualGaps);
  await reconcileWorkloadsStep(app, tenantId, k8s, report, residualGaps);

  residualGaps.push(DNS_RESIDUAL_GAP);
  return { report, residualGaps };
}

// ── Step 1: Ingress ─────────────────────────────────────────────────────────

async function reconcileIngressStep(
  app: FastifyInstance,
  tenantId: string,
  namespace: string | null,
  k8s: unknown,
  report: DrRecoverReconcile,
  residualGaps: string[],
): Promise<void> {
  if (!k8s || !namespace) {
    report.ingress = 'skipped';
    return;
  }
  try {
    const { reconcileIngress } = await import('../domains/k8s-ingress.js');
    await reconcileIngress(app.db, k8s as never, tenantId, namespace);
    report.ingress = 'reconciled';
  } catch (err) {
    report.ingress = 'failed';
    app.log.warn({ module: 'dr-reconcile', tenantId, err: errMsg(err) }, 'reconcile: ingress rebuild failed');
    residualGaps.push('Ingress rebuild failed — re-save any domain/route from the admin panel to reconcile the tenant’s IngressRoute.');
  }
}

// ── Step 2: Mail send-readiness (DKIM) ────────────────────────────────────────

async function reconcileMailStep(
  app: FastifyInstance,
  tenantId: string,
  report: DrRecoverReconcile,
  residualGaps: string[],
): Promise<void> {
  let accountId: string | null = null;
  try {
    const { getJmapSession } = await import('../stalwart-jmap/client.js');
    const session = await getJmapSession(process.env.STALWART_MGMT_URL, process.env);
    accountId = session.primaryAccounts['urn:ietf:params:jmap:principals'] ?? null;
  } catch (err) {
    // No mail stack reachable — legitimate skip (nothing to regenerate here).
    app.log.warn({ module: 'dr-reconcile', tenantId, err: errMsg(err) }, 'reconcile: JMAP session unavailable — mail DKIM skipped');
    return;
  }
  if (!accountId) return;

  const domainsRows = await app.db
    .select({
      id: emailDomains.id,
      stalwartDomainId: emailDomains.stalwartDomainId,
      dkimActiveSelector: emailDomains.dkimActiveSelector,
    })
    .from(emailDomains)
    .where(eq(emailDomains.tenantId, tenantId));
  report.mail.domainsTotal = domainsRows.length;
  if (domainsRows.length === 0) return;

  const { normalizeDomainDkim } = await import('../email-dkim/normalize.js');
  for (const d of domainsRows) {
    // The mailboxes restore back-fills stalwartDomainId with THIS cluster's id.
    // If it's still absent (mailboxes not recovered / mail stack down) we can't
    // target a domain principal — count as failed so the gap surfaces.
    if (!d.stalwartDomainId) {
      report.mail.failed += 1;
      continue;
    }
    try {
      const res = await normalizeDomainDkim({
        accountId: accountId as never,
        stalwartDomainId: d.stalwartDomainId,
        baseUrl: process.env.STALWART_MGMT_URL,
        currentDbSelector: d.dkimActiveSelector,
        expectAutoPair: false,
      });
      if (res.activeSelector && res.activeSelector !== d.dkimActiveSelector) {
        await app.db.update(emailDomains)
          .set({ dkimActiveSelector: res.activeSelector })
          .where(eq(emailDomains.id, d.id));
      }
      report.mail.dkimRegenerated += 1;
    } catch (err) {
      report.mail.failed += 1;
      app.log.warn({ module: 'dr-reconcile', tenantId, emailDomainId: d.id, err: errMsg(err) }, 'reconcile: DKIM regenerate failed');
    }
  }
  if (report.mail.failed > 0) {
    residualGaps.push(
      `${report.mail.failed} email domain(s) could not regenerate DKIM — re-enable them from `
      + 'Email → Domains to restore outbound mail signing.',
    );
  }
}

// ── Step 3: Workloads ─────────────────────────────────────────────────────────

async function reconcileWorkloadsStep(
  app: FastifyInstance,
  tenantId: string,
  k8s: unknown,
  report: DrRecoverReconcile,
  residualGaps: string[],
): Promise<void> {
  if (!k8s) return;
  const rows = await app.db.select().from(deployments).where(eq(deployments.tenantId, tenantId));
  const deployable = rows.filter((r) => !REDEPLOY_SKIP_STATUSES.has(r.status));
  report.workloads.total = deployable.length;
  if (deployable.length === 0) return;

  const { redeployWithCurrentConfig } = await import('../deployments/service.js');
  const { redeployCustomDeploymentRow } = await import('../custom-deployments/service.js');
  for (const dep of deployable) {
    try {
      if (dep.source === 'custom') {
        await redeployCustomDeploymentRow(app.db, k8s as never, tenantId, dep);
      } else {
        await redeployWithCurrentConfig(app.db, dep, k8s as never);
      }
      report.workloads.redeployed += 1;
    } catch (err) {
      report.workloads.failed += 1;
      app.log.warn({ module: 'dr-reconcile', tenantId, deploymentId: dep.id, err: errMsg(err) }, 'reconcile: workload redeploy failed');
    }
  }
  if (report.workloads.failed > 0) {
    residualGaps.push(
      `${report.workloads.failed}/${report.workloads.total} workload(s) failed to redeploy `
      + '(image, registry, or pull credential may be unavailable on this cluster) — inspect '
      + 'and redeploy them from the tenant’s Deployments page.',
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
