/**
 * Can a node hold a tenant's data? Asked before a move re-pins anything.
 *
 * A local-tier volume has one replica. After a move, Longhorn's best-effort
 * data locality builds that replica on the node the tenant now runs on and
 * drops the old one. When Longhorn's scheduler REFUSES the new replica the
 * tenant still starts on the new node — and from then on reads and writes every
 * block across the network to the node it was moved away from. Nothing retries
 * and nothing fails (seen on production: a 100 GiB volume holding 28 GiB, moved
 * to a node with 66 GiB left to schedule — `Scheduled=False
 * LocalReplicaSchedulingFailure: insufficient storage`, while the move reported
 * "Longhorn is copying the data").
 *
 * The rule here is Longhorn's own (v1.12 scheduler, `IsSchedulableToDisk`), per
 * disk:
 *
 *   available − actualSize  >  maximum × storage-minimal-available-percentage
 *   scheduled + size       <=  (maximum − reserved) × storage-over-provisioning-percentage
 *
 * `size` is the volume's FULL size: Longhorn reserves what a volume may grow
 * to, not what it holds today. That is the clause an operator does not expect.
 *
 * A guard rail, not a new way to fail: when the node, its disks or the two
 * settings cannot be read — or the node reports no ready disk yet, as a freshly
 * joined one does — the verdict is `unknown` and the move goes ahead. A move is
 * how an operator empties a failing node, and refusing it over something that
 * could not be read would be worse than the stuck copy — which the placement
 * view then names (tenant-health `VolumeFact.scheduleFailure`).
 *
 * Not modelled: a volume's disk and node selectors (tags). The tenant storage
 * classes set none; a volume given one by hand can still be refused by Longhorn
 * after an `ok` here, and is then reported the same way.
 *
 * The volumes counted are the ones the move brings along — the same selection
 * as `planRelocation`: every live single-replica volume of the namespace.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { LH, lhList } from './relocate.js';

const GIB = 2 ** 30;

/** One Longhorn disk on the target node, in bytes. */
export interface DiskCapacity {
  readonly name: string;
  readonly maximum: number;
  readonly available: number;
  readonly scheduled: number;
  readonly reserved: number;
}

export interface SchedulingSettings {
  /** Longhorn `storage-over-provisioning-percentage`. */
  readonly overProvisioningPct: number;
  /** Longhorn `storage-minimal-available-percentage`. */
  readonly minimalAvailablePct: number;
}

/** A volume whose single replica has to be built on the target. */
export interface VolumeNeed {
  readonly volumeName: string;
  /** Longhorn `spec.size` — what the scheduler reserves. */
  readonly size: number;
  /** Longhorn `status.actualSize` — what would be copied. */
  readonly actualSize: number;
}

export type CapacityVerdict =
  | { readonly state: 'ok' }
  /** Could not be judged; the move is not held back. */
  | { readonly state: 'unknown'; readonly detail: string }
  | {
    readonly state: 'insufficient';
    /** Operator-facing: what does not fit, by how much, and what to do. */
    readonly detail: string;
    readonly neededBytes: number;
    /** What Longhorn would still schedule on the node's roomiest disk; 0 when none. */
    readonly schedulableBytes: number;
  };

/** Why Longhorn would refuse the replica on this disk; null when it fits. */
export type DiskRefusal = 'disk-full' | 'over-provisioned';

/** Bytes Longhorn would still schedule onto the disk. Negative when over-committed. */
export function schedulableBytes(disk: DiskCapacity, settings: SchedulingSettings): number {
  return Math.floor(((disk.maximum - disk.reserved) * settings.overProvisioningPct) / 100) - disk.scheduled;
}

/** Longhorn's `IsSchedulableToDisk`, clause for clause. Pure. */
export function diskRefusal(need: VolumeNeed, disk: DiskCapacity, settings: SchedulingSettings): DiskRefusal | null {
  if (disk.maximum <= 0 || disk.available <= 0) return 'disk-full';
  const floor = Math.floor((disk.maximum * settings.minimalAvailablePct) / 100);
  if (disk.available - need.actualSize <= floor) return 'disk-full';
  if (need.size > schedulableBytes(disk, settings)) return 'over-provisioned';
  return null;
}

function gib(bytes: number): string {
  return `${(Math.max(0, bytes) / GIB).toFixed(1)} GiB`;
}

/**
 * Whether every volume in `needs` can get its replica on the node's disks. Pure.
 * Largest first, each placement charged to its disk — two volumes must not
 * both be promised the same room.
 */
