/**
 * Stalwart web-admin UI host reconciler (R16 seed-then-disown).
 *
 * The `stalwart-webadmin` IngressRoute + Certificate (mail ns,
 * k8s/base/stalwart-mail/stalwart/ingress-mgmt.yaml) ship as static
 * `${DOMAIN}` manifests carrying `reconcile: disabled`. This reconciler owns
 * their live Host + dnsNames so a platform-apex rename moves the management UI
 * (`stalwart.<apex>`) without a git change — exactly as platform-ingress and
 * platform-webmail-ingress already do for the panels and webmail.
 *
 * Scope: ONLY the web-admin management UI host + its cert-manager cert. This is
 * NOT the mail TLS cert strategy (Stalwart's own ACME via stalwart-mail-acme)
 * nor mail port-exposure (HAProxy DaemonSet) — those are untouched.
 *
 * Host source: `platform_settings.stalwart_admin_url` when the operator pinned
 * one, else the apex-derived default `https://stalwart.<platform_domain>/admin/`
 * (both surfaced by getPlatformUrls). An explicit override therefore wins and
 * does NOT follow a rename — operator intent is authoritative, mirroring
 * longhorn_url / mail_server_hostname.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { getPlatformUrls } from '../platform-urls/service.js';
import {
  isValidPlatformHostname,
  reconcileIngressRouteHost,
  reconcileCertificateDnsName,
  type HostReconcileResult,
} from '../../shared/traefik-host-reconcile.js';

export const STALWART_WEBADMIN_IR_NAME = 'stalwart-webadmin';
export const STALWART_WEBADMIN_CERT_NAME = 'stalwart-webadmin';
export const STALWART_WEBADMIN_NAMESPACE = 'mail';

/**
 * Resolve the bare web-admin host (e.g. `stalwart.example.test`) from the
 * configured stalwart admin URL. Returns null (caller leaves the live value
 * alone) when no apex is configured yet, or the URL/host is invalid — the
 * static `${DOMAIN}` manifest default then stays in force.
 */
export async function resolveStalwartWebadminHost(
  db: Database,
  log: Pick<Logger, 'warn'>,
): Promise<string | null> {
  let raw: string;
  try {
    raw = (await getPlatformUrls(db)).stalwartAdminUrl.value;
  } catch (err) {
    log.warn({ err }, 'stalwart-webadmin: could not read platform URLs — skipping reconcile');
    return null;
  }
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    log.warn({ raw }, 'stalwart-webadmin: stalwart_admin_url is not a valid URL — skipping reconcile');
    return null;
  }
  if (!isValidPlatformHostname(host)) {
    log.warn({ host }, 'stalwart-webadmin: host failed RFC-1123 guard — skipping reconcile');
    return null;
  }
  return host;
}

export interface StalwartWebadminReconcileResult {
  readonly host: string | null;
  readonly ingressRoute: HostReconcileResult | null;
  readonly certificate: HostReconcileResult | null;
}

/**
 * Reconcile the Stalwart web-admin IngressRoute Host + Certificate dnsNames to
 * the configured/derived host. Best-effort + idempotent; never throws fatally.
 */
export async function reconcileStalwartWebadminIngress(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<StalwartWebadminReconcileResult> {
  const host = await resolveStalwartWebadminHost(db, log);
  if (!host) return { host: null, ingressRoute: null, certificate: null };
  const ref = { namespace: STALWART_WEBADMIN_NAMESPACE, name: STALWART_WEBADMIN_IR_NAME };
  const certRef = { namespace: STALWART_WEBADMIN_NAMESPACE, name: STALWART_WEBADMIN_CERT_NAME };
  const ingressRoute = await reconcileIngressRouteHost(custom, ref, host, log);
  const certificate = await reconcileCertificateDnsName(custom, certRef, host, log);
  return { host, ingressRoute, certificate };
}
