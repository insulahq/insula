/**
 * Private-worker tunnel ANCHOR host reconciler (R16 seed-then-disown).
 *
 * The `tunnel-anchor` IngressRoute + `tunnels-platform-domain` Certificate
 * (platform-system ns, k8s/base/private-worker-tunnel/) ship as static
 * `${DOMAIN}` manifests carrying `reconcile: disabled`. This reconciler owns
 * their live Host + dnsNames so a platform-apex rename moves the tunnel anchor
 * (`tunnels.<apex>`) without a git change.
 *
 * SCOPE — anchor only. This reconciles the catch-all anchor IngressRoute + its
 * cert. It deliberately does NOT re-home LIVE per-worker subdomains
 * (`<slug>.tunnels.<apex>`): those are derived from the env
 * `PLATFORM_BASE_DOMAIN` / `TUNNEL_BASE_URL` (private-workers/service.ts), each
 * carries its own per-FQDN cert, and each agent's dial-in serverUrl is baked at
 * provisioning time. Moving live workers means re-issuing every per-FQDN cert
 * AND forcing every agent to reconnect on a new URL — a disruptive, separate
 * follow-up. New workers continue to use the env apex until that lands; on a
 * fresh install env == platform_domain, so the anchor following a rename is a
 * strict improvement (and the only tunnel surface E2E-provable without live
 * workers).
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { getPlatformApex } from '../system-settings/platform-domain.js';
import {
  isValidPlatformHostname,
  reconcileIngressRouteHost,
  reconcileCertificateDnsName,
  type HostReconcileResult,
} from '../../shared/traefik-host-reconcile.js';

export const TUNNEL_ANCHOR_IR_NAME = 'tunnel-anchor';
export const TUNNEL_ANCHOR_CERT_NAME = 'tunnels-platform-domain';
export const TUNNEL_ANCHOR_NAMESPACE = 'platform-system';

/**
 * Resolve the tunnel anchor host (`tunnels.<apex>`) from the platform apex
 * (platform_domain → ingress_base_domain fallback). Returns null when no apex
 * is configured yet — the static `${DOMAIN}` manifest default then stays.
 */
export async function resolveTunnelAnchorHost(db: Database): Promise<string | null> {
  const apex = (await getPlatformApex(db))?.toLowerCase().replace(/\.+$/, '');
  if (!apex) return null;
  const host = `tunnels.${apex}`;
  return isValidPlatformHostname(host) ? host : null;
}

export interface TunnelAnchorReconcileResult {
  readonly host: string | null;
  readonly ingressRoute: HostReconcileResult | null;
  readonly certificate: HostReconcileResult | null;
}

/**
 * Reconcile the tunnel anchor IngressRoute Host + Certificate dnsNames to
 * `tunnels.<apex>`. Best-effort + idempotent; never throws fatally.
 */
export async function reconcileTunnelAnchorIngress(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<TunnelAnchorReconcileResult> {
  const host = await resolveTunnelAnchorHost(db);
  if (!host) return { host: null, ingressRoute: null, certificate: null };
  const ref = { namespace: TUNNEL_ANCHOR_NAMESPACE, name: TUNNEL_ANCHOR_IR_NAME };
  const certRef = { namespace: TUNNEL_ANCHOR_NAMESPACE, name: TUNNEL_ANCHOR_CERT_NAME };
  const ingressRoute = await reconcileIngressRouteHost(custom, ref, host, log);
  const certificate = await reconcileCertificateDnsName(custom, certRef, host, log);
  return { host, ingressRoute, certificate };
}
