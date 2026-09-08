/**
 * Multi-host reconciler — makes a deployment's pods serve exactly the sites
 * its routes describe.
 *
 * Delivery, and why it looks like this:
 *
 *   render → apply ConfigMap → wait for the projection → validate → reload
 *
 * The ConfigMap is the ONLY source. A pod that restarts mounts it and comes up
 * correct with no help from the platform, which is the property an
 * exec-the-config-into-the-pod design cannot offer: there, a restart serves the
 * catch-all until something notices and pushes again.
 *
 * The cost is kubelet's projection delay (up to its sync period) between
 * writing the ConfigMap and the files appearing in the pod. We wait for it
 * explicitly, by polling a `checksum.txt` key that is deliberately NOT `.conf`
 * so the image's include glob ignores it. Waiting is honest: reloading before
 * the files land would silently reload the OLD config and report success.
 *
 * Validate before reload, always. `apache2ctl configtest` exits non-zero on a
 * malformed vhost, and a reload is the one moment a bad config can take a
 * tenant's running sites down. On a failed check we leave the server untouched
 * and surface the message — the sites keep serving the last good config.
 */

import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { catalogEntries, deployments, domains, ingressRoutes } from '../../db/schema.js';
import { execInPod } from '../../shared/k8s-exec.js';
import { renderSites, type MultihostCapability, type RenderResult, type SiteRoute } from './renderer.js';
import type { MultihostMounts } from '../deployments/k8s-deployer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const MULTIHOST_FIELD_MANAGER = 'platform-api-multihost';
/** Key holding the render hash. Not `.conf`, so the include glob skips it. */
export const CHECKSUM_KEY = 'checksum.txt';

/** ConfigMap holding one vhost file per site for a deployment. */
export function vhostConfigMapName(deploymentName: string): string {
  return `${deploymentName}-vhosts`;
}

export interface MultihostClients {
  readonly core: k8s.CoreV1Api;
}

export interface DeploymentReconcileResult {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly siteCount: number;
  readonly skipped: RenderResult['skipped'];
  readonly changed: boolean;
  /** Pods that accepted the new config. */
  readonly reloaded: number;
  /** Pods that could not be reloaded, with the reason. */
  readonly failures: ReadonlyArray<{ pod: string; reason: string }>;
  /**
   * Sites whose folder does not exist on the tenant's storage.
   *
   * Apache treats a missing DocumentRoot as a WARNING — `configtest` still
   * exits 0 and the reload succeeds — so one route pointing at a deleted
   * folder cannot block the other sites on the pod. That is the right
   * behaviour, and it is also why the condition has to be reported on
   * purpose: otherwise the only symptom is one site answering 404 while every
   * status the platform shows says the change applied cleanly.
   */
  readonly missingFolders: ReadonlyArray<{ routeId: string; documentRoot: string }>;
  /**
   * Whether the folder-existence check could run at all.
   *
   * `unavailable` is NOT the same as an empty `missingFolders`, and conflating
   * them is how a check that never ran reports a clean result. It happens for
   * real: a distroless image (static-nginx) has no shell, so the probe's exec
   * fails outright — and reporting "no folders missing" there would be a
   * confident answer to a question nobody asked.
   */
  readonly folderCheck: 'ok' | 'unavailable';
}

function hashFiles(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const key of Object.keys(files).sort()) {
    h.update(key).update('\0').update(files[key]).update('\0');
  }
  return h.digest('hex');
}

/**
 * Read the capability off a catalog entry, or null when the entry cannot do
 * multi-host. Shape-checked rather than trusted: the column is jsonb copied
 * from a manifest, and a half-written block must not produce half a vhost.
 */
export function capabilityOf(entry: { multihost?: unknown } | null | undefined): MultihostCapability | null {
  const raw = entry?.multihost as Partial<MultihostCapability> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const ok =
    typeof raw.server === 'string' &&
    typeof raw.web_root === 'string' &&
    typeof raw.sites_root === 'string' &&
    typeof raw.config_dir === 'string' &&
    typeof raw.common_include === 'string' &&
    typeof raw.listen === 'number' &&
    Array.isArray(raw.validate) && raw.validate.length > 0 &&
    Array.isArray(raw.reload) && raw.reload.length > 0;
  return ok ? (raw as MultihostCapability) : null;
}

