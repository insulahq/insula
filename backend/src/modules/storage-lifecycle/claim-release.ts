/**
 * Deleting a tenant's storage claim, and waiting until it is gone.
 *
 * Kubernetes keeps a claim that is being deleted for as long as a pod that has
 * been given a node names it — a finished pod too: claim protection does not
 * look at the pod's phase. A finished Job keeps its pod until the Job's TTL,
 * ten minutes for a bundle capture (`bk-files-*`, tenant-bundles/components/
 * files.ts). A claim deleted within ten minutes of a backup of the tenant —
 * the nightly one, one taken by hand — therefore stayed "terminating" that
 * long:
 *
 *   - the archive's volume clean-up gave up after its 45 s and left the volume;
 *   - a restore started in the meantime wrote the archive into the dying claim,
 *     the claim went when the backup's pod did, and the tenant was reactivated
 *     onto a new, empty volume (measured on lab staging);
 *   - a destructive resize gave up after 60 s.
 *
 * A finished pod holds nothing anyone needs — its Job keeps its status — so it
 * is removed. A pod that has not finished is reported, never touched.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface PodShape {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly volumes?: ReadonlyArray<{ readonly persistentVolumeClaim?: { readonly claimName?: string } }>;
  };
  readonly status?: { readonly phase?: string };
}

const FINISHED_PHASES: ReadonlySet<string> = new Set(['Succeeded', 'Failed']);

/** How long a delete waits for the claim to be gone. */
export const CLAIM_RELEASE_TIMEOUT_MS = 120_000;

function statusOf(err: unknown): number | undefined {
  return (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
}

export interface ClaimHolders {
  /** Finished pods that name the claim: they hold it, and may be removed. */
  readonly finished: readonly string[];
  /** Pods that name it and have not finished — running, starting, or not yet placed. */
  readonly live: readonly string[];
}

/** The pods in `namespace` that name `claimName`. Reads only. */
export async function claimHolders(k8s: K8sClients, namespace: string, claimName: string): Promise<ClaimHolders> {
  const list = await k8s.core.listNamespacedPod({ namespace }) as { items?: readonly PodShape[] };
  const naming = (list.items ?? []).filter((p) =>
    (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === claimName));
  const nameOf = (p: PodShape): string => p.metadata?.name ?? '(unnamed pod)';
  return {
    finished: naming.filter((p) => FINISHED_PHASES.has(p.status?.phase ?? '')).map(nameOf),
    live: naming.filter((p) => !FINISHED_PHASES.has(p.status?.phase ?? '')).map(nameOf),
  };
}

/** Remove the finished pods that name the claim. Returns the pods that have not finished. */
export async function removeFinishedHolders(k8s: K8sClients, namespace: string, claimName: string): Promise<readonly string[]> {
  const { finished, live } = await claimHolders(k8s, namespace, claimName);
  for (const name of finished) {
    try {
      await k8s.core.deleteNamespacedPod({ name, namespace });
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
  return live;
}

/** 'gone', 'deleting', or 'there' — a claim that is not being deleted. */
async function claimState(k8s: K8sClients, namespace: string, claimName: string): Promise<'gone' | 'deleting' | 'there'> {
  try {
    const claim = await k8s.core.readNamespacedPersistentVolumeClaim({ name: claimName, namespace }) as {
      metadata?: { deletionTimestamp?: Date | string };
    };
    return claim.metadata?.deletionTimestamp ? 'deleting' : 'there';
  } catch (err) {
    if (statusOf(err) === 404) return 'gone';
    throw err;
  }
}

async function deleteClaim(k8s: K8sClients, namespace: string, claimName: string): Promise<void> {
  try {
    await k8s.core.deleteNamespacedPersistentVolumeClaim({ name: claimName, namespace });
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
}

/** Is the claim there and being deleted? */
export async function claimBeingDeleted(k8s: K8sClients, namespace: string, claimName: string): Promise<boolean> {
  return (await claimState(k8s, namespace, claimName)) === 'deleting';
}

export interface ClaimRelease {
  readonly gone: boolean;
  /** When not gone: the pods that still use the claim. */
  readonly live: readonly string[];
}

export interface ClaimReleaseTiming {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Delete the claim when it is there, and wait until it is gone — removing the
 * finished pods that hold it first, and again as Jobs finish meanwhile. A
 * claim of that name made again while it waits (the namespace sweep repairing
 * a "missing" volume) is deleted too: every caller wants none.
 * `gone: false` once `timeoutMs` has passed, with the pods still using it.
 */
export async function deleteClaimAndWait(
  k8s: K8sClients,
  namespace: string,
  claimName: string,
  timing: ClaimReleaseTiming = {},
): Promise<ClaimRelease> {
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? realSleep;
  const deadline = now() + (timing.timeoutMs ?? CLAIM_RELEASE_TIMEOUT_MS);
  await removeFinishedHolders(k8s, namespace, claimName);
  await deleteClaim(k8s, namespace, claimName);
  for (;;) {
    const state = await claimState(k8s, namespace, claimName);
    if (state === 'gone') return { gone: true, live: [] };
    if (state === 'there') await deleteClaim(k8s, namespace, claimName);
    const live = await removeFinishedHolders(k8s, namespace, claimName);
    if (now() >= deadline) return { gone: false, live };
    await sleep(timing.pollMs ?? 2_000);
  }
}

/** "pod a, pod b" — or what holds the claim when no pod does. */
export function describeHolders(live: readonly string[]): string {
  return live.length > 0
    ? `still used by ${live.join(', ')}`
    : 'still held, though no pod in the namespace uses it';
}
