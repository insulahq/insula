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
import {
  minimalSiteFolders,
  MULTIHOST_SESSION_ROOT,
  sessionDirInitCommands,
  isSessionDirCommand,
} from '../deployments/k8s-deployer.js';
import { renderSites, isMultihostFlavour, type MultihostCapability, type MultihostFlavour, type RenderResult, type SiteRoute } from './renderer.js';
import type { MultihostMounts } from '../deployments/k8s-deployer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NodePgDatabase<any>;

export const MULTIHOST_FIELD_MANAGER = 'platform-api-multihost';
/**
 * Key holding the render hash.
 *
 * Deliberately a `.conf` holding nothing but a comment, so it IS picked up by
 * the image's include glob. That is what lets the nginx flavour prove the
 * projection landed with `nginx -T` (which dumps the effective config from
 * disk) instead of reading the file — a distroless image has no `cat`, and the
 * previous `checksum.txt` was unreadable there, so the reload never fired and
 * the sites silently stayed on the catch-all. A comment is inert in both
 * flavours.
 */
export const CHECKSUM_KEY = 'zzz-insula-checksum.conf';
const checksumFile = (hash: string): string => `# insula-checksum ${hash}\n`;

/**
 * How each flavour proves the new generation has reached the pod's mount.
 *
 * A Record so tsc refuses a flavour with no probe — silently skipping the check
 * would mean reloading before the files land, which reloads the PREVIOUS
 * generation and reports success.
 *
 *  - apache runs on full distributions, so it reads the file directly.
 *  - nginx uses its own binary: `-T` re-reads the config from disk and prints
 *    it, so the checksum comment shows up without needing any userland at all.
 *    This is what makes the distroless image work.
 */
const PROJECTION_PROBES: Record<MultihostFlavour, (cap: MultihostCapability) => string[]> = {
  apache: (cap) => ['cat', `${cap.config_dir}/${CHECKSUM_KEY}`],
  nginx: (cap) => [cap.validate[0], '-T'],
};

/** ConfigMap holding one vhost file per site for a deployment. */
export function vhostConfigMapName(deploymentName: string): string {
  return `${deploymentName}-vhosts`;
}

export interface MultihostClients {
  readonly core: k8s.CoreV1Api;
  /**
   * Required, not optional. Site folders are mounts, so keeping them in step
   * with the routes is part of reconciling — a caller without `apps` would
   * write a correct ConfigMap onto a pod that cannot see the folders it names,
   * and every status would still read green.
   */
  readonly apps: k8s.AppsV1Api;
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
  if (!ok) return null;
  // `sites_root` is a manifest value that becomes a mountPath, a DocumentRoot
  // and the open_basedir prefix. It was only checked for being a string, while
  // the adjacent `php` block was validated carefully — an inconsistency a
  // third-party catalog repo could walk through with `sites_root: "/etc"`.
  if (!absolutePathIsSane(raw.sites_root as string)) return null;
  if (!phpSandboxIsSane(raw.php, raw.sites_root as string)) return null;
  return raw as MultihostCapability;
}

/**
 * Validate the optional `php` block instead of trusting it.
 *
 * Admins can add third-party catalog repositories, and this block decides how
 * far a site's PHP may reach. A repo supplying `open_basedir_extra: ["/"]` — or
 * any ancestor of `sites_root` — would leave the directive syntactically
 * present and semantically empty: every site could read every other site's
 * files again, while the panel still showed a sandbox. That is worse than no
 * sandbox, because it looks like one.
 *
 * An unusable block fails the whole capability rather than being dropped: an
 * entry that cannot be sandboxed must not silently fall back to serving
 * multi-host unsandboxed.
 */
/**
 * An absolute container path the platform is willing to build config and
 * mounts from: no traversal, no injection characters, and not a system
 * directory whose contents a site must never be handed.
 */
