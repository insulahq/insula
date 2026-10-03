/**
 * A platform-internal use of a tenant's file manager.
 *
 * The file manager is an on-demand pod: something scales it to 1, and the idle
 * loop (idle-cleanup.ts) scales it back to 0 ten minutes after the last recorded
 * access. Platform code that execs into it — the nightly bundle's SQLite dump
 * and predump cleanup, a database restore, a SQL Manager import — recorded no
 * access. So every night, for every tenant, the bundle scaled up a file manager
 * that had been idle for days, the next idle tick scaled it straight back down
 * (often mid-exec), and the predump cleanup scaled it up again.
 *
 * A lease fixes both halves:
 *  - while it is held, a `fm-lease.insula.host/<purpose>-<id>` annotation (an
 *    expiry, renewed in the background) tells the idle loop on every
 *    platform-api replica to leave the file manager alone. It is written BEFORE
 *    the replica count is read or changed, so there is no moment at which an
 *    idle file manager is at 1 replica without a hold;
 *  - on release it hands the file manager back the way it found it: if this
 *    lease scaled it up, it scales it down again — unless another lease still
 *    holds it, a storage operation owns its replica count, or someone used it
 *    meanwhile (then the idle loop decides, as after any use).
 * A holder that dies stops renewing; its hold lapses after LEASE_TTL_MS and the
 * idle loop takes over.
 *
 * What a lease does NOT outrank, by design:
 *  - a storage operation's quiesce (resize, snapshot restore, fsck). It must
 *    scale every consumer of the tenant volume to 0 to detach it; making it
 *    wait for a lease could stall it for the length of a backup. The lease
 *    then yields: hand-back never touches a quiesced file manager's replicas.
 *  - a spec-drift recreate in ensureFileManagerRunning (image bump, tier
 *    change), which replaces the pod. Those arrive with a platform-api roll,
 *    which ends any in-flight holder anyway.
 * An exec cut short by either fails, and every holder treats that as
 * best-effort or as a failure of its own step — never as a reason to retry.
 */
import { randomBytes } from 'node:crypto';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import { cachedFileManagerAccess } from './idle-cleanup.js';
import { FM_LEASE_PREFIX, LAST_ACCESS_ANNOTATION, hasLiveLease } from './lease-annotations.js';

const FM_NAME = 'file-manager';
/** How long a hold outlives its last renewal. */
export const LEASE_TTL_MS = 15 * 60_000;
const LEASE_RENEW_MS = 5 * 60_000;

export interface FileManagerLease {
  /** The ready pod at acquire time. */
  readonly podName: string;
  /** The ready pod now — it can be replaced while the lease is held. */
  currentPod(): Promise<string>;
  /** Hand the file manager back. Idempotent; never throws. */
  release(): Promise<void>;
}

export interface LeaseDeps {
  /** Scale up if needed and wait for a ready pod; returns its name. */
  readonly startPod: (k8s: K8sClients, namespace: string) => Promise<string>;
  readonly scaleToZero: (namespace: string) => Promise<void>;
  readonly now: () => number;
  readonly renewEveryMs: number;
}

interface DeploymentLite {
  readonly metadata?: { readonly annotations?: Record<string, string> };
  readonly spec?: { readonly replicas?: number };
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
  return e?.code === 404 || e?.statusCode === 404 || e?.response?.statusCode === 404;
}

