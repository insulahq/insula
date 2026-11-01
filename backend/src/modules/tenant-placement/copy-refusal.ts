/**
 * Why Longhorn will not build a tenant's copy on a node, in terms an operator
 * can act on.
 *
 * Longhorn's own word for every refusal is the volume condition
 * `Scheduled=False … replica scheduling failed`. The platform passed that on
 * and guessed the cause: "move it to a node with room for its volume, or shrink
 * the volume". On production the cause was a node tag a drain had left on the
 * volume, on a node with 595 GB free — the advice sent the operator the wrong
 * way, and the notification never named the tag.
 *
 * Longhorn's replica scheduler (v1.12) checks, in this order: the node's tags
 * against the volume's `nodeSelector` (a volume with none may use a tagged
 * node only while `allow-empty-node-selector-volume` is on), whether the node
 * takes new data, the disks' tags against its `diskSelector` (likewise
 * `allow-empty-disk-selector-volume`), then each disk's room
 * (target-capacity.ts). This repeats those checks against the node the copy
 * was meant for and names the first one that fails, with what to do about it.
 * When none fails — or the node could not be read — Longhorn's own words are
 * passed on, and nothing is guessed.
 */
import type { CopyRefusal } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { scheduleFailureOf, type LonghornCondition } from '../tenant-health/service.js';
import { LH, lhList } from './relocate.js';
import {
  diskRefusal, gib, nodeDisks, readSetting, schedulableBytes,
  type DiskCapacity, type LhNodeRaw, type SchedulingSettings,
} from './target-capacity.js';
import { HOST_TAG_PREFIX } from './volume-pin.js';

export type { CopyRefusal };

/** What the explanation needs of the volume. */
export interface RefusedVolume {
  readonly nodeSelector: readonly string[];
  readonly diskSelector: readonly string[];
  /** Longhorn `spec.size` — what the scheduler reserves. */
  readonly size: number;
  /** Longhorn `status.actualSize` — what would be copied. */
  readonly actualSize: number;
}

/** Longhorn's `allow-empty-*-selector-volume` settings; null where unread. */
export interface EmptySelectorSettings {
  readonly node: boolean | null;
  readonly disk: boolean | null;
}

/** The Longhorn side, read once for all refusals. */
export interface CopyRefusalContext {
  readonly nodes: ReadonlyMap<string, LhNodeRaw>;
  /** Null when the settings could not be read: room is then not judged. */
  readonly settings: SchedulingSettings | null;
  /** Absent or null where unread: those two checks are then not made, and "all allow" is not claimed. */
  readonly emptySelector?: EmptySelectorSettings;
}

function listed(tags: readonly string[]): string {
  return tags.join(', ');
}

/** "cause — action", for the places that keep one line of text. */
export function copyRefusalText(r: CopyRefusal): string {
  return `${r.cause} — ${r.action}`;
}

function hasAll(tags: readonly string[] | undefined, wanted: readonly string[]): boolean {
  return wanted.every((t) => (tags ?? []).includes(t));
}

/** The first room check this volume fails on every disk it may use, or null. */
function roomRefusal(target: string, volume: RefusedVolume, disks: readonly DiskCapacity[], settings: SchedulingSettings): CopyRefusal | null {
  if (disks.length === 0) return null;
  const need = { volumeName: '', size: volume.size, actualSize: volume.actualSize };
  if (disks.some((d) => diskRefusal(need, d, settings) === null)) return null;
  const roomiest = disks.reduce((best, d) => (schedulableBytes(d, settings) > schedulableBytes(best, settings) ? d : best));
  if (diskRefusal(need, roomiest, settings) === 'over-provisioned') {
    return {
      cause: `${target} has ${gib(schedulableBytes(roomiest, settings))} left that Longhorn will schedule, and Longhorn `
        + `reserves the volume's full ${gib(volume.size)}, not the ${gib(volume.actualSize)} in use`,
      action: 'move the tenant to a node with more room, or shrink the volume',
    };
  }
  return {
    cause: `copying its ${gib(volume.actualSize)} would take ${target}'s disk below Longhorn's free-space floor `
      + `(${settings.minimalAvailablePct}% of the disk)`,
    action: 'move the tenant to a node with more free disk',
  };
}

