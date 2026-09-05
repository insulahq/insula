import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { reconcileIngressHosts, extractHost } from './ingress-reconciler.js';
import {
  probeUrlHealth,
  createDefaultUrlHealthDeps,
  type UrlHealthReport,
} from './url-health.js';
import { z } from 'zod';
import { MIN_TRASH_RETENTION_DAYS, MAX_TRASH_RETENTION_DAYS, updateSystemSettingsSchema} from '@insula/api-contracts';

// 60s health cache: DNS lookups + k8s Certificate reads are both cheap but
// not free, and the UI polls every 30s. Keyed by `${host}::${secretName}`
// so hostname changes invalidate automatically.
interface HealthCacheEntry {
  readonly expiresAt: number;
  readonly report: UrlHealthReport;
}
const HEALTH_CACHE = new Map<string, HealthCacheEntry>();
const HEALTH_CACHE_TTL_MS = 60_000;

/**
 * Resolve the TLS Secret name referenced by Ingress.spec.tls[0].secretName.
 * ConfigMap (prod: bootstrap.sh, dev: platform-config-patch.yaml) is the
 * canonical source. Defaults to `platform-tls` — the prod convention — so
 * a misconfigured deploy fails noisily (no matching Secret) rather than
 * silently binding to a dev-specific name.
 */
function resolveTlsSecretName(config: unknown): string {
  const cfg = config as Record<string, unknown>;
  const fromEnv = cfg.PLATFORM_TLS_SECRET_NAME as string | undefined;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : 'platform-tls';
}

// Schema lives in @insula/api-contracts — single definition for panel + route.

export async function systemSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/system-info — PUBLIC (no auth). Returns the subset of
  // system settings that are safe to expose to unauthenticated visitors:
  // branding (platform name), support links, and the admin/tenant panel
  // URLs used for email templates and cross-panel redirects. Consumed by
  // both frontends on boot (login page, footer) and by the main shell to
  // set document.title.
  app.get('/system-info', {
    schema: {
      tags: ['System Settings'],
      summary: 'Public platform branding + support info (no auth required)',
    },
  }, async () => {
    const settings = await service.getSettings(app.db);
    return success({
      platformName: settings.platformName,
      supportEmail: settings.supportEmail ?? null,
      supportUrl: settings.supportUrl ?? null,
      adminPanelUrl: settings.adminPanelUrl ?? null,
      tenantPanelUrl: settings.tenantPanelUrl ?? null,
      // ISO 4217 currency code — public so the tenant-panel can format
      // plan prices without an authenticated round-trip to /admin/*.
      currency: settings.currency,
    });
  });

  // GET /api/v1/admin/system-settings
  app.get('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Get platform system settings', security: [{ bearerAuth: [] }] },
  }, async () => {
    const settings = await service.getSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/system-settings
  app.patch('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Update platform system settings', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const parsed = updateSystemSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    }

    const updated = await service.updateSettings(app.db, parsed.data);

    // If either panel URL changed, reconcile the Ingress hosts so traffic
    // to the new hostname is actually served. Non-blocking on failure —
    // the DB write is the authoritative change; the reconciler will retry
    // on next startup if this call hits a transient k8s error.
    if (parsed.data.adminPanelUrl !== undefined || parsed.data.tenantPanelUrl !== undefined) {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const tlsSecretName = resolveTlsSecretName(app.config);
      const clusterIssuerName = (app.config as Record<string, unknown>).CLUSTER_ISSUER_NAME as string | undefined;
      try {
        // Read OIDC proxy settings so /oauth2 path rules stay in sync
        // with the current protection state.
        const { getGlobalSettings } = await import('../oidc/service.js');
        const oidc = await getGlobalSettings(app.db);
        const result = await reconcileIngressHosts(
          {
            adminPanelUrl: updated.adminPanelUrl ?? null,
            tenantPanelUrl: updated.tenantPanelUrl ?? null,
            tlsSecretName,
            protectAdminViaProxy: oidc.protectAdminViaProxy,
            protectTenantViaProxy: oidc.protectTenantViaProxy,
          },
          undefined,
          { kubeconfigPath, clusterIssuerName },
        );
        if (result.changed) {
          app.log.info(
            { adminPanelUrl: updated.adminPanelUrl, tenantPanelUrl: updated.tenantPanelUrl },
            'system-settings: ingress hosts reconciled',
          );
        }
      } catch (err) {
        app.log.warn(
          { err, adminPanelUrl: updated.adminPanelUrl, tenantPanelUrl: updated.tenantPanelUrl },
          'system-settings: ingress reconcile failed (non-blocking)',
        );
      }
    }

    // PATCH invalidates the health cache for these hosts so the next UI
    // poll probes fresh values instead of the 60s-old ones.
    if (parsed.data.adminPanelUrl !== undefined || parsed.data.tenantPanelUrl !== undefined) {
      HEALTH_CACHE.clear();
    }

    return success(updated);
  });

  // GET /api/v1/admin/system-settings/url-health
  //
  // Probe DNS resolvability + TLS certificate status for both panel URLs.
  // Cached per host+secret for 60s so the UI can poll (default 30s) cheaply.
  // Never returns 500 for probe failures — status enums convey the failure
  // shape so the badge can render consistently.
  app.get('/admin/system-settings/url-health', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['System Settings'],
      summary: 'DNS + TLS health check for admin/tenant panel URLs',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await service.getSettings(app.db);
    const cfg = app.config as Record<string, unknown>;
    const tlsSecretName = resolveTlsSecretName(app.config);
    const certNamespace = (cfg.PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
    const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;

    const adminHost = extractHost(settings.adminPanelUrl);
    const tenantHost = extractHost(settings.tenantPanelUrl);
    const deps = createDefaultUrlHealthDeps({ kubeconfigPath });

    const probe = async (host: string | null): Promise<UrlHealthReport> => {
      const cacheKey = `${host ?? ''}::${tlsSecretName}`;
      const now = Date.now();
      const cached = HEALTH_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.report;
      const report = await probeUrlHealth(
        { host, certSecretName: tlsSecretName, certNamespace },
        deps,
      );
      HEALTH_CACHE.set(cacheKey, { expiresAt: now + HEALTH_CACHE_TTL_MS, report });
      return report;
    };

    const [admin, tenant] = await Promise.all([probe(adminHost), probe(tenantHost)]);
    return success({ admin, tenant });
  });
}
