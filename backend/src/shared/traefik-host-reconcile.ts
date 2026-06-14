/**
 * Shared "seed-then-disown" helpers for platform-owned Traefik hostnames.
 *
 * Some platform-infrastructure surfaces (the Stalwart web-admin UI, the
 * private-worker tunnel anchor) ship as static `${DOMAIN}` manifests so a
 * fresh install comes up with sensible defaults and ZERO dependency on the
 * platform-api reconciler. Once created, those manifests carry the Flux
 * annotation `kustomize.toolkit.fluxcd.io/reconcile: disabled`, handing
 * ownership of the live Host + TLS dnsNames to platform-api. This module is
 * the platform-api side of that contract: it rewrites the live IngressRoute
 * Host(...) match + cert-manager Certificate dnsNames to follow the platform
 * apex, and re-stamps the disable-annotation so a future git sync can't quietly
 * hand ownership back to Flux (which would revert the rename).
 *
 * There is no SSA "battle" with Flux: Flux creates the object, then steps back.
 * Mirrors the established pattern in webmail-router/reconciler.ts
 * (platform-webmail-ingress + the stalwart-jmap-cors Middleware).
 */
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { MERGE_PATCH } from './k8s-patch.js';

const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const TRAEFIK_IR_PLURAL = 'ingressroutes';
const CERT_GROUP = 'cert-manager.io';
const CERT_VERSION = 'v1';
const CERT_PLURAL = 'certificates';
const FLUX_RECONCILE_KEY = 'kustomize.toolkit.fluxcd.io/reconcile';

/** Flux annotation that tells the kustomize-controller to skip this resource. */
export const FLUX_RECONCILE_DISABLED = { [FLUX_RECONCILE_KEY]: 'disabled' } as const;

// RFC-1123 DNS hostname guard. The resolved host is interpolated into a Traefik
// `Host(`<host>`)` rule and a cert dnsName, so a crafted value with
// backticks/parentheses could otherwise inject/widen the route. Defence in
// depth — the write-boundary Zod schemas enforce the same shape. Mirrors
// webmail-router/reconciler.ts:WEBMAIL_HOSTNAME_RE.
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidPlatformHostname(host: string): boolean {
  return HOSTNAME_RE.test(host);
}

const HOST_TOKEN_RE = /Host\(`[^`]*`\)/g;

/**
 * Replace the host inside EVERY `Host(`...`)` token of a Traefik match rule,
 * leaving every other matcher (PathPrefix, Path, `&&`, `||`) intact. Returns
 * the match unchanged when no `Host(...)` token is present.
 */
export function rewriteHostInMatch(match: string, newHost: string): string {
  return match.replace(HOST_TOKEN_RE, `Host(\`${newHost}\`)`);
}

/** Extract the host from the first `Host(`...`)` token, or null. */
export function extractHostFromMatch(match: string): string | null {
  const m = /Host\(`([^`]*)`\)/.exec(match);
  return m ? m[1] : null;
}

export interface HostReconcileResult {
  readonly expectedHost: string;
  readonly previousHost: string | null;
  readonly patched: boolean;
}

interface IngressRouteLike {
  readonly metadata?: { readonly annotations?: Record<string, string> };
  readonly spec?: { readonly routes?: Array<Record<string, unknown> & { match?: string }> };
}

/**
 * Reconcile a Traefik IngressRoute so every route's `Host(...)` matches
 * `expectedHost`, re-stamping `reconcile: disabled`. Idempotent; returns null
 * (left untouched) when the IngressRoute is absent (fresh cluster / no Traefik
 * in CI). Rewrites ALL routes — handles multi-route IngressRoutes like the
 * Stalwart web-admin (JMAP route + WebAdmin catch-all).
 */
export async function reconcileIngressRouteHost(
  custom: k8s.CustomObjectsApi,
  ref: { readonly namespace: string; readonly name: string },
  expectedHost: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<HostReconcileResult | null> {
  let current: IngressRouteLike;
  try {
    current = (await custom.getNamespacedCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: ref.namespace,
      plural: TRAEFIK_IR_PLURAL,
      name: ref.name,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as IngressRouteLike;
  } catch (err) {
    log.warn({ err, ...ref }, 'traefik-host-reconcile: IngressRoute not found — skipping');
    return null;
  }

  const routes = current.spec?.routes ?? [];
  const previousHost =
    routes.map((r) => (r.match ? extractHostFromMatch(r.match) : null)).find((h) => h) ?? null;
  const annotationMissing =
    (current.metadata?.annotations ?? {})[FLUX_RECONCILE_KEY] !== 'disabled';

  if (previousHost === expectedHost && !annotationMissing) {
    return { expectedHost, previousHost, patched: false };
  }

  // MERGE_PATCH (RFC 7386) replaces the whole routes array, so we send every
  // route reconstructed in full (spread) with only its Host rewritten — every
  // other field (middlewares, services, priority, kind) is preserved.
  const newRoutes = routes.map((r) => ({
    ...r,
    ...(r.match ? { match: rewriteHostInMatch(r.match, expectedHost) } : {}),
  }));

  await custom.patchNamespacedCustomObject(
    {
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      namespace: ref.namespace,
      plural: TRAEFIK_IR_PLURAL,
      name: ref.name,
      body: { metadata: { annotations: { ...FLUX_RECONCILE_DISABLED } }, spec: { routes: newRoutes } },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );

  log.info({ ...ref, previousHost, expectedHost }, 'traefik-host-reconcile: IngressRoute host reconciled');
  return { expectedHost, previousHost, patched: true };
}

interface CertificateLike {
  readonly metadata?: { readonly annotations?: Record<string, string> };
  readonly spec?: { readonly dnsNames?: string[] };
}

/**
 * Reconcile a cert-manager Certificate so its dnsNames are exactly
 * `[expectedHost]`, re-stamping `reconcile: disabled`. cert-manager re-issues
 * the TLS Secret when the SANs change (HTTP-01 needs DNS for the new host).
 * Idempotent; returns null when the Certificate is absent.
 */
export async function reconcileCertificateDnsName(
  custom: k8s.CustomObjectsApi,
  ref: { readonly namespace: string; readonly name: string },
  expectedHost: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<HostReconcileResult | null> {
  let current: CertificateLike;
  try {
    current = (await custom.getNamespacedCustomObject({
      group: CERT_GROUP,
      version: CERT_VERSION,
      namespace: ref.namespace,
      plural: CERT_PLURAL,
      name: ref.name,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0])) as CertificateLike;
  } catch (err) {
    log.warn({ err, ...ref }, 'traefik-host-reconcile: Certificate not found — skipping');
    return null;
  }

  const dnsNames = current.spec?.dnsNames ?? [];
  const previousHost = dnsNames[0] ?? null;
  const annotationMissing =
    (current.metadata?.annotations ?? {})[FLUX_RECONCILE_KEY] !== 'disabled';

  if (previousHost === expectedHost && dnsNames.length === 1 && !annotationMissing) {
    return { expectedHost, previousHost, patched: false };
  }

  await custom.patchNamespacedCustomObject(
    {
      group: CERT_GROUP,
      version: CERT_VERSION,
      namespace: ref.namespace,
      plural: CERT_PLURAL,
      name: ref.name,
      body: { metadata: { annotations: { ...FLUX_RECONCILE_DISABLED } }, spec: { dnsNames: [expectedHost] } },
    } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );

  log.info({ ...ref, previousHost, expectedHost }, 'traefik-host-reconcile: Certificate dnsNames reconciled');
  return { expectedHost, previousHost, patched: true };
}