/** The container to exec into: the component that owns the ingress port. */
export function ingressContainerName(
  entry: { components?: Array<{ name: string; ports?: Array<{ ingress?: boolean }> }> | null },
  deploymentName: string,
): string {
  const components = entry.components ?? [];
  const owner = components.find((c) => (c.ports ?? []).some((p) => p.ingress === true));
  // Single-component entries name the container after the component; with no
  // components at all the deployer falls back to the deployment name.
  return owner?.name ?? components[0]?.name ?? deploymentName;
}

async function applyVhostConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
  data: Record<string, string>,
  labels: Record<string, string>,
): Promise<{ changed: boolean }> {
  let existing: { data?: Record<string, string>; metadata?: { resourceVersion?: string } } | undefined;
  try {
    existing = await core.readNamespacedConfigMap({ name, namespace }) as typeof existing;
  } catch {
    existing = undefined;
  }

  if (!existing) {
    await core.createNamespacedConfigMap({
      namespace,
      body: { metadata: { name, namespace, labels }, data },
    });
    return { changed: true };
  }

  const current = existing.data ?? {};
  const same =
    Object.keys(current).length === Object.keys(data).length &&
    Object.keys(data).every((k) => current[k] === data[k]);
  if (same) return { changed: false };

  // REPLACE, not patch. A merge patch leaves keys that are no longer in `data`
  // untouched, so deleting a route would leave its vhost file in place and the
  // site would keep serving — the deletion would appear to have worked.
  await core.replaceNamespacedConfigMap({
    name,
    namespace,
    body: {
      metadata: { name, namespace, labels, resourceVersion: existing.metadata?.resourceVersion },
      data,
    },
  });
  return { changed: true };
}

interface PodRef { readonly name: string; readonly container: string }

async function runningPods(
  core: k8s.CoreV1Api,
  namespace: string,
  deploymentName: string,
  container: string,
): Promise<PodRef[]> {
  const list = await core.listNamespacedPod({ namespace, labelSelector: `app=${deploymentName}` });
  return (list.items ?? [])
    .filter((p) => p.status?.phase === 'Running')
    .filter((p) => (p.spec?.containers ?? []).some((c) => c.name === container))
    .map((p) => ({ name: p.metadata?.name ?? '', container }))
    .filter((p) => p.name !== '');
}

/**
 * Wait until the pod's mounted copy carries the checksum we just wrote.
 *
 * Polling the projected file rather than sleeping a fixed time is what makes
 * the subsequent reload meaningful — otherwise a reload can pick up the
 * previous generation and every signal we have says it succeeded.
 */
async function waitForProjection(
  kubeconfigPath: string | undefined,
  namespace: string,
  pod: PodRef,
  checksumPath: string,
  expected: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await execInPod(kubeconfigPath, namespace, pod.name, pod.container, ['cat', checksumPath])
      .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    if (r.exitCode === 0 && r.stdout.trim() === expected) return true;
    if (Date.now() >= deadline) return false;
    await sleep(3000);
  }
}

