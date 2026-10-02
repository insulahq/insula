/**
 * The platform's "suspended" page and the URL suspended tenants are sent to.
 *
 * A suspended tenant's routes 307 every request to `https://suspended.<apex>/`
 * (ingress-suspend.ts), served by the `platform-suspended-page` IngressRoute
 * in `platform` (k8s/base/platform-suspended.yaml).
 *
 * The redirect target used to be a constant, `https://suspended.platform.local/`,
 * with an env override no manifest ever set — visitors of every suspended site
 * were sent to a host no resolver knows. It now derives from the platform apex
 * like every other platform hostname; `SUSPENDED_REDIRECT_URL` still overrides.
 *
 * This module owns the page's IngressRoute + Certificate: it CREATES them when
 * missing, keeps Host + dnsNames on the apex (a platform-apex rename follows),
 * and re-points the redirects of tenants that are already suspended. The
 * `reconcile: disabled` manifests are only a fresh-install seed — Flux skips a
 * disowned object even when it does not exist yet (measured: the apply log
 * reports it `skipped`), so on an existing cluster nothing else creates them.
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
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  MIDDLEWARE_PLURAL,
  INGRESSROUTE_PLURAL,
  CERTMANAGER_GROUP,
  CERTMANAGER_VERSION,
  CERTIFICATE_PLURAL,
} from '../ingress-routes/traefik-types.js';
import { isK8sNotFound } from '../ingress-routes/traefik-apply.js';

export const SUSPENDED_PAGE_IR_NAME = 'platform-suspended-page';
export const SUSPENDED_PAGE_CERT_NAME = 'platform-suspended-page';
export const SUSPENDED_PAGE_NAMESPACE = 'platform';
/** Label every suspend RedirectRegex Middleware carries (ingress-suspend.ts). */
export const SUSPEND_MIDDLEWARE_LABEL = 'hosting-platform/suspend';

const SUSPENDED_REDIRECT_URL_ENV = 'SUSPENDED_REDIRECT_URL';

/** `suspended.<apex>`, or null while no apex is configured. */
export async function resolveSuspendedPageHost(db: Database): Promise<string | null> {
  const apex = await getPlatformApex(db);
  if (!apex) return null;
  const host = `suspended.${apex}`.toLowerCase();
  return isValidPlatformHostname(host) ? host : null;
}

/**
 * Where a suspended tenant's visitors are sent. The env override wins (an
 * operator pointing at their own page); otherwise the apex-derived page.
 * Null when neither is known — callers must not invent a host.
 */
export async function resolveSuspendedRedirectUrl(db: Database): Promise<string | null> {
  const override = process.env[SUSPENDED_REDIRECT_URL_ENV]?.trim();
  if (override) return override;
  const host = await resolveSuspendedPageHost(db);
  return host ? `https://${host}/` : null;
}

const FLUX_DISOWNED = { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } as const;
const PAGE_LABELS = { 'app.kubernetes.io/part-of': 'hosting-platform' } as const;
const PAGE_TLS_SECRET = 'platform-suspended-page-tls';

/** The page's IngressRoute as k8s/base/platform-suspended.yaml seeds it. */
export function suspendedPageIngressRoute(host: string): Record<string, unknown> {
  return {
    apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
    kind: 'IngressRoute',
    metadata: {
      name: SUSPENDED_PAGE_IR_NAME,
      namespace: SUSPENDED_PAGE_NAMESPACE,
      labels: { ...PAGE_LABELS },
      annotations: { ...FLUX_DISOWNED },
    },
    spec: {
      entryPoints: ['websecure'],
      routes: [{
        match: `Host(\`${host}\`)`,
        kind: 'Rule',
        services: [{ name: 'platform-suspended', port: 80 }],
      }],
      tls: { secretName: PAGE_TLS_SECRET },
    },
  };
}

/** The page's Certificate as k8s/base/platform-suspended.yaml seeds it. */
export function suspendedPageCertificate(host: string, clusterIssuerName: string): Record<string, unknown> {
  return {
    apiVersion: `${CERTMANAGER_GROUP}/${CERTMANAGER_VERSION}`,
    kind: 'Certificate',
    metadata: {
      name: SUSPENDED_PAGE_CERT_NAME,
      namespace: SUSPENDED_PAGE_NAMESPACE,
      labels: { ...PAGE_LABELS },
      annotations: { ...FLUX_DISOWNED },
    },
    spec: {
      secretName: PAGE_TLS_SECRET,
      duration: '2160h',
      renewBefore: '720h',
      privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
      usages: ['digital signature', 'key encipherment', 'server auth'],
      dnsNames: [host],
      issuerRef: { name: clusterIssuerName, kind: 'ClusterIssuer', group: CERTMANAGER_GROUP },
    },
  };
}

/** Create `body` unless it already exists. Returns whether it was created. */
async function createIfMissing(
  custom: k8s.CustomObjectsApi,
  ref: { group: string; version: string; plural: string; name: string },
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    await custom.getNamespacedCustomObject({ ...ref, namespace: SUSPENDED_PAGE_NAMESPACE });
    return false;
  } catch (err) {
    if (!isK8sNotFound(err)) throw err;
  }
  await custom.createNamespacedCustomObject({
    group: ref.group,
    version: ref.version,
    namespace: SUSPENDED_PAGE_NAMESPACE,
    plural: ref.plural,
    body,
  });
  return true;
}

