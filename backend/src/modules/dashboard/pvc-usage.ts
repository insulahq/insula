/**
 * "How full is this volume, really?" — for the dashboard's volume alert.
 *
 * The alert used to divide Longhorn's `status.actualSize` by `spec.size`, and
 * on production that reported the platform database at 93 % of a volume whose
 * filesystem was 36 % used. The two numbers measure different things:
 *
 *   `actualSize` is the disk the replica occupies on the host, INCLUDING every
 *   snapshot in the chain. Postgres recycles WAL segments by overwriting the
 *   same blocks, so each hourly snapshot pins another copy of them; six
 *   retained snapshots of a 124 MB database had 1.8 GiB of chain behind a
 *   702 MiB filesystem. Nothing was close to full, and nothing was wrong —
 *   `actualSize` was answering "what does this cost on the host", correctly.
 *
 *   The filesystem's used/capacity is what decides whether the workload can
 *   still write, and it is the number `df` shows inside the pod.
 *
 * So the alert reads the second one, per PVC, from the kubelet. As a side
 * effect it also covers PVCs Longhorn never sees — `local-path` and any other
 * CSI driver — which the old reader could not alert on at all.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  computePvcFillFraction,
  pvcStatsKey,
  readPvcVolumeStats,
  type PvcFsStats,
} from '../node-health/kubelet-disk.js';

/** One volume's occupancy, ready to be ranked and rendered. */
export interface PvcUsage {
  readonly namespace: string;
  readonly pvcName: string;
  readonly usedBytes: number;
  readonly capacityBytes: number;
  /** 0–1, the worse of byte-fill and inode-fill. */
  readonly fraction: number;
}

/**
 * A volume whose filesystem is much larger than the size it asked for is not
 * a volume with its own filesystem — it is a directory on a shared one, which
 * is how `local-path` and other hostPath-style provisioners work. Its fill
 * percentage is the NODE's, already alerted by node-health, and reporting it
 * per volume would fan one disk-pressure event out into an alarm per PVC on
 * that node.
 *
 * Real volumes come back slightly SMALLER than requested — 2 GiB of Longhorn
 * presents as 1945 MiB of ext4 once the filesystem takes its overhead — so
 * any capacity above the request at all is the signal. The margin is only
 * there to absorb rounding.
 */
const SHARED_FS_MARGIN = 1.05;

export type PvcUsageReader = (k8s: K8sClients) => Promise<readonly PvcUsage[]>;

const parseQuantity = (q: string | undefined): number | null => {
  if (!q) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]i?)?$/.exec(q.trim());
  if (!m) return null;
  const scale: Record<string, number> = {
    K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 1024, Mi: 1048576, Gi: 1073741824, Ti: 1099511627776, Pi: 1125899906842624,
  };
  return Number(m[1]) * (m[2] ? scale[m[2]] ?? 1 : 1);
};

/** namespace/name → the size the PVC asked for, for the shared-filesystem test. */
async function readPvcRequests(k8s: K8sClients): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const res = await k8s.core.listPersistentVolumeClaimForAllNamespaces();
  for (const pvc of res.items ?? []) {
    const ns = pvc.metadata?.namespace;
    const name = pvc.metadata?.name;
    const req = parseQuantity(pvc.spec?.resources?.requests?.storage);
    if (ns && name && req !== null) out.set(pvcStatsKey(ns, name), req);
  }
  return out;
}

/**
 * Join kubelet filesystem stats with PVC requests, dropping volumes that live
 * on a shared filesystem.
 *
 * Exported for tests — the cluster round-trip stays in `readPvcUsage`.
 */
export function joinPvcUsage(
  stats: ReadonlyMap<string, PvcFsStats>,
  requests: ReadonlyMap<string, number>,
): readonly PvcUsage[] {
  const out: PvcUsage[] = [];
  for (const [key, s] of stats) {
    const fraction = computePvcFillFraction(s);
    if (fraction === null) continue;
    const request = requests.get(key);
    if (request !== undefined && s.capacityBytes > request * SHARED_FS_MARGIN) continue;
    out.push({
      namespace: s.namespace,
      pvcName: s.pvcName,
      usedBytes: s.usedBytes,
      capacityBytes: s.capacityBytes,
      fraction,
    });
  }
  return out;
}

/**
 * Every PVC the cluster's kubelets can report on.
 *
 * Returns an EMPTY list when no kubelet answers, which the caller must read as
 * "unknown", not "nothing is full" — a detached volume has no kubelet stats
 * either, and that is correct: a volume nothing has mounted cannot be filling
 * up, and calling that a fault is how an idle resting state becomes an alarm.
 */
export const readPvcUsage: PvcUsageReader = async (k8s) => {
  const nodes = await k8s.core.listNode();
  const names = (nodes.items ?? [])
    .map((n) => n.metadata?.name)
    .filter((n): n is string => Boolean(n));
  const [stats, requests] = await Promise.all([
    readPvcVolumeStats(names),
    readPvcRequests(k8s).catch(() => new Map<string, number>()),
  ]);
  return joinPvcUsage(stats, requests);
};