export interface ReconcileDeploymentInput {
  readonly kubeconfigPath?: string;
  readonly namespace: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly capability: MultihostCapability;
  readonly containerName: string;
  readonly routes: readonly SiteRoute[];
  readonly logger?: Logger;
  /** Injected so tests do not spend real time in the projection poll. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly projectionTimeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function reconcileDeploymentSites(
  clients: MultihostClients,
  input: ReconcileDeploymentInput,
): Promise<DeploymentReconcileResult> {
  const { capability: cap, namespace, deploymentName } = input;
  const rendered = renderSites(cap, input.routes);
  const hash = hashFiles(rendered.files);
  const data = { ...rendered.files, [CHECKSUM_KEY]: hash };

  const cmName = vhostConfigMapName(deploymentName);
  const { changed } = await applyVhostConfigMap(clients.core, namespace, cmName, data, {
    'app.kubernetes.io/managed-by': MULTIHOST_FIELD_MANAGER,
    app: deploymentName,
  });

  const base: Omit<DeploymentReconcileResult, 'reloaded' | 'failures' | 'missingFolders' | 'folderCheck'> = {
    deploymentId: input.deploymentId,
    deploymentName,
    siteCount: rendered.sites.length,
    skipped: rendered.skipped,
    changed,
  };

  if (!changed) return { ...base, reloaded: 0, failures: [], missingFolders: [], folderCheck: 'ok' };

  const pods = await runningPods(clients.core, namespace, deploymentName, input.containerName);
  if (pods.length === 0) {
    // Scaled to zero or still starting. The ConfigMap is written, so whenever a
    // pod does come up it mounts the right config — nothing to reload.
    return { ...base, reloaded: 0, failures: [], missingFolders: [], folderCheck: 'ok' };
  }

  const checksumPath = `${cap.config_dir}/${CHECKSUM_KEY}`;
  const sleep = input.sleep ?? defaultSleep;
  const timeout = input.projectionTimeoutMs ?? 120_000;
  const failures: Array<{ pod: string; reason: string }> = [];
  let reloaded = 0;

  for (const pod of pods) {
    const projected = await waitForProjection(
      input.kubeconfigPath, namespace, pod, checksumPath, hash, timeout, sleep,
    );
    if (!projected) {
      failures.push({ pod: pod.name, reason: `Site configuration did not reach the pod within ${Math.round(timeout / 1000)}s.` });
      continue;
    }

    const check = await execInPod(input.kubeconfigPath, namespace, pod.name, pod.container, [...cap.validate]);
    if (check.exitCode !== 0) {
      // Deliberately NOT reloading. The running server keeps the last good
      // config; a reload here is what would take the tenant's sites down.
      const detail = (check.stderr || check.stdout).trim().split('\n').slice(-2).join(' ');
      failures.push({ pod: pod.name, reason: `Web-server config check failed, reload skipped: ${detail}` });
      continue;
    }

    const reload = await execInPod(input.kubeconfigPath, namespace, pod.name, pod.container, [...cap.reload]);
    if (reload.exitCode !== 0) {
      const detail = (reload.stderr || reload.stdout).trim().split('\n').slice(-2).join(' ');
      failures.push({ pod: pod.name, reason: `Graceful reload failed: ${detail}` });
      continue;
    }
    reloaded += 1;
  }

  const folders = pods.length > 0
    ? await findMissingFolders(input.kubeconfigPath, namespace, pods[0], rendered.sites)
    : { missing: [], check: 'ok' as const };

  return { ...base, reloaded, failures, missingFolders: folders.missing, folderCheck: folders.check };
}

/**
 * Which site folders are absent, asked in ONE exec rather than one per site.
 *
 * Deliberately not a text-scan of the configtest output: Apache's
 * "DocumentRoot does not exist" warning is only emitted on some paths and
 * parsing server prose for a fact the filesystem can answer directly is the
 * kind of check that quietly stops working.
 */
async function findMissingFolders(
  kubeconfigPath: string | undefined,
  namespace: string,
  pod: PodRef,
  sites: readonly { routeId: string; documentRoot: string }[],
): Promise<{ missing: Array<{ routeId: string; documentRoot: string }>; check: 'ok' | 'unavailable' }> {
  if (sites.length === 0) return { missing: [], check: 'ok' };
  // The folder passed `folderProblem` and sites_root comes from the manifest,
  // so neither can hold a quote — but this string becomes a shell command, and
  // "cannot happen" is not a reason to interpolate unchecked.
  const safe = sites.filter((s) => !/['"\\\n$`]/.test(s.documentRoot) && /^[A-Za-z0-9-]+$/.test(s.routeId));
  if (safe.length === 0) return { missing: [], check: 'ok' };
  const script = safe
    .map((s) => `test -d '${s.documentRoot}' || echo '${s.routeId}'`)
    .join('; ');
  const r = await execInPod(kubeconfigPath, namespace, pod.name, pod.container, ['sh', '-c', script])
    .catch(() => null);
  // A distroless image has no `sh`, so the exec fails rather than answering.
  // Say so instead of returning an empty list that reads as "all present".
  if (!r || r.exitCode !== 0) return { missing: [], check: 'unavailable' };
  const missing = new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  return {
    missing: safe.filter((s) => missing.has(s.routeId)).map((s) => ({ routeId: s.routeId, documentRoot: s.documentRoot })),
    check: 'ok',
  };
}

/**
 * Reconcile every multi-host deployment in a tenant namespace.
 *
 * Called from `reconcileIngress`, which is the one place every route mutation
 * already funnels through — route create, patch, delete, the settings PATCHes,
 * and the bandwidth/mTLS paths all reach it. Hooking there rather than at each
 * call site is what stops a new caller from silently skipping site config.
 */
export async function reconcileTenantSites(
  db: Db,
  clients: MultihostClients,
  tenantId: string,
  namespace: string,
  kubeconfigPath?: string,
  logger?: Logger,
): Promise<DeploymentReconcileResult[]> {
  const rows = await db
    .select({ deployment: deployments, entry: catalogEntries })
    .from(deployments)
    .leftJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .where(and(eq(deployments.tenantId, tenantId), eq(deployments.multihostEnabled, true)));

  const results: DeploymentReconcileResult[] = [];
  for (const { deployment, entry } of rows) {
    const cap = capabilityOf(entry);
    if (!cap) {
      // multihost_enabled with no capability: the entry lost the manifest block
      // (catalog re-synced) or the flag was set before a guard existed. Do
      // nothing rather than guess a layout — the deployment still serves its
      // stock docroot.
      logger?.warn({ deploymentId: deployment.id }, 'multihost: enabled but catalog entry declares no capability');
      continue;
    }

    const routeRows = await db
      .select({
        id: ingressRoutes.id,
        hostname: ingressRoutes.hostname,
        path: ingressRoutes.path,
        wwwRedirect: ingressRoutes.wwwRedirect,
        siteFolder: ingressRoutes.siteFolder,
      })
      .from(ingressRoutes)
      .innerJoin(domains, eq(ingressRoutes.domainId, domains.id))
      .where(and(
        eq(ingressRoutes.deploymentId, deployment.id),
        isNotNull(ingressRoutes.siteFolder),
      ));

    const routes: SiteRoute[] = routeRows.map((r) => ({
      id: r.id,
      hostname: r.hostname,
      path: r.path,
      wwwRedirect: r.wwwRedirect as SiteRoute['wwwRedirect'],
      siteFolder: r.siteFolder as string,
    }));

    try {
      const result = await reconcileDeploymentSites(clients, {
        kubeconfigPath,
        namespace,
        deploymentId: deployment.id,
        deploymentName: deployment.name,
        capability: cap,
        containerName: ingressContainerName(entry ?? {}, deployment.name),
        routes,
        logger,
      });
      results.push(result);
      if (result.skipped.length > 0 || result.failures.length > 0 || result.missingFolders.length > 0) {
        logger?.warn({
          deploymentId: deployment.id,
          skipped: result.skipped,
          failures: result.failures,
          missingFolders: result.missingFolders,
          folderCheck: result.folderCheck,
        }, 'multihost: some sites were not applied cleanly');
      }
    } catch (err) {
      logger?.error({ err, deploymentId: deployment.id }, 'multihost: reconcile failed');
    }
  }
  return results;
}

/**
 * Mounts a deployment needs for multi-host serving, or null when it should not
 * get them.
 *
 * Every `deployCatalogEntry` call site must go through this — a redeploy or a
 * version upgrade that forgot it would rewrite the pod template WITHOUT the
 * include directory and the storage root, and every site on that pod would
 * quietly fall back to the stock document root. An optional parameter makes a
 * missed call site silent, so the helper exists to make "did you thread it?"
 * a single greppable question.
 */
export function multihostMountsFor(
  deployment: { readonly name: string; readonly multihostEnabled?: boolean | null },
  entry: { readonly multihost?: unknown } | null | undefined,
): MultihostMounts | null {
  if (!deployment.multihostEnabled) return null;
  const cap = capabilityOf(entry);
  if (!cap) return null;
  return {
    configDir: cap.config_dir,
    sitesRoot: cap.sites_root,
    configMapName: vhostConfigMapName(deployment.name),
  };
}

/**
 * Remove a deployment's generated site config.
 *
 * Called when multi-host is turned off. The pod loses the mount in the same
 * redeploy, so leaving the ConfigMap behind would be harmless — and would
 * accumulate one orphan per deployment that ever tried the feature, each one
 * looking like live configuration to anyone reading the namespace.
 */
export async function deleteDeploymentSites(
  clients: MultihostClients,
  namespace: string,
  deploymentName: string,
  logger?: Logger,
): Promise<void> {
  const name = vhostConfigMapName(deploymentName);
  try {
    await clients.core.deleteNamespacedConfigMap({ name, namespace });
  } catch (err) {
    // Already gone is the desired state, not a failure.
    const status = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { statusCode?: number; code?: number })?.code;
    if (status !== 404) {
      logger?.warn({ err, name, namespace }, 'multihost: could not delete site ConfigMap');
    }
  }
}
