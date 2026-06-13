/**
 * R16 PR-3 — turnkey platform-apex rename.
 *
 * One super_admin action moves every reconciler-driven platform hostname +
 * its TLS cert to a new apex, WITHOUT touching the tenant CNAME-target
 * (ingress_base_domain). It rewrites the canonical settings the existing
 * reconcilers already watch, then triggers those reconcilers:
 *
 *   platform_domain      := <newApex>                 (the apex itself)
 *   admin_panel_url      := https://admin.<newApex>   -> ingress-reconciler
 *   tenant_panel_url     := https://tenant.<newApex>  -> ingress-reconciler
 *   default_webmail_url  := https://webmail.<newApex>/-> webmail-router
 *   mail_server_hostname := mail.<newApex>            -> stalwart tick
 *
 * Cert issuance is async (cert-manager) and requires DNS for the new hosts
 * to resolve (HTTP-01). DNS is created by the configured DNS provider where
 * one exists; otherwise the caller must ensure the records — the response
 * lists exactly which. The mail host reconciles on the stalwart-domain
 * reconciler's own tick (its TLS path is ACME-via-Traefik, not a panel cert).
 *
 * Out of scope (static ${DOMAIN}, tracked as PR-3b/3d): the stalwart
 * web-admin UI host and the private-worker tunnel anchor.
 */
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import { updateSettings } from '../system-settings/service.js';
import { updateWebmailSettings } from '../webmail-settings/service.js';
import { reconcileIngressHosts } from '../system-settings/ingress-reconciler.js';
import { reconcileWebmailIngress, reconcileStalwartCorsOrigin } from '../webmail-router/reconciler.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { getPlatformApex } from '../system-settings/platform-domain.js';

const APEX_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface RenameLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export interface RenamePlatformDomainResult {
  readonly previousApex: string | null;
  readonly newApex: string;
  readonly hostnames: { admin: string; tenant: string; webmail: string; mail: string };
  readonly reconciled: { panels: string; webmail: string; mail: string };
  readonly dnsRequired: ReadonlyArray<{ host: string; type: 'A/AAAA or CNAME -> ingress'; note: string }>;
  readonly mailNote: string;
}

function resolveTlsSecretName(config: Record<string, unknown>): string {
  const fromEnv = config.PLATFORM_TLS_SECRET_NAME as string | undefined;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv.trim() : 'platform-tls';
}

/** Normalise + validate a candidate apex. Throws ApiError(400) on a bad value. */
export function normalizeApexInput(raw: string): string {
  const apex = (raw ?? '').trim().toLowerCase().replace(/\.+$/, '');
  if (!apex || !APEX_RE.test(apex)) {
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `'${raw}' is not a valid platform domain (apex)`,
      400,
      { field: 'newApex' },
      'Provide a fully-qualified domain like brand.example.com',
    );
  }
  return apex;
}

export async function renamePlatformDomain(
  deps: { db: Database; config: Record<string, unknown>; log: RenameLogger },
  rawNewApex: string,
): Promise<RenamePlatformDomainResult> {
  const { db, config, log } = deps;
  const newApex = normalizeApexInput(rawNewApex);
  const previousApex = await getPlatformApex(db);

  const hostnames = {
    admin: `admin.${newApex}`,
    tenant: `tenant.${newApex}`,
    webmail: `webmail.${newApex}`,
    mail: `mail.${newApex}`,
  };

  // 1. Rewrite the canonical settings. ingress_base_domain is deliberately
  //    NOT touched — tenant CNAME targets must not move.
  const updated = await updateSettings(db, {
    platformDomain: newApex,
    adminPanelUrl: `https://${hostnames.admin}`,
    tenantPanelUrl: `https://${hostnames.tenant}`,
  });
  await updateWebmailSettings(db, {
    defaultWebmailUrl: `https://${hostnames.webmail}/`,
    mailServerHostname: hostnames.mail,
  });

  // 2. Reconcile the reconciler-driven surfaces. Best-effort per surface —
  //    the periodic reconcilers re-converge, and DB is authoritative.
  const kubeconfigPath = config.KUBECONFIG_PATH as string | undefined;
  const clusterIssuerName = config.CLUSTER_ISSUER_NAME as string | undefined;
  const reconciled = { panels: 'pending', webmail: 'pending', mail: 'pending' };

  try {
    const { getGlobalSettings } = await import('../oidc/service.js');
    const oidc = await getGlobalSettings(db);
    const r = await reconcileIngressHosts(
      {
        adminPanelUrl: updated.adminPanelUrl ?? null,
        tenantPanelUrl: updated.tenantPanelUrl ?? null,
        tlsSecretName: resolveTlsSecretName(config),
        protectAdminViaProxy: oidc.protectAdminViaProxy,
        protectTenantViaProxy: oidc.protectTenantViaProxy,
      },
      undefined,
      { kubeconfigPath, clusterIssuerName },
    );
    reconciled.panels = r.changed ? 'reconciled' : 'no-change';
  } catch (err) {
    reconciled.panels = `error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ err }, 'platform-domain rename: panel ingress reconcile failed (non-blocking)');
  }

  let k8s: ReturnType<typeof createK8sClients> | undefined;
  try {
    k8s = createK8sClients(kubeconfigPath);
    await reconcileWebmailIngress(db, k8s.custom, log as never);
    await reconcileStalwartCorsOrigin(db, k8s.custom, log as never);
    reconciled.webmail = 'reconciled';
  } catch (err) {
    reconciled.webmail = `error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ err }, 'platform-domain rename: webmail reconcile failed (non-blocking)');
  }

  // Mail host: the stalwart-domain reconciler reads mail_server_hostname and
  // applies the mail host + its ACME-via-Traefik route. Trigger a tick now so
  // the rename takes effect immediately rather than on the 30-min schedule.
  try {
    if (!k8s) k8s = createK8sClients(kubeconfigPath);
    const { runStalwartDomainReconcilerTick } = await import('../mail-admin/stalwart-domain-reconciler.js');
    await runStalwartDomainReconcilerTick({
      core: k8s.core,
      custom: k8s.custom,
      db,
      logger: {
        warn: (...args: unknown[]) => log.warn({ stalwart: args.join(' ') }),
        info: (...args: unknown[]) => log.info({ stalwart: args.join(' ') }),
      },
    });
    reconciled.mail = 'reconciled';
  } catch (err) {
    reconciled.mail = `error: ${err instanceof Error ? err.message : String(err)}`;
    log.warn({ err }, 'platform-domain rename: mail reconcile failed (non-blocking; 30-min tick retries)');
  }

  log.info({ previousApex, newApex, reconciled }, 'platform-domain renamed');

  return {
    previousApex,
    newApex,
    hostnames,
    reconciled,
    dnsRequired: [
      { host: hostnames.admin, type: 'A/AAAA or CNAME -> ingress', note: 'admin panel — needs DNS + cert (HTTP-01)' },
      { host: hostnames.tenant, type: 'A/AAAA or CNAME -> ingress', note: 'tenant panel — needs DNS + cert (HTTP-01)' },
      { host: hostnames.webmail, type: 'A/AAAA or CNAME -> ingress', note: 'webmail — needs DNS + cert (HTTP-01)' },
      { host: hostnames.mail, type: 'A/AAAA or CNAME -> ingress', note: 'mail host — needs DNS; TLS via Stalwart ACME on the reconciler tick' },
    ],
    mailNote:
      'mail_server_hostname rewritten; the stalwart-domain reconciler applies the mail host + ACME on its next tick.',
  };
}
