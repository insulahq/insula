/**
 * Keep Longhorn's recurring-job membership matching what the manifests say,
 * and clear the snapshots a membership change left behind.
 *
 * Two jobs, in this order, because the second depends on the first:
 *
 *  1. The platform database's volumes join `system-critical`. `hourly-snap`
 *     covers that group and nothing else, so this is what keeps the database's
 *     six-hour in-volume rollback chain alive. The group arrives on the PVC via
 *     CNPG `inheritedMetadata`, but Longhorn only copies PVC membership labels
 *     onto a volume at PROVISION time — an existing volume needs the label
 *     written to its own CR (see selection.ts).
 *
 *  2. Snapshots whose creating job no longer covers their volume are deleted.
 *     Tenant volumes used to be swept into `hourly-snap` through the implicit
 *     `default` group and accumulated a snapshot an hour; once the job stops
 *     selecting them its `retain` stops pruning them too, and nothing else can
 *     — they have no VolumeSnapshot CR and no `tenant_volume_snapshots` row, so
 *     neither panel shows them and the tenant-snapshot reaper cannot see them.
 *
 * Rate-limited on purpose. Deleting a Longhorn snapshot makes the engine
 * coalesce its blocks into the next snapshot in the chain, which is write-heavy
 * on a disk this platform has already measured multi-second fsync stalls on.
 * One volume's chain is purged as a unit (coalescing it once is cheaper than
 * poking it repeatedly), a few volumes per tick, and the rest wait.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  GROUP_LABEL_PREFIX,
  planGroupLabelling,
  planSnapshotSweep,
  type RecurringJobRef,
  type SnapshotRef,
  type VolumeRef,
} from './selection.js';

const LONGHORN_GROUP = 'longhorn.io';
const LONGHORN_VERSION = 'v1beta2';
const LONGHORN_NAMESPACE = 'longhorn-system';
const PLATFORM_NAMESPACE = 'platform';

/** The group `hourly-snap` covers — see k8s/base/longhorn/recurring-jobs.yaml. */
export const SYSTEM_CRITICAL_GROUP = 'system-critical';
/** Volumes purged per tick. 3 × a 6-snapshot chain is a modest amount of I/O. */
export const MAX_VOLUMES_PER_TICK = 3;

export interface Logger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ReconcileResult {
  readonly labelled: readonly string[];
  readonly deletedSnapshots: number;
  readonly purgedVolumes: readonly string[];
  readonly deferredVolumes: number;
  /** Set when the tick declined to act, with the reason. */
  readonly abortedReason?: string;
}

interface ListResponse<T> { items?: T[] }

async function listLonghorn<T>(k8s: K8sClients, plural: string): Promise<T[]> {
  const res = await (k8s.custom as unknown as {
    listNamespacedCustomObject: (a: {
      group: string; version: string; namespace: string; plural: string;
    }) => Promise<ListResponse<T>>;
  }).listNamespacedCustomObject({
    group: LONGHORN_GROUP, version: LONGHORN_VERSION, namespace: LONGHORN_NAMESPACE, plural,
  });
  return res.items ?? [];
}

// ─── reads ──────────────────────────────────────────────────────────────────

interface LiveRecurringJob {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly groups?: string[]; readonly task?: string };
}

export async function listRecurringJobs(k8s: K8sClients): Promise<RecurringJobRef[]> {
  const items = await listLonghorn<LiveRecurringJob>(k8s, 'recurringjobs');
  return items
    .filter((j): j is LiveRecurringJob & { metadata: { name: string } } => Boolean(j.metadata?.name))
    .map((j) => ({ name: j.metadata.name, groups: j.spec?.groups ?? [] }));
}

interface LiveVolume {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
}

export async function listVolumes(k8s: K8sClients): Promise<VolumeRef[]> {
  const items = await listLonghorn<LiveVolume>(k8s, 'volumes');
  return items
    .filter((v): v is LiveVolume & { metadata: { name: string } } => Boolean(v.metadata?.name))
    .map((v) => ({ name: v.metadata.name, labels: v.metadata.labels ?? {} }));
}

interface LiveSnapshot {
  readonly metadata?: { readonly name?: string; readonly deletionTimestamp?: string };
  readonly spec?: { readonly volume?: string; readonly labels?: Record<string, string> };
}

export async function listSnapshots(k8s: K8sClients): Promise<SnapshotRef[]> {
  const items = await listLonghorn<LiveSnapshot>(k8s, 'snapshots');
  return items
    .filter((s) => Boolean(s.metadata?.name) && Boolean(s.spec?.volume))
    // Already being purged — re-deleting would just re-issue the same call.
    .filter((s) => !s.metadata?.deletionTimestamp)
    .map((s) => ({
      name: s.metadata?.name ?? '',
      volume: s.spec?.volume ?? '',
      recurringJob: s.spec?.labels?.RecurringJob ?? null,
    }));
}

/**
 * The volumes backing the platform database, from the CNPG PVCs rather than
 * from any label — so the protection holds even on a tick whose labelling
 * step failed, and scales to `instances: 3` without a second list to maintain.
 */
export async function listPlatformDatabaseVolumes(k8s: K8sClients): Promise<string[]> {
  const res = await k8s.core.listNamespacedPersistentVolumeClaim({
    namespace: PLATFORM_NAMESPACE, labelSelector: 'cnpg.io/cluster',
  } as unknown as Parameters<typeof k8s.core.listNamespacedPersistentVolumeClaim>[0]);
  return (res.items ?? [])
    .map((pvc) => pvc.spec?.volumeName)
    .filter((name): name is string => Boolean(name));
}