export function judgeTargetCapacity(
  target: string,
  needs: readonly VolumeNeed[],
  disks: readonly DiskCapacity[],
  settings: SchedulingSettings,
): CapacityVerdict {
  if (needs.length === 0) return { state: 'ok' };
  if (disks.length === 0) return { state: 'unknown', detail: `no Longhorn disk on ${target} to judge` };
  const neededBytes = needs.reduce((sum, n) => sum + n.size, 0);
  const free = disks.map((d) => ({ ...d }));
  for (const need of [...needs].sort((a, b) => b.size - a.size)) {
    const disk = free.find((d) => diskRefusal(need, d, settings) === null);
    if (disk) {
      disk.scheduled += need.size;
      disk.available -= need.actualSize;
      continue;
    }
    const roomiest = free.reduce((best, d) => (schedulableBytes(d, settings) > schedulableBytes(best, settings) ? d : best));
    const room = Math.max(0, schedulableBytes(roomiest, settings));
    const what = needs.length > 1 ? `one of this tenant's volumes (${gib(need.size)})` : `this tenant's ${gib(need.size)} volume`;
    const detail = diskRefusal(need, roomiest, settings) === 'over-provisioned'
      ? `${target} cannot hold ${what}: Longhorn has ${gib(room)} left to schedule there, and it reserves a volume's `
        + `full size, not what is in use (${gib(need.actualSize)} here). The tenant would run on ${target} with its data left `
        + 'behind on the node it came from. Move it to a node with more room, or shrink the volume first.'
      : `${target} cannot hold ${what}: copying its ${gib(need.actualSize)} of data would leave the disk below Longhorn's `
        + `free-space floor (${settings.minimalAvailablePct}% of the disk). The tenant would run on ${target} with its data left `
        + 'behind on the node it came from. Move it to a node with more free disk.';
    return { state: 'insufficient', neededBytes, schedulableBytes: room, detail };
  }
  return { state: 'ok' };
}

interface LhVolumeRaw {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly numberOfReplicas?: number; readonly size?: string | number };
  readonly status?: {
    readonly actualSize?: string | number;
    readonly kubernetesStatus?: { readonly namespace?: string; readonly lastPVCRefAt?: string };
  };
}
interface LhReplicaRaw {
  readonly spec?: { readonly volumeName?: string; readonly nodeID?: string; readonly failedAt?: string };
  readonly status?: { readonly currentState?: string };
}
interface LhCondition { readonly type?: string; readonly status?: string }
export interface LhNodeRaw {
  readonly spec?: {
    readonly allowScheduling?: boolean;
    readonly disks?: Record<string, {
      readonly allowScheduling?: boolean;
      readonly evictionRequested?: boolean;
      readonly storageReserved?: number;
    }>;
  };
  readonly status?: {
    readonly conditions?: readonly LhCondition[];
    readonly diskStatus?: Record<string, {
      readonly storageMaximum?: number;
      readonly storageAvailable?: number;
      readonly storageScheduled?: number;
      readonly conditions?: readonly LhCondition[];
    }>;
  };
}

function lhGet<T>(k8s: K8sClients, plural: string, name: string): Promise<T> {
  return k8s.custom.getNamespacedCustomObject(
    { ...LH, plural, name } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0],
  ) as Promise<T>;
}

/**
 * A Longhorn setting as a whole number. Throws when it is not one: guessing a
 * default here would refuse (or wave through) moves on a cluster configured
 * otherwise. Settings that differ per data engine are stored as
 * `{"v1":"…","v2":"…"}`; tenant volumes are v1.
 */
