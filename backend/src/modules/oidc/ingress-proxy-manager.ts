/**
 * OAuth2 Proxy panel gating via Traefik ForwardAuth Middleware.
 *
 * When proxy protection is enabled for a panel (admin/tenant), this
 * module:
 *   1. Creates / updates that panel's ForwardAuth + sign-in Middlewares
 *      (`platform-oauth2-proxy-{auth,signin}-<panel>`) in the `platform`
 *      namespace, pointing at the panel's own oauth2-proxy.
 *   2. Maintains a separate break-glass IngressRoute that exposes a
 *      hidden URL prefix on the admin host, stripping the prefix
 *      before routing to admin-panel WITHOUT the ForwardAuth
 *      Middleware. This is the emergency-only escape hatch the
 *      operator uses if Dex/IdP is unreachable.
 *
 * The platform-ingress IngressRoute itself is owned by
 * system-settings/ingress-reconciler.ts — that reconciler reads the
 * `protectAdminViaProxy` / `protectTenantViaProxy` flags from
 * system_settings and attaches the Middleware reference to the panel
 * routes by name. So we only need to ensure the Middleware EXISTS
 * here; the reconciler owns the spec.routes[].middlewares wiring.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  LEGACY_SHARED_MIDDLEWARES,
  PANEL_PROXY_PORT,
  panelProxyName,
  proxyAuthMiddlewareName,
  proxySigninMiddlewareName,
  type ProxyPanel,
} from './panel-proxy-names.js';
import {
  buildMiddleware,
  buildIngressRoute,
  hostAndPathMatch,
  hostMatch,
  stripPrefixSpec,
  forwardAuthSpec,
  middlewareName,
} from '../ingress-routes/traefik-types.js';
import {
  applyMiddleware,
  deleteMiddleware,
  applyIngressRoute,
  deleteIngressRoute,
} from '../ingress-routes/traefik-apply.js';
import { AGENT_TOKEN_CHECK_PATH, SELF_AUTHENTICATING_PATHS } from '../mcp/paths.js';
import { PANEL_EDGE_GUARDS } from '../system-settings/ingress-reconciler.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';
const BREAK_GLASS_INGRESS_NAME = 'platform-break-glass-ingress';
const ADMIN_PANEL_SERVICE = 'admin-panel';
const ADMIN_PANEL_PORT = 80;

/**
 * Each protected panel gets its own Middleware pair, pointing at that panel's
 * own oauth2-proxy (panel-proxy.ts) — the platform-ingress reconciler
 * references them by the same names (panel-proxy-names.ts).
 *
 * The `errors` Middleware turns the ForwardAuth 401 into the sign-in redirect.
 * oauth2-proxy's `/oauth2/auth` is an auth-CHECK endpoint: it answers 202 or
 * 401 and never redirects, because it is designed for nginx `auth_request`,
 * where `error_page 401 = @oauth2_signin` supplies the hop. Traefik ForwardAuth
 * has no equivalent — it hands the 401 straight to the browser, so an
 * unauthenticated visitor to a protected panel got a bare 401 page and no way
 * to sign in (measured on DEV, both panels, ROADMAP R32). Placed BEFORE the
 * ForwardAuth, the `errors` Middleware catches that 401, fetches
 * `/oauth2/sign_in?rd=<original url>` from oauth2-proxy — which does redirect —
 * and `statusRewrites` turns the 401 into the 302 the browser needs.
 */
async function applyPanelMiddlewares(k8s: K8sClients, panel: ProxyPanel): Promise<void> {
  const service = panelProxyName(panel);
  await applyMiddleware(k8s.custom, buildMiddleware({
    name: proxyAuthMiddlewareName(panel),
    namespace: PLATFORM_NAMESPACE,
    spec: forwardAuthSpec({
      address: `http://${service}.${PLATFORM_NAMESPACE}.svc.cluster.local:${PANEL_PROXY_PORT}/oauth2/auth`,
      // Inherit forwardAuthSpec safe default (false). oauth2-proxy's
      // auth check is cookie-based, doesn't need the tenant IP.
      // Entrypoint trustedIPs=127.0.0.1/32 already strips spoofed XFF.
      // Identity only — the IdP access token is not forwarded to the panel.
      authResponseHeaders: ['X-Auth-Request-User', 'X-Auth-Request-Email'],
    }),
    labels: { 'app.kubernetes.io/component': 'oauth2-proxy-auth' },
  }));
  // `{url}` is Traefik's placeholder for the request the visitor was denied,
  // so oauth2-proxy sends them back to it after the IdP round-trip.
  await applyMiddleware(k8s.custom, buildMiddleware({
    name: proxySigninMiddlewareName(panel),
    namespace: PLATFORM_NAMESPACE,
    spec: {
      errors: {
        status: ['401'],
        service: { name: service, port: PANEL_PROXY_PORT },
        query: '/oauth2/sign_in?rd={url}',
        statusRewrites: { '401': 302 },
      },
    },
    labels: { 'app.kubernetes.io/component': 'oauth2-proxy-auth' },
  }));
}

