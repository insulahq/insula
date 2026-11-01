/**
 * Where a tenant's Longhorn volumes may keep their data — the volume half of a
 * tenant's pin.
 *
 * A re-pin by a drain or an outage (nodes/service.ts `repinTenantPlacement`)
 * tags the target's Longhorn node `node-<name>` and sets every volume's
 * `spec.nodeSelector` to that tag, so Longhorn keeps the data there. A MOVE
 * (Placement card, bulk Change placement) re-pinned the Deployments only and
 * left that selector behind. Longhorn then had two rules for the copy data
 * locality builds on the new node — `hardNodeAffinity` the new node,
 * `nodeSelector` the old one's tag — that no node meets, and the copy never
 * started (`Scheduled=False LocalReplicaSchedulingFailure: replica scheduling
 * failed`). Seen on production: two tenants drained onto one server and later
 * moved to another ran on the new one with every block still on the old one.
 *
 * Every path that re-pins a tenant now points its volumes at the same node.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { LH, lhList, type LhList } from './relocate.js';

/** The tag a Longhorn node carries while tenants are pinned to it. */
export const HOST_TAG_PREFIX = 'node-';

export function hostTagOf(node: string): string {
  return `${HOST_TAG_PREFIX}${node}`;
}

/**
 * Build the memoised Longhorn host-tag ensurer.
 *
 * Adding the per-host tag to a target Longhorn Node CR must happen exactly
 * once per target even when several tenants move to the same node, so the
 * memo lives in the closure and is shared across one re-pin batch.
 */
export function makeLonghornHostTagEnsurer(k8s: K8sClients): (target: string) => Promise<string> {
  const tagged = new Set<string>();
  return async (target: string): Promise<string> => {
    const hostTag = hostTagOf(target);
    if (tagged.has(target)) return hostTag;
    const existing = await k8s.custom.getNamespacedCustomObject({
      ...LH, plural: 'nodes', name: target,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { spec?: { tags?: string[] } };
    const currentTags = existing.spec?.tags ?? [];
    if (!currentTags.includes(hostTag)) {
      await k8s.custom.patchNamespacedCustomObject({
        ...LH, plural: 'nodes', name: target,
        body: { spec: { tags: [...currentTags, hostTag] } },
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
        MERGE_PATCH);
    }
    tagged.add(target);
    return hostTag;
  };
}

interface LhVolumeRaw {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly numberOfReplicas?: number; readonly nodeSelector?: readonly string[] | null };
  readonly status?: { readonly kubernetesStatus?: { readonly namespace?: string; readonly lastPVCRefAt?: string } };
}

/** A volume a hold changed, with the selector it had before. */
export interface HeldVolume {
  readonly volumeName: string;
  readonly previous: readonly string[];
}

/** What a hold changed, so a failed re-pin can put it back. */
export interface VolumeHold {
  readonly target: string;
  readonly changed: readonly HeldVolume[];
}

/**
 * The volumes whose selector has to change to hold them to `hostTag`, with the
 * selector each has now. Pure. Only live single-replica volumes of the
 * namespace: the ones a move brings along (the same selection as
 * `planRelocation`). An HA volume keeps replicas on several nodes by design,
 * and one tag would fence them all onto one.
 */
export function volumesToPoint(
  volumes: LhList<LhVolumeRaw>,
  namespace: string,
  hostTag: string,
  storageTier: string | null,
): HeldVolume[] {
  if (storageTier === 'ha') return [];
  return (volumes.items ?? [])
    .filter((v) => v.status?.kubernetesStatus?.namespace === namespace && !v.status?.kubernetesStatus?.lastPVCRefAt)
    .filter((v) => (v.spec?.numberOfReplicas ?? 1) <= 1)
    .flatMap((v) => {
      const volumeName = v.metadata?.name;
      const previous = v.spec?.nodeSelector ?? [];
      if (!volumeName || (previous.length === 1 && previous[0] === hostTag)) return [];
      return [{ volumeName, previous }];
    });
}

function setSelector(k8s: K8sClients, name: string, nodeSelector: readonly string[]): Promise<unknown> {
  return k8s.custom.patchNamespacedCustomObject({
    ...LH, plural: 'volumes', name,
    body: { spec: { nodeSelector } },
  } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Put back the selectors a hold changed. Never throws: returns one line per
 * volume it could not put back, empty when all went back.
 */
export async function releaseVolumeHold(k8s: K8sClients, hold: VolumeHold): Promise<string[]> {
  const left: string[] = [];
  for (const v of hold.changed) {
    await setSelector(k8s, v.volumeName, v.previous).catch((err: unknown) => {
      left.push(`${v.volumeName}: ${errText(err)}`);
    });
  }
  return left;
}

/**
 * Hold the tenant's volumes to `target`, as a drain's re-pin does: tag the
 * target's Longhorn node and set each volume's `nodeSelector` to that tag.
 * Returns what it changed, so a re-pin that fails after it can put it back.
 *
 * Throws when a volume cannot be held — the caller is re-pinning, and a pin
 * whose data cannot follow is the failure this exists to prevent — after
 * putting back the volumes it had already changed, so a failed hold leaves
 * nothing half held.
 */
export async function holdTenantVolumes(
  k8s: K8sClients,
  namespace: string,
  target: string,
  storageTier: string | null,
  ensureHostTag: (target: string) => Promise<string> = makeLonghornHostTagEnsurer(k8s),
): Promise<VolumeHold> {
  const pending = volumesToPoint(await lhList<LhVolumeRaw>(k8s, 'volumes'), namespace, hostTagOf(target), storageTier);
  if (pending.length === 0) return { target, changed: [] };
  const hostTag = await ensureHostTag(target);
  const changed: HeldVolume[] = [];
  for (const v of pending) {
    try {
      await setSelector(k8s, v.volumeName, [hostTag]);
      changed.push(v);
    } catch (err) {
      const left = await releaseVolumeHold(k8s, { target, changed });
      throw new Error(`could not hold volume ${v.volumeName} to ${target}: ${errText(err)}`
        + (left.length > 0 ? `; and could not put back ${left.join('; ')}` : ''));
    }
  }
  return { target, changed };
}