async function readDeployment(k8s: K8sClients, namespace: string): Promise<DeploymentLite | null> {
  try {
    return await k8s.apps.readNamespacedDeployment({ name: FM_NAME, namespace }) as DeploymentLite;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Set (value) or remove (null) one annotation. False when there is no Deployment yet. */
async function patchAnnotation(k8s: K8sClients, namespace: string, key: string, value: string | null): Promise<boolean> {
  try {
    await k8s.apps.patchNamespacedDeployment({
      name: FM_NAME,
      namespace,
      body: { metadata: { annotations: { [key]: value } } },
    } as unknown as Parameters<K8sClients['apps']['patchNamespacedDeployment']>[0], STRATEGIC_MERGE_PATCH);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function defaultDeps(): Promise<LeaseDeps> {
  const { getReadyFileManagerPod } = await import('./service.js');
  const { scaleDeploymentReplicas } = await import('../../shared/scale-deployment.js');
  return {
    startPod: (k8s, namespace) => getReadyFileManagerPod(k8s, namespace),
    scaleToZero: (namespace) => scaleDeploymentReplicas(namespace, FM_NAME, 0),
    now: Date.now,
    renewEveryMs: LEASE_RENEW_MS,
  };
}

/**
 * Remove the hold; scale back to 0 when this lease started the file manager and
 * nothing else has a claim on it. Never throws — a failed hand-back leaves the
 * file manager to the idle loop, which is where it would have been anyway.
 */
async function handBack(
  k8s: K8sClients,
  namespace: string,
  key: string,
  startedIt: boolean,
  acquiredAt: number,
  deps: LeaseDeps,
): Promise<void> {
  try {
    await patchAnnotation(k8s, namespace, key, null);
    if (!startedIt) return;
    const d = await readDeployment(k8s, namespace);
    if (!d || (d.spec?.replicas ?? 0) === 0) return;
    const ann = d.metadata?.annotations ?? {};
    if (ann[STORAGE_QUIESCED_ANNOTATION] === 'true') return;
    if (hasLiveLease(ann, deps.now())) return;
    const accessed = Math.max(Number(ann[LAST_ACCESS_ANNOTATION]) || 0, cachedFileManagerAccess(namespace));
    if (accessed > acquiredAt) return;
    await deps.scaleToZero(namespace);
  } catch (err) {
    console.warn(`[file-manager] lease hand-back in ${namespace} failed; the idle loop will scale it down: ${(err as Error).message}`);
  }
}

/**
 * The annotation key's name part: `<purpose>-<8 hex>`. Kubernetes requires it to
 * start and end alphanumeric and stay within 63 characters, and the first hold
 * write is what acquires the lease — a rejected key would fail it. Pure.
 */
export function leaseName(purpose: string): string {
  const clean = purpose.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    .replace(/-+$/, '');
  return `${clean || 'lease'}-${randomBytes(4).toString('hex')}`;
}

/**
 * Hold the tenant's file manager for a platform-internal use and return a ready
 * pod. `purpose` names the holder in the annotation key ([a-z0-9-]).
 * Throws when the file manager cannot be started — after handing it back.
 */
export async function acquireFileManagerLease(
  k8s: K8sClients,
  namespace: string,
  purpose: string,
  deps?: LeaseDeps,
): Promise<FileManagerLease> {
  const d = deps ?? await defaultDeps();
  const key = `${FM_LEASE_PREFIX}${leaseName(purpose)}`;
  const acquiredAt = d.now();
  const hold = (): Promise<boolean> => patchAnnotation(k8s, namespace, key, String(d.now() + LEASE_TTL_MS));

  await hold();
  const before = await readDeployment(k8s, namespace);
  const startedIt = !before || (before.spec?.replicas ?? 0) === 0;

  let podName: string;
  try {
    podName = await d.startPod(k8s, namespace);
  } catch (err) {
    await handBack(k8s, namespace, key, startedIt, acquiredAt, d);
    throw err;
  }
  // Starting may have CREATED the Deployment (or recreated it on a spec
  // change), which leaves it without the hold — put it (back) on.
  await hold().catch(() => false);

  const timer = setInterval(() => {
    hold().catch((err: unknown) => {
      console.warn(`[file-manager] lease renewal in ${namespace} failed: ${(err as Error).message}`);
    });
  }, d.renewEveryMs);
  timer.unref?.();

  let released = false;
  return {
    podName,
    currentPod: () => d.startPod(k8s, namespace),
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      await handBack(k8s, namespace, key, startedIt, acquiredAt, d);
    },
  };
}

/** Run `fn` with a held file manager; always hands it back. */
export async function withFileManagerLease<T>(
  k8s: K8sClients,
  namespace: string,
  purpose: string,
  fn: (podName: string) => Promise<T>,
): Promise<T> {
  const lease = await acquireFileManagerLease(k8s, namespace, purpose);
  try {
    return await fn(lease.podName);
  } finally {
    await lease.release();
  }
}