export function parseIntSetting(name: string, value: unknown): number {
  let raw = value;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { raw = (JSON.parse(raw) as { v1?: unknown }).v1; } catch { /* judged below */ }
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Longhorn setting ${name} is not a number: ${JSON.stringify(value)}`);
  return n;
}

async function readSetting(k8s: K8sClients, name: string): Promise<number> {
  const setting = await lhGet<{ value?: unknown }>(k8s, 'settings', name);
  return parseIntSetting(name, setting.value);
}

/** What a Longhorn node offers the scheduler. */
export type NodeDisks =
  | { readonly state: 'ready'; readonly disks: DiskCapacity[] }
  /** Longhorn has been TOLD not to place data here: the node, or every disk, has scheduling off or is being emptied. */
  | { readonly state: 'off' }
  /** Nothing to judge (yet): no disk reported, or none of them ready. Not a refusal. */
  | { readonly state: 'not-ready'; readonly detail: string };

const isFalse = (conditions: readonly LhCondition[] | undefined, type: string): boolean =>
  (conditions ?? []).some((c) => c.type === type && c.status === 'False');

/**
 * The node's disks, or why there are none to judge. Pure.
 *
 * "Off" and "not ready" must not be confused: the first is an operator's
 * decision and the data will never go there; the second is a node that has just
 * joined or a disk that is briefly unavailable — refusing a move to it would
 * block exactly the evacuation the move is for. A disk under pressure
 * (`Schedulable=False`) is kept: its own numbers fail the rule below.
 */
export function nodeDisks(node: LhNodeRaw): NodeDisks {
  // Scheduling disabled on the node, or its Kubernetes node cordoned.
  if (node.spec?.allowScheduling === false || isFalse(node.status?.conditions, 'Schedulable')) return { state: 'off' };
  if (isFalse(node.status?.conditions, 'Ready')) return { state: 'not-ready', detail: 'Longhorn reports the node as not ready' };
  const disks: DiskCapacity[] = [];
  let off = 0;
  let notReady = 0;
  for (const [name, status] of Object.entries(node.status?.diskStatus ?? {})) {
    const spec = node.spec?.disks?.[name];
    if (!spec) continue;
    if (spec.allowScheduling === false || spec.evictionRequested === true) { off += 1; continue; }
    if (isFalse(status.conditions, 'Ready')) { notReady += 1; continue; }
    disks.push({
      name,
      maximum: status.storageMaximum ?? 0,
      available: status.storageAvailable ?? 0,
      scheduled: status.storageScheduled ?? 0,
      reserved: spec.storageReserved ?? 0,
    });
  }
  if (disks.length > 0) return { state: 'ready', disks };
  if (off > 0 && notReady === 0) return { state: 'off' };
  return { state: 'not-ready', detail: notReady > 0 ? 'none of the node\'s Longhorn disks is ready' : 'the node reports no Longhorn disk yet' };
}

/**
 * Whether `target` can take the replica of every volume the move would bring
 * there. Never throws — see the header for why an unreadable cluster is
 * `unknown`, not a refusal.
 */
export async function checkTargetCapacity(
  k8s: K8sClients,
  namespace: string,
  target: string,
  storageTier: string | null,
): Promise<CapacityVerdict> {
  // Replicated across nodes by design: the move places nothing.
  if (storageTier === 'ha') return { state: 'ok' };
  try {
    const [vols, reps] = await Promise.all([
      lhList<LhVolumeRaw>(k8s, 'volumes'),
      lhList<LhReplicaRaw>(k8s, 'replicas'),
    ]);
    const needs: VolumeNeed[] = [];
    for (const v of vols.items ?? []) {
      const volumeName = v.metadata?.name;
      const ks = v.status?.kubernetesStatus;
      // Live volumes of this tenant only; a leftover of a past PVC moves nowhere.
      if (!volumeName || ks?.namespace !== namespace || ks?.lastPVCRefAt) continue;
      if ((v.spec?.numberOfReplicas ?? 1) > 1) continue;
      const local = (reps.items ?? []).some((r) => r.spec?.volumeName === volumeName
        && r.spec?.nodeID === target && !r.spec?.failedAt && r.status?.currentState !== 'error');
      if (local) continue;
      const size = Number(v.spec?.size);
      if (!Number.isFinite(size) || size <= 0) return { state: 'unknown', detail: `volume ${volumeName} reports no size` };
      const actual = Number(v.status?.actualSize ?? 0);
      needs.push({ volumeName, size, actualSize: Number.isFinite(actual) && actual > 0 ? actual : 0 });
    }
    if (needs.length === 0) return { state: 'ok' };

    const [node, overProvisioningPct, minimalAvailablePct] = await Promise.all([
      lhGet<LhNodeRaw>(k8s, 'nodes', target),
      readSetting(k8s, 'storage-over-provisioning-percentage'),
      readSetting(k8s, 'storage-minimal-available-percentage'),
    ]);
    const offered = nodeDisks(node);
    if (offered.state === 'not-ready') return { state: 'unknown', detail: `${target}: ${offered.detail}` };
    if (offered.state === 'off') {
      return {
        state: 'insufficient',
        neededBytes: needs.reduce((sum, n) => sum + n.size, 0),
        schedulableBytes: 0,
        detail: `Longhorn is not placing new data on ${target}: scheduling is switched off for the node or for all of its `
          + 'disks. The tenant would run there with its data left behind on the node it came from. Pick another node.',
      };
    }
    return judgeTargetCapacity(target, needs, offered.disks, { overProvisioningPct, minimalAvailablePct });
  } catch (err) {
    // The Kubernetes client's message is the whole response, body and headers,
    // over several lines; this goes into one log line.
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 160);
    return { state: 'unknown', detail };
  }
}
