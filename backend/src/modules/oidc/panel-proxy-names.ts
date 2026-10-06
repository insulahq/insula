/**
 * Names shared by the per-panel oauth2-proxy (panel-proxy.ts), its Traefik
 * Middlewares (ingress-proxy-manager.ts) and the platform-ingress reconciler
 * (system-settings/ingress-reconciler.ts). Kept dependency-free so the
 * reconciler can import them without pulling in the OIDC module.
 */
export type ProxyPanel = 'admin' | 'tenant';

export const PANEL_PROXY_PORT = 4180;

/** Secret, Deployment and Service of a panel's oauth2-proxy. */
export function panelProxyName(panel: ProxyPanel): string {
  return `oauth2-proxy-${panel}`;
}

/** ForwardAuth Middleware that asks the panel's proxy whether the visitor is signed in. */
export function proxyAuthMiddlewareName(panel: ProxyPanel): string {
  return `platform-oauth2-proxy-auth-${panel}`;
}

/** `errors` Middleware that turns that ForwardAuth 401 into the sign-in redirect. */
export function proxySigninMiddlewareName(panel: ProxyPanel): string {
  return `platform-oauth2-proxy-signin-${panel}`;
}

/**
 * The single shared pair every protected panel referenced before proxies became
 * per-panel. Deleted once the routes no longer reference them.
 */
export const LEGACY_SHARED_MIDDLEWARES = ['platform-oauth2-proxy-auth', 'platform-oauth2-proxy-signin'] as const;
