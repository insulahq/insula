import { config } from './runtime-config';

/**
 * The redirect URI an external IdP must have registered for a platform OIDC
 * provider, per panel scope.
 *
 * This is not guessable from the admin panel's own origin. The backend builds
 * the callback from the **Host header of the /auth/oidc/authorize request**
 * (`oidc/routes.ts`), and each panel calls the API same-origin — `API_URL` is
 * deliberately left empty in `k8s/base/{admin,tenant}-deployment.yaml`. So a
 * tenant-scoped provider's callback is on the *tenant* host, not the admin one
 * an operator happens to be looking at.
 *
 * Getting this wrong produces `Unregistered redirect_uri` at the IdP and no
 * useful error in the panel. `docs/operations/DEX_OIDC_STAGING.md` had the
 * tenant-panel client pointed at `https://admin.<domain>/…` for exactly this
 * reason — the admin host is the one you see, so it is the one you assume.
 *
 * Resolution order matches useLoginAsTenant: the operator-configured panel URL
 * from System Settings wins (it is what the ingress reconciler points at),
 * then the build-time fallback, then — for the admin scope only — the current
 * origin, which by definition *is* the admin panel.
 */
export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';

export interface PanelUrls {
  readonly adminPanelUrl?: string | null;
  readonly tenantPanelUrl?: string | null;
}

export function resolvePanelOrigin(
  scope: 'admin' | 'tenant',
  urls: PanelUrls | undefined,
  currentOrigin: string = typeof window !== 'undefined' ? window.location.origin : '',
): string {
  const fromSettings = (scope === 'admin' ? urls?.adminPanelUrl : urls?.tenantPanelUrl) ?? '';
  // There is no ADMIN_PANEL_URL in runtime-config — the admin panel knows its
  // own origin. The current origin is therefore a valid fallback ONLY for the
  // admin scope; falling back to it for `tenant` would silently hand the
  // operator the admin URL, the precise mistake this helper exists to prevent.
  const fallback = scope === 'admin' ? currentOrigin : config.TENANT_PANEL_URL;
  return (fromSettings.trim() || fallback || '').replace(/\/+$/, '');
}

/** Full callback URL, or '' when no panel URL is configured for that scope. */
export function oidcCallbackUrl(
  scope: 'admin' | 'tenant',
  urls: PanelUrls | undefined,
  currentOrigin?: string,
): string {
  const origin = resolvePanelOrigin(scope, urls, currentOrigin);
  return origin ? `${origin}${OIDC_CALLBACK_PATH}` : '';
}
