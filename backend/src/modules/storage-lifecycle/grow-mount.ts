/**
 * The second half of growing a volume: something has to mount it.
 *
 * A grow has two halves. Longhorn extends the block device, and the kubelet
 * grows the filesystem on it — on the node where the volume is mounted, so
 * only while a pod uses the claim. (A volume nothing has attached is extended
 * offline, filesystem and all, and never gets here.)
 *
 * The usual way to lose the mount in the middle: a change of a tenant's limit
 * re-provisions its namespace, which starts the file manager — and the idle
 * clean-up scales it away again within half a minute, having seen no access.
 * A tenant with no workload running then has a volume that was attached when
 * the grow began and is mounted by nothing: its claim reads
 * `FileSystemResizePending` and keeps its old capacity until a pod comes. The
 * grow used to wait ten minutes for that and fail, with the claim already
 * asking for the new size.
 *
 * The tenant's file manager mounts the volume and is the platform's to start,
 * so the grow holds it (file-manager/lease.ts) for as long as the filesystem
 * takes and hands it back after.
 *
 * Where nothing can mount the volume now, the filesystem grows when the
 * tenant's next pod starts — the kubelet does it on that mount — and the grow
 * ends saying so, instead of failing on a volume that has in fact been
 * extended. "Nothing can" is not concluded from one error: a tenant whose
 * workloads a storage operation or a suspension stopped has a file manager
 * that must stay stopped, and that is read from the cluster; anything else —
 * a cluster that did not answer, a file manager slow to start — is tried
 * again on the next polls first, and its reason is kept for the operator.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { parseK8sQuantity } from '../../shared/k8s-quantity.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import type { FileManagerLease } from '../file-manager/lease.js';

/** `coming`: a pod mounts the claim, or one is being brought. `none`: nothing can mount it now. */
export type GrowMount = 'coming' | 'none';

/** How often bringing a mount is tried before the grow concludes that nothing can mount the volume. */
export const MOUNT_TRIES = 3;

/** How a grow ended: the filesystem at its new size, or the block device only. */
export type GrowOutcome = 'grown' | 'at-next-mount';

export interface GrowMountHolder {
  /** See to it that a pod mounts the claim. Asked again on every poll, so it must be cheap once settled. */
  ensure(): Promise<GrowMount>;
  /** Why nothing could mount the claim, once `ensure` has answered `none`. */
  whyNone(): string | null;
  /** Hand back whatever was started. Idempotent; never throws. */
  release(): Promise<void>;
}

export interface GrowMountDeps {
  readonly acquireLease: (k8s: K8sClients, namespace: string, purpose: string) => Promise<FileManagerLease>;
}

const FM_NAME = 'file-manager';

/**
 * Whether the tenant's file manager is stopped on purpose: it carries the hold
 * a storage operation's quiesce — a suspension's too — puts on every
 * Deployment that uses the volume, and is not to be started over it.
 */
async function fileManagerIsStopped(k8s: K8sClients, namespace: string): Promise<boolean> {
  try {
    const d = await k8s.apps.readNamespacedDeployment({ name: FM_NAME, namespace }) as { metadata?: { annotations?: Record<string, string> } };
    return d.metadata?.annotations?.[STORAGE_QUIESCED_ANNOTATION] === 'true';
  } catch (err) {
    const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } };
    // No file manager yet: the lease makes one.
    if (e?.code === 404 || e?.statusCode === 404 || e?.response?.statusCode === 404) return false;
    throw err;
  }
}

interface PodLike {
  readonly metadata?: { readonly deletionTimestamp?: unknown; readonly labels?: Record<string, string> };
  readonly spec?: { readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: { readonly claimName?: string } }> };
  readonly status?: { readonly phase?: string };
}

/**
 * The running pods that use the claim. A pod that is still starting, or on its
 * way out, does not count: neither says the volume is mounted, and the kubelet
 * grows the filesystem on a mount.
 */
export function podsMounting<P extends PodLike>(pods: readonly P[], pvcName: string): P[] {
  return pods.filter((p) => p.status?.phase === 'Running'
    && !p.metadata?.deletionTimestamp
    && (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvcName));
}

export function claimIsMountedBy(pods: readonly PodLike[], pvcName: string): boolean {
  return podsMounting(pods, pvcName).length > 0;
}

