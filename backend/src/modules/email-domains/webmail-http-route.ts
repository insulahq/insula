/**
 * The plain-HTTP side of a tenant's `webmail.<domain>` redirect.
 *
 * ensureWebmailIngress publishes the redirect on the `websecure` entrypoint
 * only, so `http://webmail.<domain>/` matched no router and Traefik answered
 * 404 — on every webmail domain in production. This adds the `web` router: the
 * same redirect Middleware, which already targets the platform webmail's https
 * URL, so a plain-HTTP visitor lands on https in one hop.
 *
 * ACME HTTP-01 challenges for the hostname are excluded from the match. A
 * cert-manager solver's rule is longer and would normally outrank this one,
 * but a redirect that ever won that race would fail the certificate the
 * https side depends on — so the rule does not compete for that path at all.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { domains, emailDomains, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  buildIngressRoute,
  INGRESSROUTE_PLURAL,
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  type IngressRouteBody,
} from '../ingress-routes/traefik-types.js';
import { applyIngressRoute, deleteIngressRoute } from '../ingress-routes/traefik-apply.js';
import { REDIRECT_SINK_PORT, REDIRECT_SINK_SERVICE_NAME } from '../domains/redirect-sink.js';
import { getDefaultWebmailUrl } from '../webmail-settings/service.js';

/** Object names for `webmail.<domain>`, shared with ensure/removeWebmailIngress. */
export function webmailRouteNames(hostname: string): {
  readonly ingressName: string;
  readonly httpIngressName: string;
  readonly middlewareName: string;
} {
  const safeName = hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
  return {
    ingressName: `${safeName}-ingress`,
    httpIngressName: `${safeName}-ingress-http`,
    middlewareName: `${safeName}-redirect`,
  };
}

/** Labels every webmail redirect object carries. */
export function webmailRouteLabels(domainName: string): Record<string, string> {
  return {
    'app.kubernetes.io/component': 'webmail',
    'app.kubernetes.io/managed-by': 'insula',
    'insula.host/webmail-domain': domainName.slice(0, 63),
  };
}

/** Pure: the `web`-entrypoint IngressRoute for one webmail hostname. */
export function buildWebmailHttpRoute(args: {
  readonly namespace: string;
  readonly domainName: string;
}): IngressRouteBody {
  const hostname = `webmail.${args.domainName}`;
  const names = webmailRouteNames(hostname);
  return buildIngressRoute({
    name: names.httpIngressName,
    namespace: args.namespace,
    entryPoints: ['web'],
    routes: [{
      kind: 'Rule',
      match: `Host(\`${hostname}\`) && !PathPrefix(\`/.well-known/acme-challenge/\`)`,
      middlewares: [{ name: names.middlewareName, namespace: args.namespace }],
      // Required by the CRD; the Middleware answers before the sink is reached.
      services: [{ name: REDIRECT_SINK_SERVICE_NAME, port: REDIRECT_SINK_PORT }],
    }],
    // No tls block: this router serves the plaintext entrypoint by design.
    labels: { ...webmailRouteLabels(args.domainName), 'insula.host/entrypoint': 'web' },
  });
}

export async function applyWebmailHttpRoute(
  k8s: K8sClients,
  args: { readonly namespace: string; readonly domainName: string },
): Promise<void> {
  await applyIngressRoute(k8s.custom, buildWebmailHttpRoute(args));
}

export async function deleteWebmailHttpRoute(k8s: K8sClients, namespace: string, domainName: string): Promise<void> {
  await deleteIngressRoute(k8s.custom, namespace, webmailRouteNames(`webmail.${domainName}`).httpIngressName);
}

/**
 * Give every published webmail redirect its plain-HTTP router, where it lacks
 * one. Nothing else re-applies a webmail redirect after it is created, so the
 * domains published before this router existed would keep answering 404 on
 * http:// until someone toggled webmail off and on — and a router whose apply
 * failed (a kube-API blip, two API pods racing to create it) would stay
 * missing. Run every reconciler cycle: one list of the existing routers, an
 * apply only for those missing, so a settled cluster costs one LIST.
 */
export async function reconcileWebmailHttpRoutes(
  db: Database,
  k8s: K8sClients,
): Promise<{ applied: number; failed: number }> {
  let platformHost = '';
  try {
    platformHost = new URL(await getDefaultWebmailUrl(db)).hostname.toLowerCase();
  } catch {
    // An unparseable platform URL means no redirect Middleware was published either.
    return { applied: 0, failed: 0 };
  }
  const rows = await db
    .select({ domainName: domains.domainName, namespace: tenants.kubernetesNamespace, status: emailDomains.webmailStatus })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(tenants, eq(emailDomains.tenantId, tenants.id))
    .where(eq(emailDomains.webmailEnabled, 1));

  const existing = await listWebmailHttpRoutes(k8s);
  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    // Only where the https redirect was published: `failed` / `pending` rows
    // have no Middleware for this router to use.
    if (row.status !== 'ready' && row.status !== 'ready_no_tls') continue;
    if (!row.namespace) continue;
    // The platform's own webmail host is served by the platform route (see
    // ensureWebmailIngress); it has no tenant redirect to extend.
    if (`webmail.${row.domainName}`.toLowerCase() === platformHost) continue;
    const name = webmailRouteNames(`webmail.${row.domainName}`).httpIngressName;
    if (existing.has(`${row.namespace}/${name}`)) continue;
    try {
      await applyWebmailHttpRoute(k8s, { namespace: row.namespace, domainName: row.domainName });
      applied++;
    } catch (err) {
      failed++;
      console.warn(
        `[webmail-reconciler] HTTP redirect route for webmail.${row.domainName} failed (retried next cycle):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { applied, failed };
}

/** `<namespace>/<name>` of every webmail plain-HTTP router in the cluster. */
async function listWebmailHttpRoutes(k8s: K8sClients): Promise<Set<string>> {
  const res = (await k8s.custom.listClusterCustomObject({
    group: TRAEFIK_GROUP,
    version: TRAEFIK_VERSION,
    plural: INGRESSROUTE_PLURAL,
    labelSelector: 'app.kubernetes.io/component=webmail,insula.host/entrypoint=web',
  })) as { items?: Array<{ metadata?: { namespace?: string; name?: string } }> };
  return new Set((res.items ?? []).map((i) => `${i.metadata?.namespace ?? ''}/${i.metadata?.name ?? ''}`));
}
