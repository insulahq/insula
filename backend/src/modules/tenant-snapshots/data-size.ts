/**
 * Real data size of tenant volume snapshots.
 *
 * The size a tenant snapshot row has always carried is the VolumeSnapshot's
 * `restoreSize` — the PROVISIONED size of the volume (a 5 GiB PVC reads
 * 5 GiB whether it holds 5 GiB or 50 MiB). What a snapshot actually occupies
 * lives on the Longhorn `snapshots.longhorn.io` CR behind it, as
 * `status.size`: the bytes written to the volume since the previous snapshot
 * (the first snapshot of a volume holds everything written so far).
 *
 * Getting there from a row costs a VolumeSnapshot → VolumeSnapshotContent →
 * `snapshotHandle` hop. That hop runs ONCE per snapshot (when it turns ready;
 * see `resolveLonghornNames`) and the names are stored on the row, so a list
 * request reads every size with ONE label-selected Longhorn list.
 *
 * Unknown stays unknown: a size that is absent or unparseable is `null`, never
 * 0 — a measured 0 (nothing changed since the previous snapshot) is real.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { LH_GROUP, LH_NS, LH_VERSION, parseSnapshotHandle } from '../storage-lifecycle/longhorn-revert.js';

interface LonghornSnapshotLive {
  readonly metadata?: { readonly name?: string };
  readonly status?: { readonly size?: string | number; readonly markRemoved?: boolean };
}

/**
 * Longhorn reports `status.size` as an integer byte count (a JSON number on
 * v1.12; a digit string on some versions). Anything else is `null`.
 */
export function parseLonghornSnapshotSize(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Past this many volumes a set-based selector gets unwieldy (it travels in
 *  the URL); one unfiltered list of the namespace is still ONE call. */
export const MAX_SELECTOR_VOLUMES = 40;

/**
 * The label selector for one list of the given volumes' snapshots:
 *   - `null`      nothing to list (no usable volume names) — skip the call
 *   - `undefined` too many volumes for a selector — list the whole namespace
 *   - a string    `longhornvolume in (a,b,…)`
 * Volume names are PV names (`pvc-<uuid>`); anything that is not a plain
 * DNS-1123 name is dropped rather than spliced into a selector.
 */
export function longhornVolumeSelector(volumeNames: ReadonlyArray<string>): string | null | undefined {
  const safe = [...new Set(volumeNames)].filter((v) => /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(v)).sort();
  if (safe.length === 0) return null;
  if (safe.length > MAX_SELECTOR_VOLUMES) return undefined;
  return `longhornvolume in (${safe.join(',')})`;
}

/**
 * ONE list of the Longhorn snapshots of the given volumes → name → bytes.
 * A snapshot whose CR is missing from the result is simply absent from the
 * map (the caller reads that as "unknown"). Throws on a k8s error so the
 * caller can log it once and fall back to "unknown" for every row.
 */
export async function readLonghornSnapshotSizes(
  k8s: K8sClients,
  volumeNames: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, number | null>> {
  const labelSelector = longhornVolumeSelector(volumeNames);
  if (labelSelector === null) return new Map();
  const resp = await (k8s.custom as unknown as {
    listNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string; labelSelector?: string;
    }) => Promise<{ items?: ReadonlyArray<LonghornSnapshotLive> }>;
  }).listNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    ...(labelSelector ? { labelSelector } : {}),
  });
  const sizes = new Map<string, number | null>();
  for (const item of resp.items ?? []) {
    const name = item.metadata?.name;
    if (!name) continue;
    sizes.set(name, parseLonghornSnapshotSize(item.status?.size));
  }
  return sizes;
}

/**
 * Resolve the Longhorn volume + snapshot behind a bound VolumeSnapshotContent
 * (`status.snapshotHandle` = `snap://<volume>/<snapshot>`). Returns null when
 * the content has no handle yet or the handle is not a Longhorn one.
 */
export async function resolveLonghornNames(
  k8s: K8sClients,
  contentName: string,
): Promise<{ readonly volumeName: string; readonly snapshotName: string } | null> {
  const content = await (k8s.custom as unknown as {
    getClusterCustomObject: (a: { group: string; version: string; plural: string; name: string }) =>
      Promise<{ status?: { snapshotHandle?: string } }>;
  }).getClusterCustomObject({
    group: 'snapshot.storage.k8s.io', version: 'v1', plural: 'volumesnapshotcontents', name: contentName,
  });
  const handle = content.status?.snapshotHandle;
  // Only an in-cluster `type=snap` handle names a snapshots.longhorn.io CR.
  if (!handle || !handle.startsWith('snap://')) return null;
  try {
    return parseSnapshotHandle(handle);
  } catch {
    return null;
  }
}
