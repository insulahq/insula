import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

/**
 * Inventory of platform/system PVCs and their Longhorn snapshot state.
 *
 * "System" namespaces (platform/mail/longhorn-system/...) are platform-
 * managed, distinct from tenant client-* namespaces. Snapshots for those
 * client volumes are surfaced via the existing storage-lifecycle module.
 *
 * Each row carries:
 *  - the PVC name + namespace
 *  - the underlying Longhorn volume name
 *  - snapshot count + total bytes
 *  - currently-applied recurring-job retention (frequency + retain count)
 *
 * The Longhorn frequency for a volume is the union of all
 * recurring-jobs that apply to it via either `recurring-job.longhorn.io/<name>: enabled`
 * (direct) or `recurring-job-group.longhorn.io/<group>: enabled` (group).
 */

export const SYSTEM_NAMESPACES = Object.freeze([
  'platform',
  'platform-system',
  'mail',
  'longhorn-system',
  'cnpg-system',
  'monitoring',
] as const);

export type SnapshotTask = 'snapshot' | 'backup';

export interface SystemPvcSnapshotSummary {
  readonly namespace: string;
  readonly pvcName: string;
  readonly longhornVolumeName: string;
  readonly volumeSizeBytes: number;
  readonly snapshotCount: number;
  readonly snapshotBytesTotal: number;
  readonly oldestSnapshotAt: string | null;
  readonly newestSnapshotAt: string | null;
  /** Names of RecurringJobs currently applying to the volume. */
  readonly recurringJobs: readonly string[];
  /** True when status.robustness == 'degraded'. */
  readonly degraded: boolean;
}

export interface SystemSnapshotEntry {
  readonly snapshotName: string;
  readonly volumeName: string;
  readonly createdAt: string | null;
  readonly sizeBytes: number;
  /** True when at least one replica reports the snapshot as present. */
  readonly usable: boolean;
  /** Optional human label set on creation; null for recurring snapshots. */
  readonly userLabel: string | null;
  /** Indicates whether the snapshot has been removed (marked for cleanup). */
  readonly markedForRemoval: boolean;
}

export interface RecurringJobPolicy {
  readonly jobName: string;
  readonly task: SnapshotTask;
  readonly cron: string;
  readonly retain: number;
  readonly groups: readonly string[];
}

interface RawPvc {
  readonly metadata?: { readonly name?: string; readonly namespace?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly volumeName?: string };
  readonly status?: { readonly capacity?: { readonly storage?: string | number } };
}

interface RawLhVolume {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly size?: string | number };
  readonly status?: {
    readonly kubernetesStatus?: { readonly pvName?: string; readonly namespace?: string; readonly pvcName?: string };
    readonly robustness?: string;
  };
}

interface RawLhSnapshot {
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly volume?: string };
  readonly status?: {
    readonly creationTime?: string;
    readonly size?: string | number;
    readonly readyToUse?: boolean;
    readonly markRemoved?: boolean;
    readonly userCreated?: boolean;
  };
}

interface RawLhRecurringJob {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly task?: string; readonly cron?: string; readonly retain?: number; readonly groups?: readonly string[] };
}