// ─── writes ─────────────────────────────────────────────────────────────────

async function addVolumeGroupLabel(k8s: K8sClients, name: string, group: string): Promise<void> {
  // Merge-patch a single label: a JSON-patch `add` to /metadata/labels/<key>
  // needs the key escaped and the parent to exist, and `replace` on an absent
  // path is a 422. Merge-patch adds the one key and leaves the rest alone.
  await k8s.custom.patchNamespacedCustomObject(
    {
      group: LONGHORN_GROUP, version: LONGHORN_VERSION, namespace: LONGHORN_NAMESPACE,
      plural: 'volumes', name,
      body: { metadata: { labels: { [`${GROUP_LABEL_PREFIX}${group}`]: 'enabled' } } },
    } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
    MERGE_PATCH,
  );
}

async function deleteSnapshot(k8s: K8sClients, name: string): Promise<void> {
  try {
    await k8s.custom.deleteNamespacedCustomObject({
      group: LONGHORN_GROUP, version: LONGHORN_VERSION, namespace: LONGHORN_NAMESPACE,
      plural: 'snapshots', name,
    } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    // 404: another replica got there first. Anything else is real.
    if (code !== 404) throw err;
  }
}

// ─── the tick ───────────────────────────────────────────────────────────────

export interface ReconcileDeps {
  readonly k8s: K8sClients;
  readonly log: Logger;
  readonly maxVolumesPerTick?: number;
}

export async function reconcileLonghornRecurringJobs(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { k8s, log } = deps;
  const empty = { labelled: [], deletedSnapshots: 0, purgedVolumes: [], deferredVolumes: 0 };

  let protectedVolumes: string[];
  try {
    protectedVolumes = await listPlatformDatabaseVolumes(k8s);
  } catch (err) {
    // Without this list the database's own snapshots are indistinguishable
    // from a tenant's. Decline the whole tick rather than guess.
    const reason = `platform database PVCs unreadable: ${(err as Error).message}`;
    log.warn({ err: (err as Error).message }, 'longhorn-recurring-jobs: skipping tick, cannot identify the platform database');
    return { ...empty, abortedReason: reason };
  }
  if (protectedVolumes.length === 0) {
    // A cluster with no CNPG PVC at all is mid-bootstrap or mid-restore. The
    // volumes are about to appear; sweeping now would race that.
    const reason = 'no platform database PVC found';
    log.warn({}, 'longhorn-recurring-jobs: skipping tick, no platform database PVC found');
    return { ...empty, abortedReason: reason };
  }

  let volumes = await listVolumes(k8s);

  // 1. The platform database joins the group `hourly-snap` covers.
  const toLabel = planGroupLabelling(volumes, protectedVolumes, SYSTEM_CRITICAL_GROUP);
  const labelled: string[] = [];
  for (const name of toLabel) {
    try {
      await addVolumeGroupLabel(k8s, name, SYSTEM_CRITICAL_GROUP);
      labelled.push(name);
      log.info({ volume: name, group: SYSTEM_CRITICAL_GROUP }, 'longhorn-recurring-jobs: volume joined group');
    } catch (err) {
      log.error({ volume: name, err: (err as Error).message }, 'longhorn-recurring-jobs: group label failed');
    }
  }
  if (labelled.length > 0) {
    // Re-read rather than patch the local copies: the sweep's verdict hinges on
    // these labels, so it should read what the API server actually stored.
    volumes = await listVolumes(k8s);
  }

  // 2. Sweep snapshots whose job no longer covers their volume.
  const [jobs, snapshots] = await Promise.all([listRecurringJobs(k8s), listSnapshots(k8s)]);
  if (jobs.length === 0) {
    // Every snapshot would look like an orphan of a deleted job. More likely
    // the list failed to return anything useful.
    log.warn({}, 'longhorn-recurring-jobs: no RecurringJobs found — not sweeping');
    return { ...empty, labelled, abortedReason: 'no RecurringJobs found' };
  }

  const plan = planSnapshotSweep({
    snapshots,
    jobs,
    volumes,
    protectedVolumes,
    maxVolumesPerTick: deps.maxVolumesPerTick ?? MAX_VOLUMES_PER_TICK,
  });

  let deleted = 0;
  const purged: string[] = [];
  for (const group of plan.byVolume) {
    let volumeDeleted = 0;
    for (const name of group.snapshots) {
      try {
        await deleteSnapshot(k8s, name);
        volumeDeleted += 1;
      } catch (err) {
        log.error({ snapshot: name, err: (err as Error).message }, 'longhorn-recurring-jobs: snapshot delete failed');
      }
    }
    if (volumeDeleted > 0) {
      deleted += volumeDeleted;
      purged.push(group.volume);
      log.info(
        { volume: group.volume, deleted: volumeDeleted },
        'longhorn-recurring-jobs: removed scheduled snapshots left by a job that no longer covers this volume',
      );
    }
  }
  if (plan.deferredVolumes > 0) {
    log.info(
      { deferredVolumes: plan.deferredVolumes },
      'longhorn-recurring-jobs: more volumes to purge, deferred to a later tick to keep snapshot coalescing off the disk',
    );
  }

  return {
    labelled,
    deletedSnapshots: deleted,
    purgedVolumes: purged,
    deferredVolumes: plan.deferredVolumes,
  };
}