export function absolutePathIsSane(p: unknown): boolean {
  if (typeof p !== 'string' || !p.startsWith('/') || p === '/') return false;
  if (/[:\n\r\0"'`\\]/.test(p)) return false;
  const segs = p.replace(/\/+$/, '').split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  // A handful of roots that are never a tenant site tree. Not exhaustive by
  // design — the checks above do the real work; this refuses the obviously
  // wrong answers loudly rather than mounting over /etc.
  const FORBIDDEN = ['/etc', '/proc', '/sys', '/dev', '/root', '/boot', '/usr/bin', '/usr/sbin', '/bin', '/sbin'];
  const norm = p.replace(/\/+$/, '');
  return !FORBIDDEN.some((f) => norm === f || norm.startsWith(`${f}/`));
}

export function phpSandboxIsSane(php: unknown, sitesRoot: string): boolean {
  if (php === undefined || php === null) return true;
  if (typeof php !== 'object') return false;
  const extra = (php as { open_basedir_extra?: unknown }).open_basedir_extra;
  if (extra === undefined) return true;
  if (!Array.isArray(extra)) return false;
  return extra.every((v) => {
    if (typeof v !== 'string' || v.length === 0) return false;
    // `:` separates entries and a newline would end the directive — either
    // would smuggle in paths the platform never approved.
    if (/[:\n\r]/.test(v)) return false;
    if (!v.startsWith('/')) return false;
    if (v === '/') return false;
    const norm = v.replace(/\/+$/, '');
    // Compare CANONICAL paths, never raw strings. `/var/www/sites/x/../..`
    // is textually neither equal to nor a prefix of the sites root, so a
    // prefix test waves it through — while the filesystem resolves it to an
    // ancestor, which is precisely the "every site readable again" case this
    // function exists to refuse. Reject traversal outright rather than trying
    // to normalise it: a path that needs `..` to describe itself has no
    // business in a sandbox declaration.
    const segments = norm.split('/').slice(1);
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
    // An ANCESTOR of the sites root dissolves the sandbox outright.
    if (sitesRoot === norm || sitesRoot.startsWith(`${norm}/`)) return false;
    // A DESCENDANT of it is narrower but still wrong: it is tenant storage,
    // granted identically to every site on the image, so one manifest line
    // would hand every site a shared window into a folder of that name. Only
    // paths outside the tenant tree — /tmp and friends — are legitimate here.
    if (norm === sitesRoot || norm.startsWith(`${sitesRoot}/`)) return false;
    return true;
  });
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
  probe: readonly string[],
  expected: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await execInPod(kubeconfigPath, namespace, pod.name, pod.container, [...probe])
      .catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    // CONTAINS, not equals: `cat` returns just the comment line while `nginx -T`
    // returns the whole effective config with the comment somewhere inside it.
    if (r.exitCode === 0 && r.stdout.includes(expected)) return true;
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
  /**
   * Return as soon as the ConfigMap is written, leaving the projection wait and
   * the reload to run detached.
   *
   * The request path sets this. Waiting for kubelet to project a ConfigMap and
   * then reloading takes tens of seconds, and a route PATCH that did it inline
   * ran ~52s and came back as a Traefik 502 — while the change had actually
   * applied. A tenant saw an error for a save that worked, which is worse than
   * slow.
   *
   * Deferring is safe precisely because the ConfigMap is the durable source: it
   * is written before the response, so a pod restarting at any point afterwards
   * comes up serving the new sites regardless of whether the reload landed.
   * The reload only shortens the wait for a pod that is already running.
   */
  readonly deferActivation?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function reconcileDeploymentSites(
  clients: MultihostClients,
  input: ReconcileDeploymentInput,
): Promise<DeploymentReconcileResult> {
  const { capability: cap, namespace, deploymentName } = input;
  const rendered = renderSites(cap, input.routes);
  const hash = hashFiles(rendered.files);
  const data = { ...rendered.files, [CHECKSUM_KEY]: checksumFile(hash) };

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

  // Bring the pod's MOUNTS in line before anything is asked to serve from
  // them. Each application root is its own mount, so a route that starts (or
  // stops) serving a folder changes the pod template — and a vhost whose
  // document root is not mounted answers 404 while every status the platform
  // shows says the change applied.
  //
  // Runs even when the ConfigMap is unchanged: a pod can come back from a
  // restore, a manual edit or an older template with the wrong mounts, and the
  // rendered config alone would look correct.
  const mountsChanged = await ensureSiteMounts(clients, input, rendered);
  if (mountsChanged) {
    // The pod template changed, so Kubernetes is replacing the pod. The
    // replacement reads the ConfigMap at startup, which is both the projection
    // wait and the reload — doing either against a terminating pod would fail
    // for a change that has, in fact, applied.
    input.logger?.info(
      { deployment: deploymentName, sites: rendered.sites.length },
      'multihost: site mounts changed, pod is being replaced',
    );
    // folderCheck is 'unavailable', NOT 'ok'. The pod is being replaced, so the
    // folder probe has not run and cannot run against a terminating container.
    // Reporting 'ok' here would be the exact conflation this type exists to
    // prevent — a check that never ran reading as a clean result — and it would
    // hide a replacement pod that never comes up (quota, image pull, crash).
    return { ...base, changed: true, reloaded: 0, failures: [], missingFolders: [], folderCheck: 'unavailable' };
  }

  if (!changed) return { ...base, reloaded: 0, failures: [], missingFolders: [], folderCheck: 'ok' };

  if (input.deferActivation) {
    // Detached on purpose: the caller is an HTTP handler. Failures are logged
    // here and re-attempted by the next reconcile, which is idempotent.
    void activateSites(clients, input, rendered, hash).catch((err) => {
      input.logger?.warn({ err, deployment: deploymentName }, 'multihost: background activation failed');
    });
    return { ...base, reloaded: 0, failures: [], missingFolders: [], folderCheck: 'ok' };
  }

  const activation = await activateSites(clients, input, rendered, hash);
  return { ...base, ...activation };
}

/**
 * Make the pod's site mounts match the folders it is supposed to serve.
 *
 * Returns true when the pod template was changed (and therefore the pod is
 * being replaced), false when it already matched.
 *
 * Only mounts UNDER `sites_root` are touched. Everything else on the
 * container — the deployment's own document root, tenant extra_mounts, the
 * vhost ConfigMap — is left exactly as found: this function knows about site
 * folders, and rewriting a mount list it does not fully understand is how a
 * reconciler silently unmounts somebody's data.
 */
async function ensureSiteMounts(
  clients: MultihostClients,
  input: ReconcileDeploymentInput,
  rendered: RenderResult,
): Promise<boolean> {
  const { capability: cap, namespace, deploymentName, containerName } = input;
  const sitesRoot = cap.sites_root;

  // Desired: one mount per application root actually being served. Derived
  // from the RENDERED sites, so a route skipped as invalid never mounts.
  const desired = minimalSiteFolders(
    rendered.sites.map((site) => site.appRootPath.slice(sitesRoot.length + 1)).filter(Boolean),
  );

  let dep: {
    metadata?: Record<string, unknown>;
    spec?: { template?: { spec?: {
      containers?: Array<Record<string, unknown>>;
      initContainers?: Array<Record<string, unknown>>;
    } } };
  };
  try {
    const res = await clients.apps.readNamespacedDeployment({ name: deploymentName, namespace } as never);
    dep = res as typeof dep;
  } catch (err) {
    // No Deployment yet (first create) — the deployer builds the mounts.
    input.logger?.debug({ err, deployment: deploymentName }, 'multihost: no deployment to patch');
    return false;
  }

  const containers = dep.spec?.template?.spec?.containers ?? [];
  const idx = containers.findIndex((c) => (c as { name?: string }).name === containerName);
  if (idx < 0) return false;
  const container = containers[idx] as { volumeMounts?: Array<Record<string, unknown>> };
  const current = container.volumeMounts ?? [];

  // A mount is OURS only when it looks exactly like one we emit: the tenant
  // volume, mounted at `<sites_root>/<subPath>` with that same subPath. A
  // tenant may point an extra_mount at a path under sites_root — nothing
  // forbids it — and treating "anything below sites_root" as ours would
  // silently unmount their data on the next route change.
  const isSiteMount = (m: Record<string, unknown>) => {
    if (m.name !== 'tenant-storage') return false;
    const mp = String(m.mountPath ?? '');
    const sub = m.subPath ? String(m.subPath) : '';
    if (mp === sitesRoot && !sub) return true;              // the legacy volume-root mount
    return Boolean(sub) && mp === `${sitesRoot}/${sub}`;
  };
  const currentFolders = minimalSiteFolders(
    current.filter(isSiteMount)
      .map((m) => String(m.subPath ?? ''))
      // Compare SITE folders only: a session subPath is derived from one, so
      // counting both would never match `desired` and every reconcile would
      // rewrite the pod template and restart the pod.
      .filter((sp) => sp && !sp.startsWith(`${MULTIHOST_SESSION_ROOT}/`)),
  );
  // A legacy pod mounting the volume ROOT has one site mount with no subPath.
  // It must be replaced even when the folder list matches, because that mount
  // is the whole exposure this design removes.
  const hasVolumeRootMount = current.some((m) => isSiteMount(m) && !m.subPath);

  const same = !hasVolumeRootMount
    && currentFolders.length === desired.length
    && currentFolders.every((f: string, i: number) => f === desired[i]);
  if (same) return false;

  const kept = current.filter((m) => !isSiteMount(m));
  // Session mounts are rebuilt here too. `isSiteMount` matches them — their
  // mountPath is `<sites_root>/<subPath>` like any other — so rebuilding only
  // the site folders DROPPED them on every route change, leaving each vhost
  // pointing session.save_path at a directory no longer in the container.
  // The two lists must be emitted together, exactly as buildMultihostMounts
  // does, or the deployer and the reconciler disagree about the pod.
  const next = [
    ...kept,
    ...desired.map((folder) => ({
      name: 'tenant-storage',
      mountPath: `${sitesRoot}/${folder}`,
      subPath: folder,
    })),
    ...desired.map((folder) => ({
      name: 'tenant-storage',
      mountPath: `${sitesRoot}/${MULTIHOST_SESSION_ROOT}/${folder}`,
      subPath: `${MULTIHOST_SESSION_ROOT}/${folder}`,
    })),
  ];

  // The init container has to keep step with the mounts.
  //
  // kubelet creates a missing subPath directory as root:root 0755 and these
  // images run non-root, so a session mount added WITHOUT the matching mkdir
  // gives the site a directory it cannot write — PHP is pointed at it and every
  // session write is denied, silently. Patching volumeMounts alone produced
  // exactly that on DEV.
  const initContainers = (dep.spec?.template?.spec?.initContainers ?? []) as Array<Record<string, unknown>>;
  const initDirs = initContainers.find((c) => (c as { name?: string }).name === 'init-dirs') as
    { command?: string[] } | undefined;
  if (initDirs?.command && initDirs.command.length === 3) {
    const existing = initDirs.command[2]
      .split(' && ')
      // Drop stale session clauses so a re-run cannot accumulate them, then
      // re-add exactly the ones this folder set needs.
      .filter((part) => !isSessionDirCommand(part));
    const rebuilt = [...existing, ...sessionDirInitCommands(desired)].filter((p) => p && p !== 'true');
    initDirs.command[2] = rebuilt.length > 0 ? rebuilt.join(' && ') : 'true';
  }

  // Read-modify-WRITE rather than a patch, deliberately. A strategic merge
  // patch merges list entries by key (`mountPath` here), so it can only ever
  // ADD mounts — a folder that stopped being served would stay mounted
  // forever, which is the exact exposure this design removes. Replacing the
  // object carries `resourceVersion`, so a concurrent write loses the race
  // loudly instead of silently clobbering.
  container.volumeMounts = next;
  // Retry the read-modify-write on a lost race. There is no periodic multi-host
  // reconcile — this runs only in response to a route change — so an exception
  // swallowed by the caller's per-deployment catch would leave the mounts wrong
  // until some unrelated future route change happened to touch this deployment.
  // For a removed site that means its folder stays mounted indefinitely, which
  // is precisely the exposure this design removes.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await clients.apps.replaceNamespacedDeployment({ name: deploymentName, namespace, body: dep } as never);
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status !== 409 || attempt === 2) throw err;
      // Someone else wrote first. Re-read and re-apply onto their version.
      const fresh = await clients.apps.readNamespacedDeployment({ name: deploymentName, namespace } as never) as typeof dep;
      const freshContainers = fresh.spec?.template?.spec?.containers ?? [];
      const fi = freshContainers.findIndex((c) => (c as { name?: string }).name === containerName);
      if (fi < 0) return false;
      const fc = freshContainers[fi] as { volumeMounts?: Array<Record<string, unknown>> };
      fc.volumeMounts = [...(fc.volumeMounts ?? []).filter((m) => !isSiteMount(m)), ...next.filter(isSiteMount)];
      dep = fresh;
    }
  }
  return true;
}