/**
 * Why Longhorn will not place `volume`'s copy on `target`. Pure.
 * `longhornWords` is the volume's `Scheduled=False` message, used when no
 * check here fails.
 */
export function explainCopyRefusal(
  target: string,
  volume: RefusedVolume,
  ctx: CopyRefusalContext | null,
  longhornWords: string,
): CopyRefusal {
  const unexplained = (checked: boolean): CopyRefusal => ({
    cause: `Longhorn: ${longhornWords}`,
    action: checked
      ? `${target}, its disks and the volume's tags all allow the copy, so look at the volume in the Longhorn UI`
      : 'look at the volume in the Longhorn UI',
  });
  if (!ctx) return unexplained(false);
  const node = ctx.nodes.get(target);
  if (!node) {
    return {
      cause: `Longhorn has no node named ${target}`,
      action: `check that Longhorn runs on ${target}, or move the tenant to another node`,
    };
  }

  const nodeTags = node.spec?.tags ?? [];
  const missing = volume.nodeSelector.filter((t) => !nodeTags.includes(t));
  if (missing.length > 0) {
    // The platform's own pin: a drain or a move held the volume to a node, and
    // a later move did not take the tag along.
    if (missing.every((t) => t.startsWith(HOST_TAG_PREFIX))) {
      return {
        cause: `the volume is still held to the Longhorn node tagged ${listed(missing)} (a pin left by an earlier `
          + `drain or move), and ${target} does not carry that tag`,
        action: 'move the tenant again from its Placement card; a move holds the volume to the node it moves to',
      };
    }
    return {
      cause: `the volume may only use Longhorn nodes tagged ${listed(volume.nodeSelector)}, and ${target} is not tagged `
        + listed(missing),
      action: `add the tag to ${target} in Longhorn, or remove it from the volume`,
    };
  }

  if (volume.nodeSelector.length === 0 && nodeTags.length > 0 && ctx.emptySelector?.node === false) {
    return {
      cause: `the volume has no node tags, and with Longhorn's allow-empty-node-selector-volume setting off it may not `
        + `use ${target}, which is tagged ${listed(nodeTags)}`,
      action: 'move the tenant again from its Placement card, which gives the volume its node\'s tag, or switch the setting '
        + 'on in Longhorn',
    };
  }

  const offered = nodeDisks(node);
  if (offered.state === 'off') {
    return {
      cause: `Longhorn scheduling is switched off on ${target} or on all of its disks`,
      action: 'switch it back on in Longhorn, or move the tenant to another node',
    };
  }
  if (offered.state === 'not-ready') {
    return { cause: `${target}: ${offered.detail}`, action: 'Longhorn builds the copy once the node\'s disks are ready' };
  }

  const untaggedOnly = volume.diskSelector.length === 0 && ctx.emptySelector?.disk === false;
  const usable = offered.disks.filter((d) => hasAll(d.tags, volume.diskSelector) && (!untaggedOnly || (d.tags ?? []).length === 0));
  if (usable.length === 0 && untaggedOnly) {
    return {
      cause: `the volume has no disk tags, and with Longhorn's allow-empty-disk-selector-volume setting off it may not use `
        + `${target}'s disks, which are all tagged`,
      action: 'switch the setting on in Longhorn, or move the tenant to a node with an untagged disk',
    };
  }
  if (usable.length === 0) {
    return {
      cause: `the volume may only use Longhorn disks tagged ${listed(volume.diskSelector)}, and no disk on ${target} has `
        + (volume.diskSelector.length === 1 ? 'it' : 'them all'),
      action: `tag a disk on ${target} in Longhorn, or remove the tag from the volume`,
    };
  }

  if (!ctx.settings) return unexplained(false);
  const everyCheckMade = ctx.emptySelector?.node != null && ctx.emptySelector.disk != null;
  return roomRefusal(target, volume, usable, ctx.settings) ?? unexplained(everyCheckMade);
}

/** A Longhorn volume as the refusal read needs it. */
export interface LhRefusalVolumeRaw {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly numberOfReplicas?: number;
    readonly size?: string | number;
    readonly nodeSelector?: readonly string[] | null;
    readonly diskSelector?: readonly string[] | null;
  };
  readonly status?: {
    readonly actualSize?: string | number;
    readonly conditions?: readonly LonghornCondition[];
    readonly kubernetesStatus?: { readonly namespace?: string; readonly lastPVCRefAt?: string };
  };
}
interface LhReplicaRaw {
  readonly spec?: { readonly volumeName?: string; readonly nodeID?: string; readonly failedAt?: string };
  readonly status?: { readonly currentState?: string };
}