async function defaultDeps(): Promise<GrowMountDeps> {
  const { acquireFileManagerLease } = await import('../file-manager/lease.js');
  return { acquireLease: acquireFileManagerLease };
}

export function growMount(k8s: K8sClients, namespace: string, pvcName: string, deps?: GrowMountDeps): GrowMountHolder {
  let lease: FileManagerLease | null = null;
  let why: string | null = null;
  let tries = 0;
  return {
    ensure: async () => {
      if (lease) return 'coming';
      if (why) return 'none';
      try {
        const pods = await k8s.core.listNamespacedPod({ namespace }) as { items?: PodLike[] };
        // A workload's pod stays where it is. The file manager does not: seen
        // idle, it is scaled away by the clean-up in the middle of the grow —
        // so when it is the only thing mounting the volume it is held too.
        if (podsMounting(pods.items ?? [], pvcName).some((p) => p.metadata?.labels?.app !== FM_NAME)) return 'coming';
        if (await fileManagerIsStopped(k8s, namespace)) {
          why = 'its workloads are stopped';
          return 'none';
        }
        lease = await (deps ?? await defaultDeps()).acquireLease(k8s, namespace, 'storage-grow');
        return 'coming';
      } catch (err) {
        tries += 1;
        // Asked again on the next poll: one failure is not "nothing can".
        if (tries < MOUNT_TRIES) return 'coming';
        why = `its file manager could not be started: ${err instanceof Error ? err.message : String(err)}`;
        return 'none';
      }
    },
    whyNone: () => why,
    release: async () => {
      const held = lease;
      lease = null;
      await held?.release();
    },
  };
}

export interface GrowWaitOptions {
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
  /** Asked while the claim waits for a mount. Without it the wait is for the capacity alone. */
  readonly mount?: Pick<GrowMountHolder, 'ensure'>;
}

interface ClaimLike {
  readonly status?: {
    readonly capacity?: { readonly storage?: string };
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
  };
}

/**
 * Wait until the claim reports the new size — the block device extended and
 * the filesystem grown, which the claim's capacity only shows once both are
 * done. Returns `at-next-mount` when the device is extended and nothing can
 * mount the volume now. Throws FS_RESIZE_TIMEOUT when the wait runs out.
 */
export async function waitForGrownClaim(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
  targetBytes: number,
  opts: GrowWaitOptions,
): Promise<GrowOutcome> {
  const start = Date.now();
  for (;;) {
    let pvc: ClaimLike;
    try {
      pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace }) as ClaimLike;
    } catch (err) {
      throw new ApiError('LONGHORN_BUSY', `Could not read PVC ${pvcName}: ${(err as Error).message}`, 502);
    }
    const cap = pvc.status?.capacity?.storage;
    const capBytes = cap ? parseK8sQuantity(cap) : null;
    if (capBytes !== null && capBytes >= targetBytes) return 'grown';
    // Set by the resizer once the block device is extended: all that is left
    // is the filesystem, and that needs a mount.
    const awaitsMount = (pvc.status?.conditions ?? []).some((c) => c.type === 'FileSystemResizePending' && c.status === 'True');
    if (awaitsMount && opts.mount && (await opts.mount.ensure()) === 'none') return 'at-next-mount';
    if (capBytes !== null && opts.onProgress) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      const gib = (bytes: number): string => (bytes / (1024 ** 3)).toFixed(2);
      await opts.onProgress(awaitsMount
        ? `Volume extended — growing its filesystem to ${gib(targetBytes)} GiB (${elapsed}s)`
        : `Extending volume — ${gib(capBytes)} / ${gib(targetBytes)} GiB after ${elapsed}s`);
    }
    if (Date.now() - start > opts.timeoutMs) {
      throw new ApiError(
        'FS_RESIZE_TIMEOUT',
        awaitsMount
          ? `The volume behind PVC ${pvcName} was extended, but its filesystem did not grow within ${opts.timeoutMs}ms although a pod mounts it. Check the kubelet log on that pod's node for the resize.`
          : `PVC ${pvcName}.status.capacity.storage did not reach ${targetBytes} bytes within ${opts.timeoutMs}ms (last seen: ${cap ?? 'none'}). Longhorn volume may be busy or insufficient host capacity.`,
        504,
      );
    }
    await new Promise((r) => { setTimeout(r, opts.pollMs ?? 2000); });
  }
}
