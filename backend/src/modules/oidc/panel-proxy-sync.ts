/**
 * One place that brings the panels' OAuth2 Proxy protection in line with the
 * saved settings, in the only safe order:
 *
 *   1. each protected panel's oauth2-proxy (Secret, Deployment, Service);
 *   2. optionally WAIT until it is Ready — it has then passed OIDC discovery;
 *   3. its Traefik Middlewares and the break-glass route;
 *   4. the platform-ingress routes that reference them;
 *   5. last, the Middlewares and proxies of unprotected panels and the
 *      pre-per-panel shared Middlewares, which nothing references any more.
 *
 * Routes never point at a proxy or Middleware that does not exist — in either
 * direction: enabling creates before referencing, disabling unreferences
 * before deleting. The old code did it the other
 * way round — and against a proxy production never deployed — which is how
 * enabling protection took a whole panel host down.
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { getGlobalSettings, getDecryptedCookieSecret, loadPanelProxyProvider, type ProxyPanel } from './service.js';
import { applyPanelProxy, removePanelProxy, waitPanelProxyReady } from './panel-proxy.js';
import { syncProxyIngressAnnotations, deleteLegacySharedMiddlewares, deletePanelMiddlewares } from './ingress-proxy-manager.js';

const PANELS: readonly ProxyPanel[] = ['admin', 'tenant'];

export interface PanelProxySyncConfig {
  readonly encryptionKey: string;
  readonly kubeconfigPath?: string;
  readonly tlsSecretName: string;
  readonly clusterIssuerName?: string;
  /** Overrides the oauth2-proxy image (air-gapped mirrors). */
  readonly image?: string;
}

export interface PanelProxySyncOptions {
  /** Block until every protected panel's proxy is Ready (enable/change paths). */
  readonly waitReady: boolean;
  readonly k8s?: K8sClients;
  readonly timeoutMs?: number;
}

/** Resolve the sync config from the app config the way every caller would. */
export function panelProxySyncConfig(config: Record<string, unknown>): PanelProxySyncConfig {
  const key = (config.PLATFORM_ENCRYPTION_KEY as string | undefined) ?? process.env.PLATFORM_ENCRYPTION_KEY;
  const encryptionKey = key && key.length >= 32
    ? key
    : (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? '0'.repeat(64) : '');
  if (!encryptionKey) throw new Error('PLATFORM_ENCRYPTION_KEY is required (panel proxy sync)');
  return {
    encryptionKey,
    kubeconfigPath: config.KUBECONFIG_PATH as string | undefined,
    tlsSecretName: (config.PLATFORM_TLS_SECRET_NAME as string | undefined)?.trim() || 'platform-tls',
    clusterIssuerName: config.CLUSTER_ISSUER_NAME as string | undefined,
    image: (config.OAUTH2_PROXY_IMAGE as string | undefined) ?? process.env.OAUTH2_PROXY_IMAGE,
  };
}

function misconfigured(panel: ProxyPanel, what: string): ApiError {
  return new ApiError('OAUTH2_PROXY_MISCONFIGURED',
    `The ${panel} panel's OAuth2 Proxy cannot be configured: ${what}`, 409);
}

export async function syncPanelProxies(
  db: Database,
  cfg: PanelProxySyncConfig,
  opts: PanelProxySyncOptions,
): Promise<void> {
  const k8s = opts.k8s ?? createK8sClients(cfg.kubeconfigPath);
  const { getSettings } = await import('../system-settings/service.js');
  const { reconcileIngressHosts, extractHost } = await import('../system-settings/ingress-reconciler.js');

  const settings = await getGlobalSettings(db);
  const sys = await getSettings(db);
  const urls: Record<ProxyPanel, string | null> = {
    admin: sys.adminPanelUrl ?? null,
    tenant: sys.tenantPanelUrl ?? null,
  };
  const wanted: Record<ProxyPanel, boolean> = {
    admin: settings.protectAdminViaProxy,
    tenant: settings.protectTenantViaProxy,
  };
  const providerIds: Record<ProxyPanel, string | null> = {
    admin: settings.proxyAdminProviderId,
    tenant: settings.proxyTenantProviderId,
  };

  // 1. Proxies for the protected panels.
  const protectedPanels = PANELS.filter((p) => wanted[p]);
  if (protectedPanels.length > 0) {
    const cookieSecret = await getDecryptedCookieSecret(db, cfg.encryptionKey);
    for (const panel of protectedPanels) {
      const host = extractHost(urls[panel]);
      if (!host) throw misconfigured(panel, 'the panel has no public URL');
      if (!cookieSecret) throw misconfigured(panel, 'no cookie secret has been generated');
      const provider = await loadPanelProxyProvider(db, providerIds[panel], cfg.encryptionKey);
      if (!provider) throw misconfigured(panel, 'its OIDC provider is missing or disabled');
      await applyPanelProxy(k8s, { panel, host, provider, cookieSecret, image: cfg.image });
    }
    // 2. Nothing below may reference a proxy that is not serving yet.
    if (opts.waitReady) {
      for (const panel of protectedPanels) {
        await waitPanelProxyReady(k8s, panel, { timeoutMs: opts.timeoutMs });
      }
    }
  }

  // 3. Middlewares of protected panels + break-glass. Unprotected panels'
  // Middlewares are still referenced by the live routes until step 4.
  await syncProxyIngressAnnotations(k8s, {
    protectAdminViaProxy: wanted.admin,
    protectTenantViaProxy: wanted.tenant,
    breakGlassPath: settings.breakGlassPath,
    adminHost: extractHost(urls.admin),
  }, { deleteUnprotected: false });

  // 4. Routes.
  await reconcileIngressHosts(
    {
      adminPanelUrl: urls.admin,
      tenantPanelUrl: urls.tenant,
      tlsSecretName: cfg.tlsSecretName,
      protectAdminViaProxy: wanted.admin,
      protectTenantViaProxy: wanted.tenant,
    },
    undefined,
    { kubeconfigPath: cfg.kubeconfigPath, clusterIssuerName: cfg.clusterIssuerName },
  );

  // 5. What nothing references any more.
  for (const panel of PANELS.filter((p) => !wanted[p])) {
    await deletePanelMiddlewares(k8s, panel);
    await removePanelProxy(k8s, panel);
  }
  await deleteLegacySharedMiddlewares(k8s);
}
