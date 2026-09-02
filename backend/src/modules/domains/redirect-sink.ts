/**
 * Redirect-sink Service — the backend a redirect-only ingress route points at.
 *
 * A route may carry a `redirect_url` without targeting a deployment or a
 * private worker: "this hostname exists only to send visitors somewhere else".
 * Traefik's IngressRoute CRD still requires at least one `services[]` entry,
 * even though the redirect Middleware answers with a 301 long before the
 * backend would be consulted.
 *
 * We cannot point such a route at a Service in `platform` / `platform-system`
 * directly: `buildIngressRoute` deliberately refuses cross-namespace
 * `services[].namespace` refs, because a tenant route pointing into a platform
 * namespace would lift the isolation boundary. The sanctioned escape hatch —
 * named in that guard's own error message — is an ExternalName Service in the
 * tenant's OWN namespace, which Traefik accepts because it is installed with
 * `providers.kubernetesCRD.allowExternalNameServices=true` (bootstrap.sh).
 *
 * ExternalName is a DNS alias, so this costs no pod and nothing against the
 * tenant's ResourceQuota.
 *
 * It points at the platform's shared error-page backend rather than the
 * suspended-account page: the sink is only ever reached if the redirect
 * Middleware is missing, and in that case a generic error is honest where
 * "this account is suspended" would be a lie. Both the Middleware and this
 * route's admission are driven by the same `redirectUrl` column, so they
 * cannot disagree in practice.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const REDIRECT_SINK_SERVICE_NAME = 'redirect-sink';
export const REDIRECT_SINK_PORT = 80;

/** Platform-shared error-page backend — see k8s/base/tenant-errors/. */
const REDIRECT_SINK_EXTERNAL_NAME = 'tenant-errors.platform-system.svc.cluster.local';

export function buildRedirectSinkService(namespace: string) {
  return {
    metadata: {
      name: REDIRECT_SINK_SERVICE_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'redirect-sink',
        'app.kubernetes.io/managed-by': 'insula',
      },
    },
    spec: {
      type: 'ExternalName',
      externalName: REDIRECT_SINK_EXTERNAL_NAME,
      ports: [{ port: REDIRECT_SINK_PORT, targetPort: REDIRECT_SINK_PORT, protocol: 'TCP', name: 'http' }],
    },
  };
}

/**
 * Idempotently ensure the redirect sink exists in `namespace`.
 *
 * Best-effort by design: a redirect-only route is worthless without its
 * IngressRoute, but the rest of the tenant's routes must still reconcile if
 * this one Service cannot be created. Callers log and continue.
 */
export async function ensureRedirectSinkService(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  const body = buildRedirectSinkService(namespace);
  try {
    await k8s.core.createNamespacedService({ namespace, body } as never);
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    // 409 = already there. Replace so an externalName changed by a previous
    // release (or by hand) converges instead of silently pointing elsewhere.
    if (statusCode !== 409) throw err;
    await k8s.core.replaceNamespacedService({
      name: REDIRECT_SINK_SERVICE_NAME,
      namespace,
      body,
    } as never);
  }
}