function parseQuantityBytes(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  // Longhorn sometimes returns sizes as raw numbers (e.g. snapshot.status.size)
  // and sometimes as quantity strings (e.g. pvc.status.capacity.storage = "10Gi").
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const s = String(value);
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const mul: Record<string, number> = {
    '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return Math.round(num * (mul[unit] ?? 1));
}

const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';

/**
 * Determine which Longhorn RecurringJob names apply to a Longhorn volume,
 * by matching its labels against `recurring-job.longhorn.io/<name>` (direct)
 * or `recurring-job-group.longhorn.io/<group>` (group membership) and
 * resolving group → jobs through the RecurringJob.spec.groups field.
 */
function resolveRecurringJobsForVolume(
  volumeLabels: Record<string, string>,
  jobs: readonly RawLhRecurringJob[],
): readonly string[] {
  const direct = new Set<string>();
  const groups = new Set<string>();
  for (const [k, v] of Object.entries(volumeLabels ?? {})) {
    if (v !== 'enabled') continue;
    if (k.startsWith('recurring-job.longhorn.io/')) direct.add(k.split('/')[1]);
    else if (k.startsWith('recurring-job-group.longhorn.io/')) groups.add(k.split('/')[1]);
  }
  const applied = new Set<string>();
  for (const j of jobs) {
    const name = j.metadata?.name;
    if (!name) continue;
    if (direct.has(name)) {
      applied.add(name);
      continue;
    }
    for (const g of j.spec?.groups ?? []) {
      if (groups.has(g)) {
        applied.add(name);
        break;
      }
    }
  }
  return Array.from(applied).sort();
}

export async function listSystemPvcSnapshots(k8s: K8sClients): Promise<readonly SystemPvcSnapshotSummary[]> {
  // Fan out the K8s LIST calls in parallel — same pattern as the
  // orphan classifier. PVC list is per-namespace; volumes/snapshots/
  // recurring-jobs all live in longhorn-system.
  const [pvcResults, volResp, snapResp, jobResp] = await Promise.all([
    Promise.all(SYSTEM_NAMESPACES.map((ns) =>
      k8s.core.listNamespacedPersistentVolumeClaim({ namespace: ns })
        .catch(() => ({ items: [] }))
        .then((r) => ({ ns, items: (r as { items?: readonly RawPvc[] }).items ?? [] })),
    )),
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhVolume[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhSnapshot[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhRecurringJob[] }>,
  ]);

  const volByName = new Map<string, RawLhVolume>();
  for (const v of volResp.items ?? []) {
    if (v.metadata?.name) volByName.set(v.metadata.name, v);
  }
  const snapsByVolume = new Map<string, RawLhSnapshot[]>();
  for (const s of snapResp.items ?? []) {
    const v = s.spec?.volume;
    if (!v) continue;
    const arr = snapsByVolume.get(v) ?? [];
    arr.push(s);
    snapsByVolume.set(v, arr);
  }
  const jobs = jobResp.items ?? [];

  const result: SystemPvcSnapshotSummary[] = [];
  for (const { ns, items } of pvcResults) {
    for (const pvc of items) {
      const pvcName = pvc.metadata?.name ?? '';
      const volName = pvc.spec?.volumeName ?? '';
      if (!pvcName || !volName) continue;
      const vol = volByName.get(volName);
      const volSize = parseQuantityBytes(pvc.status?.capacity?.storage)
        || parseQuantityBytes(vol?.spec?.size);
      const volSnaps = snapsByVolume.get(volName) ?? [];
      const usable = volSnaps.filter((s) => !s.status?.markRemoved);
      const snapshotCount = usable.length;
      let snapshotBytesTotal = 0;
      let oldestSnap: string | null = null;
      let newestSnap: string | null = null;
      for (const s of usable) {
        snapshotBytesTotal += parseQuantityBytes(s.status?.size);
        const t = s.status?.creationTime ?? s.metadata?.creationTimestamp ?? null;
        if (t) {
          if (!oldestSnap || t < oldestSnap) oldestSnap = t;
          if (!newestSnap || t > newestSnap) newestSnap = t;
        }
      }
      const labels = vol?.metadata?.labels ?? pvc.metadata?.labels ?? {};
      const recurringJobs = resolveRecurringJobsForVolume(labels, jobs);
      result.push({
        namespace: ns,
        pvcName,
        longhornVolumeName: volName,
        volumeSizeBytes: volSize,
        snapshotCount,
        snapshotBytesTotal,
        oldestSnapshotAt: oldestSnap,
        newestSnapshotAt: newestSnap,
        recurringJobs,
        degraded: vol?.status?.robustness === 'degraded',
      });
    }
  }
  result.sort((a, b) => b.snapshotBytesTotal - a.snapshotBytesTotal);
  return result;
}

export async function listSnapshotsForVolume(
  k8s: K8sClients,
  volumeName: string,
): Promise<readonly SystemSnapshotEntry[]> {
  const resp = await k8s.custom.listNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
  } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: readonly RawLhSnapshot[] };
  const out: SystemSnapshotEntry[] = [];
  for (const s of resp.items ?? []) {
    if (s.spec?.volume !== volumeName) continue;
    out.push({
      snapshotName: s.metadata?.name ?? '',
      volumeName,
      createdAt: s.status?.creationTime ?? s.metadata?.creationTimestamp ?? null,
      sizeBytes: parseQuantityBytes(s.status?.size),
      usable: s.status?.readyToUse === true,
      userLabel: s.metadata?.labels?.['platform.phoenix-host.net/user-label'] ?? null,
      markedForRemoval: s.status?.markRemoved === true,
    });
  }
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return out;
}

/**
 * Delete one Longhorn snapshot, asserting it belongs to `expectedVolume`
 * before issuing the destructive call. This prevents an admin from
 * deleting a tenant snapshot via the system-snapshots route by guessing
 * the snapshot name — every Longhorn snapshot CR shares the same
 * `longhorn-system` namespace regardless of which volume owns it.
 */
export async function deleteSnapshot(
  k8s: K8sClients,
  expectedVolume: string,
  snapshotName: string,
): Promise<void> {
  let snap: { spec?: { volume?: string } } | null = null;
  try {
    snap = await k8s.custom.getNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
      name: snapshotName,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { spec?: { volume?: string } };
  } catch (err) {
    const status = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      const e = new Error(`Snapshot '${snapshotName}' not found`);
      (e as Error & { code?: number }).code = 404;
      throw e;
    }
    throw err;
  }
  if (snap.spec?.volume !== expectedVolume) {
    const e = new Error(`Snapshot '${snapshotName}' belongs to volume '${snap.spec?.volume}', not '${expectedVolume}'`);
    (e as Error & { code?: number }).code = 409;
    throw e;
  }
  await k8s.custom.deleteNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    name: snapshotName,
  } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
}

/**
 * Mass-prune: delete every snapshot for one volume EXCEPT the N most
 * recent (configurable; default 1 = keep most recent only). The keep
 * count avoids the user accidentally pruning to zero recovery points.
 *
 * Returns the list of deleted snapshot names.
 */
