/**
 * Whether every platform API process is this release.
 *
 * An upgrade runs two releases side by side for a few minutes. Work that an
 * older release began and marks no differently from work nobody is doing — it
 * wrote no liveness lock — may still be in the hands of one of its processes.
 * Whoever wants to pick such work up asks here first, and does so only once
 * the older release is gone.
 */
import { hostname } from 'node:os';
import type { K8sClients } from '../modules/k8s-provisioner/k8s-client.js';

interface PodLike {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly containers?: ReadonlyArray<{ readonly image?: string }> };
  readonly status?: { readonly phase?: string };
}

/**
 * Whether every API process that exists is this release: true, false, or null
 * when that cannot be told — this process is not one of the listed pods (a
 * local run), or the list could not be read. Only `true` licenses anything.
 *
 * A pod on its way out still counts while it is listed: it may be finishing an
 * operation. One that has ended (Succeeded, Failed) runs nothing.
 */
export function everyPodRunsTheSameRelease(pods: readonly PodLike[], self: string): boolean | null {
  const image = (p: PodLike): string | null => p.spec?.containers?.[0]?.image ?? null;
  const live = pods.filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed');
  const mine = image(live.find((p) => p.metadata?.name === self) ?? {});
  if (!mine) return null;
  return live.every((p) => image(p) === mine);
}

export async function everyApiProcessIsThisRelease(k8s: K8sClients, namespace: string, self: string = hostname()): Promise<boolean | null> {
  try {
    const list = await (k8s.core as unknown as {
      listNamespacedPod: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: PodLike[] }>;
    }).listNamespacedPod({ namespace, labelSelector: 'app=platform-api' });
    return everyPodRunsTheSameRelease(list.items ?? [], self);
  } catch {
    return null;
  }
}