/**
 * Wait for the projection, validate, reload, and report which folders are
 * missing. Separated from the ConfigMap write so the write can be awaited by a
 * request while this runs detached.
 */
async function activateSites(
  clients: MultihostClients,
  input: ReconcileDeploymentInput,
  rendered: RenderResult,
  hash: string,
): Promise<Pick<DeploymentReconcileResult, 'reloaded' | 'failures' | 'missingFolders' | 'folderCheck'>> {
  const { capability: cap, namespace, deploymentName } = input;
  const pods = await runningPods(clients.core, namespace, deploymentName, input.containerName);
  if (pods.length === 0) {
    // Scaled to zero or still starting. The ConfigMap is written, so whenever a
    // pod does come up it mounts the right config — nothing to reload.
    return { reloaded: 0, failures: [], missingFolders: [], folderCheck: 'ok' };
  }

  const probe = isMultihostFlavour(cap.server)
    ? PROJECTION_PROBES[cap.server](cap)
    : ['cat', `${cap.config_dir}/${CHECKSUM_KEY}`];
  const sleep = input.sleep ?? defaultSleep;
  const timeout = input.projectionTimeoutMs ?? 120_000;
  const failures: Array<{ pod: string; reason: string }> = [];
  let reloaded = 0;

  for (const pod of pods) {
    const projected = await waitForProjection(
      input.kubeconfigPath, namespace, pod, probe, hash, timeout, sleep,
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

  return { reloaded, failures, missingFolders: folders.missing, folderCheck: folders.check };
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
        appRoot: ingressRoutes.appRoot,
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
      appRoot: (r.appRoot as string | null) ?? null,
    }));

    try {
      const result = await reconcileDeploymentSites(clients, {
        kubeconfigPath,
        namespace,
        // Called from reconcileIngress, which every route mutation awaits.
        // Writing the ConfigMap is fast; waiting for kubelet and reloading is
        // not, and doing it here made a route PATCH time out at the gateway.
        deferActivation: true,
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
  /**
   * Application roots this pod serves. REQUIRED, and required to be accurate:
   * each one becomes its own mount, and the pod sees nothing else on the
   * volume — so a caller that passes an empty list produces a pod that can
   * serve no sites at all, not a pod that can serve everything.
   */
  siteFolders: readonly string[],
): MultihostMounts | null {
  if (!deployment.multihostEnabled) return null;
  const cap = capabilityOf(entry);
  if (!cap) return null;
  return {
    configDir: cap.config_dir,
    sitesRoot: cap.sites_root,
    configMapName: vhostConfigMapName(deployment.name),
    siteFolders,
  };
}

/**
 * The application roots a deployment currently serves.
 *
 * Read from `ingress_routes` rather than tracked on the deployment, because
 * the routes ARE the source of truth for what a pod serves — anything else is
 * a copy that can drift, and here a drifted copy means either a site that
 * 404s or a folder mounted for no reason.
 */
export async function loadSiteFoldersFor(db: Db, deploymentId: string): Promise<string[]> {
  const rows = await db
    .select({ appRoot: ingressRoutes.appRoot, siteFolder: ingressRoutes.siteFolder })
    .from(ingressRoutes)
    .where(and(eq(ingressRoutes.deploymentId, deploymentId), isNotNull(ingressRoutes.siteFolder)));
  // `appRoot` is backfilled for every row that has a folder, but fall back to
  // the folder itself so a row written before migration 0105 still mounts.
  return rows
    .map((r: { appRoot: string | null; siteFolder: string | null }) =>
      r.appRoot ?? r.siteFolder)
    .filter((f: string | null): f is string => typeof f === 'string' && f.length > 0);
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
  // Only the ConfigMap is removed here, so this deliberately asks for less
  // than a full reconcile does.
  clients: Pick<MultihostClients, 'core'>,
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