export async function pruneVolumeSnapshots(
  k8s: K8sClients,
  volumeName: string,
  keepNewest: number = 1,
): Promise<{ readonly deleted: readonly string[]; readonly kept: readonly string[] }> {
  const snaps = await listSnapshotsForVolume(k8s, volumeName);
  const sorted = [...snaps].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const kept = sorted.slice(0, Math.max(0, keepNewest)).map((s) => s.snapshotName);
  const toDelete = sorted.slice(Math.max(0, keepNewest));
  const deleted: string[] = [];
  for (const s of toDelete) {
    try {
      // listSnapshotsForVolume already filtered to volumeName, so the
      // ownership check inside deleteSnapshot is redundant here but
      // costs one extra GET — acceptable for a manual prune action.
      await deleteSnapshot(k8s, volumeName, s.snapshotName);
      deleted.push(s.snapshotName);
    } catch (err) {
      console.warn(`[system-snapshots] delete ${s.snapshotName} failed:`, (err as Error).message);
    }
  }
  return { deleted, kept };
}

export async function takeSnapshot(
  k8s: K8sClients,
  volumeName: string,
  userLabel: string | undefined,
): Promise<{ readonly snapshotName: string }> {
  const snapshotName = `manual-${Date.now()}-${volumeName.slice(0, 24)}`;
  const labels: Record<string, string> = {};
  if (userLabel && userLabel.length <= 63) {
    labels['platform.phoenix-host.net/user-label'] = userLabel.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 63);
  }
  await k8s.custom.createNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    body: {
      apiVersion: `${LH_GROUP}/${LH_VERSION}`,
      kind: 'Snapshot',
      metadata: { name: snapshotName, namespace: LH_NS, labels },
      spec: { volume: volumeName, createSnapshot: true },
    },
  } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
  return { snapshotName };
}

/**
 * Restore-from-snapshot pattern (Longhorn): create a new volume from the
 * snapshot's underlying backing image. We expose this as
 *   POST /api/v1/admin/system-snapshots/:vol/snapshots/:snap/restore
 *
 * which kicks off Longhorn's `revertSnapshot` action — it stops the volume
 * frontend, reverts the live head to the snapshot, and re-attaches.
 *
 * Note: the volume MUST be detached during the revert. The caller is
 * responsible for scaling down the consumer (e.g. CNPG cluster, Stalwart
 * StatefulSet) before invoking this. We surface a 409 if Longhorn refuses.
 */
export async function revertSnapshot(
  k8s: K8sClients,
  volumeName: string,
  snapshotName: string,
): Promise<void> {
  // Longhorn exposes the revert action via the manager's REST API
  // rather than a CRD verb. The mainstream way from k8s is to patch
  // the Volume CR with `spec.frontendVolumeAttached: false` and then
  // create a `volumes.longhorn.io/<vol>/action/snapshotRevert` request
  // — which the Longhorn manager polls. Simpler path: write a Snapshot
  // CR with `restoreVolumeRecurringJob` semantics is NOT what we want
  // (that's for backups). The correct in-cluster path is to PATCH the
  // Volume's `spec.standby`/manager triggers, which is brittle.
  //
  // Pragmatic alternative we use: emit a Longhorn `support-bundles` or
  // direct manager REST call via in-cluster Service. For now this
  // implementation refuses the revert and surfaces a clear error so the
  // operator falls back to the Longhorn UI for in-place revert; the
  // delete + take buttons cover 95% of operator needs.
  void k8s;
  void volumeName;
  void snapshotName;
  throw new Error(
    'In-place snapshot revert is not yet wired to the Longhorn manager. '
    + 'Use the Longhorn UI restore action, or create a backup and restore from '
    + 'the backup CR (already supported in storage-lifecycle).',
  );
}

// ─── Recurring job retention policy ──────────────────────────────────

export async function listRecurringJobs(k8s: K8sClients): Promise<readonly RecurringJobPolicy[]> {
  const resp = await k8s.custom.listNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs',
  } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: readonly RawLhRecurringJob[] };
  const out: RecurringJobPolicy[] = [];
  for (const j of resp.items ?? []) {
    const task = j.spec?.task === 'backup' ? 'backup' : 'snapshot';
    out.push({
      jobName: j.metadata?.name ?? '',
      task,
      cron: j.spec?.cron ?? '',
      retain: j.spec?.retain ?? 0,
      groups: j.spec?.groups ?? [],
    });
  }
  return out;
}

export async function patchRecurringJob(
  k8s: K8sClients,
  jobName: string,
  patch: { readonly cron?: string; readonly retain?: number },
): Promise<void> {
  const body: Record<string, unknown> = { spec: {} };
  if (patch.cron !== undefined) (body.spec as Record<string, unknown>).cron = patch.cron;
  if (patch.retain !== undefined) (body.spec as Record<string, unknown>).retain = patch.retain;
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    { group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs', name: jobName, body },
    MERGE_PATCH,
  );
}
