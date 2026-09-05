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
/**
 * WAF middlewares the anchor catch-all must carry, in order, ahead of its own
 * rate-limit. Mirrors `platform-ingress`.
 *
 * ONLY the anchor. Per-worker tunnels live on `<slug>.tunnels.<apex>` — a
 * different host, its own IngressRoute — and carry frps WebSocket streams that
 * must never be body-inspected. The anchor is the priority-1 catch-all serving
 * the suspended page to unrouted requests, so it sees no tunnel traffic and
 * the WAF cannot regress the feature.
 */
export const ANCHOR_WAF_MIDDLEWARES: ReadonlyArray<{ name: string; namespace: string }> = [
  { name: 'crowdsec', namespace: 'traefik' },
  { name: 'waf-body-limit', namespace: 'traefik' },
  { name: 'modsecurity-crs', namespace: 'traefik' },
];

interface AnchorMiddlewareRef { name?: string; namespace?: string }
interface AnchorRoute { middlewares?: AnchorMiddlewareRef[] }
interface AnchorIngressRoute { spec?: { routes?: AnchorRoute[] } }

/** True when every WAF middleware is already present on the route. */
function hasAllWafMiddlewares(route: AnchorRoute): boolean {
  const have = new Set((route.middlewares ?? []).map((m) => `${m.namespace ?? ''}/${m.name ?? ''}`));
  return ANCHOR_WAF_MIDDLEWARES.every((m) => have.has(`${m.namespace}/${m.name}`));
}

/**
 * Converge the anchor's middleware chain so existing clusters gain the WAF.
 *
 * The anchor IngressRoute carries `kustomize.toolkit.fluxcd.io/reconcile:
 * disabled` (R16 seed-then-disown), so Flux seeds it once and never updates it
 * again — editing the base manifest reaches FRESH INSTALLS ONLY. Every already
 * -running cluster therefore needs this convergence, which runs on the same
 * boot hook as the host reconcile.
 *
 * Idempotent and additive: existing middlewares are preserved and the WAF ones
 * are prepended, so the rate-limit and compress still apply.
 */
export async function reconcileTunnelAnchorMiddlewares(
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<{ patched: boolean }> {
  let current: AnchorIngressRoute;
  try {
    current = (await custom.getNamespacedCustomObject({
      group: 'traefik.io',
      version: 'v1alpha1',
      namespace: TUNNEL_ANCHOR_NAMESPACE,
      plural: 'ingressroutes',
      name: TUNNEL_ANCHOR_IR_NAME,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as AnchorIngressRoute;
  } catch (err) {
    log.warn({ err }, 'tunnel-anchor: IngressRoute not found — skipping WAF middleware reconcile');
    return { patched: false };
  }

  const routes = current.spec?.routes ?? [];
  if (routes.length === 0 || routes.every(hasAllWafMiddlewares)) return { patched: false };

  // MERGE_PATCH replaces the whole routes array, so rebuild every route in
  // full and only prepend the missing middlewares.
  const newRoutes = routes.map((r) => {
    const existing = r.middlewares ?? [];
    const have = new Set(existing.map((m) => `${m.namespace ?? ''}/${m.name ?? ''}`));
    const missing = ANCHOR_WAF_MIDDLEWARES.filter((m) => !have.has(`${m.namespace}/${m.name}`));
    return { ...r, middlewares: [...missing, ...existing] };
  });

  await custom.patchNamespacedCustomObject({
    group: 'traefik.io',
    version: 'v1alpha1',
    namespace: TUNNEL_ANCHOR_NAMESPACE,
    plural: 'ingressroutes',
    name: TUNNEL_ANCHOR_IR_NAME,
    body: { spec: { routes: newRoutes } },
  } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0]);
  log.info({ middlewares: ANCHOR_WAF_MIDDLEWARES.map((m) => m.name) },
    'tunnel-anchor: WAF middlewares converged onto the catch-all route');
  return { patched: true };
}

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