/** A Longhorn boolean setting, or null when it cannot be read as one. */
export function parseBoolSetting(value: unknown): boolean | null {
  let raw = value;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try { raw = (JSON.parse(raw) as { v1?: unknown }).v1; } catch { return null; }
  }
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
}

async function readBoolSetting(k8s: K8sClients, name: string): Promise<boolean | null> {
  try {
    const setting = await k8s.custom.getNamespacedCustomObject({
      ...LH, plural: 'settings', name,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { value?: unknown };
    return parseBoolSetting(setting.value);
  } catch {
    return null;
  }
}

function toBytes(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The volume fields the explanation reads, from a raw Longhorn volume. Pure. */
export function refusedVolumeOf(v: LhRefusalVolumeRaw): RefusedVolume {
  return {
    nodeSelector: v.spec?.nodeSelector ?? [],
    diskSelector: v.spec?.diskSelector ?? [],
    size: toBytes(v.spec?.size),
    actualSize: toBytes(v.status?.actualSize),
  };
}

/**
 * Longhorn's nodes and the two scheduling settings. Never throws: a node list
 * that cannot be read gives null (Longhorn's words are passed on), settings
 * that cannot be read leave room unjudged.
 */
export async function readCopyRefusalContext(k8s: K8sClients): Promise<CopyRefusalContext | null> {
  try {
    const list = await lhList<LhNodeRaw>(k8s, 'nodes');
    const nodes = new Map((list.items ?? []).filter((n) => n.metadata?.name).map((n) => [n.metadata!.name!, n]));
    const settings = await Promise.all([
      readSetting(k8s, 'storage-over-provisioning-percentage'),
      readSetting(k8s, 'storage-minimal-available-percentage'),
    ]).then(([overProvisioningPct, minimalAvailablePct]) => ({ overProvisioningPct, minimalAvailablePct }), () => null);
    const [node, disk] = await Promise.all([
      readBoolSetting(k8s, 'allow-empty-node-selector-volume'),
      readBoolSetting(k8s, 'allow-empty-disk-selector-volume'),
    ]);
    return { nodes, settings, emptySelector: { node, disk } };
  } catch (err) {
    console.warn(`[tenant-placement] could not read Longhorn's nodes to explain a refused copy: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Why Longhorn is not building, on `target`, the copy of a volume the move
 * brought there, or null. Read once the tenant is running on its new node: the
 * volume is attached by then and the scheduler has answered.
 *
 * Only a single-replica volume with nothing usable on the target counts. A
 * volume replicated by design, or one whose data is already local, can carry a
 * `Scheduled=False` of its own — a third replica with no node to go to — and
 * that says nothing about this move.
 *
 * Never throws — it only words the move's result, and the placement view
 * reports the same condition every minute.
 */
export async function readCopyBlocker(
  k8s: K8sClients,
  namespace: string,
  target: string,
  storageTier: string | null,
): Promise<CopyRefusal | null> {
  if (storageTier === 'ha') return null;
  try {
    const [vols, reps] = await Promise.all([
      lhList<LhRefusalVolumeRaw>(k8s, 'volumes'),
      lhList<LhReplicaRaw>(k8s, 'replicas'),
    ]);
    for (const v of vols.items ?? []) {
      const ks = v.status?.kubernetesStatus;
      if (ks?.namespace !== namespace || ks?.lastPVCRefAt || (v.spec?.numberOfReplicas ?? 1) > 1) continue;
      const failure = scheduleFailureOf(v.status?.conditions);
      if (!failure) continue;
      const local = (reps.items ?? []).some((r) => r.spec?.volumeName === v.metadata?.name
        && r.spec?.nodeID === target && !r.spec?.failedAt && r.status?.currentState !== 'error');
      if (!local) return explainCopyRefusal(target, refusedVolumeOf(v), await readCopyRefusalContext(k8s), failure);
    }
    return null;
  } catch (err) {
    console.warn(`[tenant-placement] could not read Longhorn's scheduling verdict in ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