export async function deletePanelMiddlewares(k8s: K8sClients, panel: ProxyPanel): Promise<void> {
  await deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, proxyAuthMiddlewareName(panel));
  await deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, proxySigninMiddlewareName(panel));
}

/**
 * Remove the single shared Middleware pair from before proxies were per-panel.
 * Call only after the platform-ingress routes stop referencing it.
 */
export async function deleteLegacySharedMiddlewares(k8s: K8sClients): Promise<void> {
  for (const name of LEGACY_SHARED_MIDDLEWARES) {
    await deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, name);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ProxySettings {
  readonly protectAdminViaProxy: boolean;
  readonly protectTenantViaProxy: boolean;
  readonly breakGlassPath: string | null;
  readonly adminHost?: string | null;
}

/**
 * Reconcile the per-panel OAuth2 Proxy Middlewares + break-glass IngressRoute.
 *
 * - A protected panel gets its ForwardAuth + sign-in Middlewares; an
 *   unprotected one has them deleted. The platform-ingress reconciler
 *   attaches them to the panel routes by name.
 * - Break-glass: when `protectAdminViaProxy` AND `breakGlassPath` set,
 *   create a high-priority IngressRoute that strips the secret prefix
 *   and forwards to admin-panel without the auth Middleware. Otherwise
 *   delete the IngressRoute + its companion stripPrefix Middleware.
 */
export async function syncProxyIngressAnnotations(
  k8s: K8sClients,
  settings: ProxySettings,
  opts: { readonly deleteUnprotected?: boolean } = {},
): Promise<void> {
  const protectedPanels: Record<ProxyPanel, boolean> = {
    admin: settings.protectAdminViaProxy,
    tenant: settings.protectTenantViaProxy,
  };
  for (const panel of ['admin', 'tenant'] as const) {
    if (protectedPanels[panel]) await applyPanelMiddlewares(k8s, panel);
    // A caller that is about to rewrite the routes passes false and deletes
    // these itself AFTERWARDS — a route referencing a deleted Middleware is
    // dropped by Traefik just like one referencing a missing Service.
    else if (opts.deleteUnprotected !== false) await deletePanelMiddlewares(k8s, panel);
  }

  await syncBreakGlassIngressRoute(k8s, settings);
  await syncAgentEndpointsIngressRoute(k8s, settings);
}

// ─── Agent / API-token bypass ──────────────────────────────────────────────

export const AGENT_ENDPOINTS_INGRESS_NAME = 'platform-agent-endpoints';
export const AGENT_TOKEN_AUTH_MIDDLEWARE = 'platform-agent-token-auth';
const PLATFORM_API_SERVICE = process.env.PLATFORM_API_SERVICE ?? 'platform-api';
const PLATFORM_API_PORT = 3000;

/**
 * Endpoints that authenticate themselves and must stay reachable while the
 * admin panel sits behind OAuth2 Proxy: the MCP endpoint (bearer token or a
 * 401 that starts an MCP client's sign-in), the OAuth server and its discovery
 * documents — each by its exact path (see SELF_AUTHENTICATING_PATHS). The
 * consent API stays behind the proxy: the person approving signs in through it.
 */
export function agentEndpointsMatch(adminHost: string): string {
  const paths = SELF_AUTHENTICATING_PATHS.map((p) => `Path(\`${p}\`)`).join(' || ');
  return `${hostMatch(adminHost)} && (${paths})`;
}

/**
 * API requests carrying a personal access token — scripts, which cannot do
 * the proxy's browser sign-in. Matching the header's SHAPE only routes the
 * request; the ForwardAuth middleware on this route asks platform-api whether
 * the token is live, so a made-up header gets a 401 at the edge and never the
 * backend behind the proxy.
 */
export function patApiMatch(adminHost: string): string {
  return `${hostMatch(adminHost)} && PathPrefix(\`/api/v1/\`) && HeaderRegexp(\`Authorization\`, \`^Bearer insula_pat_\`)`;
}

/** The ForwardAuth middleware + the two-route IngressRoute for an admin host. */
export function buildAgentEndpointsResources(adminHost: string) {
  const labels = { 'app.kubernetes.io/component': 'agent-endpoints' };
  const panel = [{ name: ADMIN_PANEL_SERVICE, port: ADMIN_PANEL_PORT }];
  const middleware = buildMiddleware({
    name: AGENT_TOKEN_AUTH_MIDDLEWARE,
    namespace: PLATFORM_NAMESPACE,
    spec: forwardAuthSpec({
      address: `http://${PLATFORM_API_SERVICE}.${PLATFORM_NAMESPACE}.svc.cluster.local:${PLATFORM_API_PORT}${AGENT_TOKEN_CHECK_PATH}`,
      authRequestHeaders: ['Authorization'],
    }),
    labels,
  });
  const ingressRoute = buildIngressRoute({
    name: AGENT_ENDPOINTS_INGRESS_NAME,
    namespace: PLATFORM_NAMESPACE,
    routes: [
      // Above the proxied panel route on the same host, like break-glass —
      // with the panel route's own CrowdSec + WAF, around ForwardAuth where
      // the panel route has the proxy.
      {
        match: agentEndpointsMatch(adminHost),
        kind: 'Rule',
        priority: 100,
        middlewares: [...PANEL_EDGE_GUARDS.before, ...PANEL_EDGE_GUARDS.after],
        services: panel,
      },
      {
        match: patApiMatch(adminHost),
        kind: 'Rule',
        priority: 99,
        middlewares: [
          ...PANEL_EDGE_GUARDS.before,
          { name: AGENT_TOKEN_AUTH_MIDDLEWARE, namespace: PLATFORM_NAMESPACE },
          ...PANEL_EDGE_GUARDS.after,
        ],
        services: panel,
      },
    ],
    labels,
  });
  return { middleware, ingressRoute };
}

async function syncAgentEndpointsIngressRoute(k8s: K8sClients, settings: ProxySettings): Promise<void> {
  if (!settings.protectAdminViaProxy || !settings.adminHost) {
    await deleteIngressRoute(k8s.custom, PLATFORM_NAMESPACE, AGENT_ENDPOINTS_INGRESS_NAME);
    await deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, AGENT_TOKEN_AUTH_MIDDLEWARE);
    return;
  }
  const { middleware, ingressRoute } = buildAgentEndpointsResources(settings.adminHost);
  // The middleware first: a route naming a missing middleware is a Traefik 404.
  await applyMiddleware(k8s.custom, middleware);
  await applyIngressRoute(k8s.custom, ingressRoute);
}