export interface SuspendedPageReconcileResult {
  readonly host: string | null;
  /** Objects this run had to create (absent on an existing cluster). */
  readonly created: string[];
  readonly ingressRoute: HostReconcileResult | null;
  readonly certificate: HostReconcileResult | null;
  readonly redirects: RepointResult | null;
}

/**
 * Converge the page's Host + cert dnsNames to the apex, then re-point every
 * suspended tenant at the current URL. Best-effort; never throws.
 */
export async function reconcileSuspendedPageIngress(
  db: Database,
  custom: k8s.CustomObjectsApi,
  log: Pick<Logger, 'info' | 'warn'>,
  // platform-api's CLUSTER_ISSUER_NAME. Without it the Certificate is not
  // created (Traefik then serves its default cert) — never a guessed issuer.
  clusterIssuerName?: string,
): Promise<SuspendedPageReconcileResult> {
  const host = await resolveSuspendedPageHost(db);
  let ingressRoute: HostReconcileResult | null = null;
  let certificate: HostReconcileResult | null = null;
  const created: string[] = [];
  if (host) {
    // A failed create/patch must not cost the redirect re-point below, nor
    // reject the startup Promise.all this runs in alongside the other hosts.
    try {
      if (await createIfMissing(
        custom,
        { group: TRAEFIK_GROUP, version: TRAEFIK_VERSION, plural: INGRESSROUTE_PLURAL, name: SUSPENDED_PAGE_IR_NAME },
        suspendedPageIngressRoute(host),
      )) created.push(`IngressRoute/${SUSPENDED_PAGE_IR_NAME}`);
      const issuer = clusterIssuerName?.trim();
      if (issuer) {
        if (await createIfMissing(
          custom,
          { group: CERTMANAGER_GROUP, version: CERTMANAGER_VERSION, plural: CERTIFICATE_PLURAL, name: SUSPENDED_PAGE_CERT_NAME },
          suspendedPageCertificate(host, issuer),
        )) created.push(`Certificate/${SUSPENDED_PAGE_CERT_NAME}`);
      } else {
        log.warn({ host }, 'suspended-page: no CLUSTER_ISSUER_NAME — certificate not created');
      }
      if (created.length > 0) log.info({ host, created }, 'suspended-page: created the suspended page objects');
      ingressRoute = await reconcileIngressRouteHost(
        custom, { namespace: SUSPENDED_PAGE_NAMESPACE, name: SUSPENDED_PAGE_IR_NAME }, host, log,
      );
      certificate = await reconcileCertificateDnsName(
        custom, { namespace: SUSPENDED_PAGE_NAMESPACE, name: SUSPENDED_PAGE_CERT_NAME }, host, log,
      );
    } catch (err) {
      log.warn({ err, host }, 'suspended-page: host reconcile failed — redirects still re-pointed');
    }
  }
  const url = await resolveSuspendedRedirectUrl(db);
  const redirects = url ? await repointSuspendedRedirects(custom, url, log) : null;
  return { host, created, ingressRoute, certificate, redirects };
}

export interface RepointResult {
  readonly scanned: number;
  readonly repointed: string[];
  readonly failed: string[];
}

interface SuspendMiddleware {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: { readonly redirectRegex?: { readonly replacement?: string } };
}

/**
 * Point every suspend Middleware at `url`. A tenant suspended under the old
 * placeholder (or before an apex rename) keeps its Middleware until resumed,
 * so without this its visitors stay on a dead host. One cluster-wide list,
 * one patch per stale Middleware.
 */
export async function repointSuspendedRedirects(
  custom: k8s.CustomObjectsApi,
  url: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<RepointResult> {
  let items: SuspendMiddleware[];
  try {
    const res = await custom.listClusterCustomObject({
      group: TRAEFIK_GROUP,
      version: TRAEFIK_VERSION,
      plural: MIDDLEWARE_PLURAL,
      labelSelector: `${SUSPEND_MIDDLEWARE_LABEL}=true`,
    });
    items = (res as { items?: SuspendMiddleware[] }).items ?? [];
  } catch (err) {
    log.warn({ err }, 'suspended-page: could not list suspend middlewares — redirects not re-pointed');
    return { scanned: 0, repointed: [], failed: [] };
  }

  const repointed: string[] = [];
  const failed: string[] = [];
  for (const mw of items) {
    const name = mw.metadata?.name;
    const namespace = mw.metadata?.namespace;
    if (!name || !namespace) continue;
    if (mw.spec?.redirectRegex?.replacement === url) continue;
    try {
      // Merge patch: only the target changes; regex + permanent stay.
      await custom.patchNamespacedCustomObject(
        {
          group: TRAEFIK_GROUP,
          version: TRAEFIK_VERSION,
          namespace,
          plural: MIDDLEWARE_PLURAL,
          name,
          body: { spec: { redirectRegex: { replacement: url } } },
        } as unknown as Parameters<typeof custom.patchNamespacedCustomObject>[0],
        MERGE_PATCH,
      );
      repointed.push(`${namespace}/${name}`);
    } catch (err) {
      failed.push(`${namespace}/${name}`);
      log.warn({ err, namespace, name }, 'suspended-page: could not re-point suspend middleware');
    }
  }
  if (repointed.length > 0) {
    log.info({ url, repointed }, 'suspended-page: re-pointed suspended tenants at the current page');
  }
  return { scanned: items.length, repointed, failed };
}