// ─── Break-Glass IngressRoute ───────────────────────────────────────────────

async function syncBreakGlassIngressRoute(
  k8s: K8sClients,
  settings: ProxySettings,
): Promise<void> {
  const shouldExist =
    settings.protectAdminViaProxy &&
    !!settings.breakGlassPath &&
    !!settings.adminHost;

  const stripPrefixName = middlewareName(BREAK_GLASS_INGRESS_NAME, 'strip');

  if (!shouldExist) {
    await Promise.all([
      deleteIngressRoute(k8s.custom, PLATFORM_NAMESPACE, BREAK_GLASS_INGRESS_NAME),
      deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, stripPrefixName),
    ]);
    return;
  }

  const breakGlassPath = settings.breakGlassPath!;
  const adminHost = settings.adminHost!;

  // Path-stripping Middleware: requests to /<breakGlassPath>/<rest> get
  // rewritten to /<rest> before hitting admin-panel. This matches the
  // nginx rewrite-target shape (/(?<rest>.*) → /$rest) but expressed
  // declaratively via stripPrefix.
  const stripMiddleware = buildMiddleware({
    name: stripPrefixName,
    namespace: PLATFORM_NAMESPACE,
    spec: stripPrefixSpec([`/${breakGlassPath}`]),
    labels: {
      'app.kubernetes.io/component': 'break-glass',
    },
  });
  await applyMiddleware(k8s.custom, stripMiddleware);

  // Higher-priority IngressRoute for the admin host break-glass path.
  // Priority must exceed any catch-all route on the same host (the
  // platform-ingress panel route uses default priority, which is the
  // match-rule length — our match is longer due to PathPrefix, so we
  // win naturally; the explicit priority=100 documents the intent).
  const ingressRoute = buildIngressRoute({
    name: BREAK_GLASS_INGRESS_NAME,
    namespace: PLATFORM_NAMESPACE,
    routes: [
      {
        match: hostAndPathMatch(adminHost, `/${breakGlassPath}`),
        kind: 'Rule',
        priority: 100,
        middlewares: [{ name: stripPrefixName, namespace: PLATFORM_NAMESPACE }],
        services: [{ name: ADMIN_PANEL_SERVICE, port: ADMIN_PANEL_PORT }],
      },
    ],
    labels: {
      'app.kubernetes.io/component': 'break-glass',
    },
  });
  await applyIngressRoute(k8s.custom, ingressRoute);
}
