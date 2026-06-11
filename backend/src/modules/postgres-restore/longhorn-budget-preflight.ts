/**
 * Longhorn scheduling-budget preflight for PITR auto-promote (R17 item 3).
 *
 * Why this exists: the auto-promote flow deletes the source system-db
 * and recreates it from a VolumeSnapshot — Longhorn must schedule a
 * BRAND-NEW replica of the full volume size for the recovery clone.
 * Longhorn's scheduler budgets by SCHEDULED size, not used bytes:
 *   headroom(disk) = (storageMaximum − storageReserved)
 *                    × storage-over-provisioning-percentage / 100
 *                    − storageScheduled
 * Every prior PITR leaves the previous system-db PV Released with
 * reclaimPolicy=Retain (deliberate operator safety net), whose replica
 * keeps pinning the full volume size. On a small single node this
 * deterministically exhausts the budget on the SECOND restore: the
 * recovery volume fails Longhorn's "insufficient storage" precheck,
 * the snapshot-recovery pod sticks at Init/FailedAttachVolume, and the
 * orchestration stalls mid-cutover WITH SYSTEM-DB DOWN (reproduced
 * twice on testing, 2026-06-10/11).
 *
 * This preflight reproduces the same arithmetic BEFORE anything
 * destructive happens and fails fast with an actionable error naming
 * the reclaim candidates and the over-provisioning lever.
 *
 * Skip semantics: clusters without Longhorn (local DinD uses
 * local-path; other CSI drivers are legitimate) must not be blocked —
 * the check resolves the source PV's CSI driver first and SKIPS unless
 * it is Longhorn. Any read error also degrades to skip: the preflight
 * is a guard rail, not a new failure mode.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';
const LONGHORN_CSI_DRIVER = 'driver.longhorn.io';
const DEFAULT_OVER_PROVISIONING_PCT = 100;

export interface LonghornBudgetVerdict {
  readonly state: 'ok' | 'skipped' | 'insufficient';
  /** Human-readable summary for the step record / error message. */
  readonly detail: string;
  readonly neededBytes?: number;
  readonly bestDiskHeadroomBytes?: number;
  /** Released system-db PVs whose replicas pin reclaimable budget. */
  readonly reclaimCandidates?: ReadonlyArray<{ name: string; size: string }>;
}

/**
 * Parse a Kubernetes resource quantity (storage flavours only) into
 * bytes. Handles the binary suffixes Longhorn/CNPG actually emit
 * (Ki/Mi/Gi/Ti) plus bare byte integers. Returns null on anything
 * unrecognised — callers treat that as "cannot judge → skip".
 */
export function parseQuantityBytes(q: string | undefined | null): number | null {
  if (!q) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)?$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
  return Math.round(n * (m[2] ? mult[m[2]] : 1));
}

interface LonghornNodeShape {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly disks?: Record<string, { readonly storageReserved?: number; readonly allowScheduling?: boolean }>;
  };
  readonly status?: {
    readonly diskStatus?: Record<string, {
      readonly storageMaximum?: number;
      readonly storageScheduled?: number;
    }>;
  };
}

export async function checkLonghornBudgetForRecovery(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  opts: { readonly namespace: string; readonly pvcName: string },
): Promise<LonghornBudgetVerdict> {
  try {
    // 1. Source PVC → capacity + backing PV.
    const pvc = (await k8s.core.readNamespacedPersistentVolumeClaim({
      name: opts.pvcName,
      namespace: opts.namespace,
    } as unknown as Parameters<typeof k8s.core.readNamespacedPersistentVolumeClaim>[0])) as {
      spec?: { volumeName?: string };
      status?: { capacity?: { storage?: string } };
    };
    const volumeName = pvc.spec?.volumeName;
    const neededBytes = parseQuantityBytes(pvc.status?.capacity?.storage);
    if (!volumeName || neededBytes === null) {
      return { state: 'skipped', detail: 'source PVC has no bound volume / parseable capacity — cannot judge budget' };
    }

    // 2. Is the backing PV Longhorn? Anything else → not our problem.
    const pv = (await k8s.core.readPersistentVolume({
      name: volumeName,
    } as unknown as Parameters<typeof k8s.core.readPersistentVolume>[0])) as {
      spec?: { csi?: { driver?: string } };
    };
    if (pv.spec?.csi?.driver !== LONGHORN_CSI_DRIVER) {
      return { state: 'skipped', detail: `source PV driver is ${pv.spec?.csi?.driver ?? 'non-CSI'} — Longhorn budget check not applicable` };
    }

    // 3. Over-provisioning percentage (Longhorn setting; default 100).
    let pct = DEFAULT_OVER_PROVISIONING_PCT;
    try {
      const setting = (await k8s.custom.getNamespacedCustomObject({
        group: LH_GROUP, version: LH_VERSION, namespace: LH_NS,
        plural: 'settings', name: 'storage-over-provisioning-percentage',
      } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0])) as { value?: string };
      const parsed = Number(setting.value);
      if (Number.isFinite(parsed) && parsed > 0) pct = parsed;
    } catch { /* setting CR absent → keep the documented default */ }

    // 4. Per-disk headroom across nodes — the recovery replica needs ONE
    //    disk that fits it (replica count for system-db is 1 per disk).
    const nodeList = (await k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])) as {
      items?: LonghornNodeShape[];
    };
    let best = -Infinity;
    for (const node of nodeList.items ?? []) {
      const diskSpecs = node.spec?.disks ?? {};
      const diskStatus = node.status?.diskStatus ?? {};
      for (const [diskName, st] of Object.entries(diskStatus)) {
        const spec = diskSpecs[diskName];
        if (spec?.allowScheduling === false) continue;
        const max = st.storageMaximum ?? 0;
        const reserved = spec?.storageReserved ?? 0;
        const scheduled = st.storageScheduled ?? 0;
        const headroom = (max - reserved) * (pct / 100) - scheduled;
        if (headroom > best) best = headroom;
      }
    }
    if (!Number.isFinite(best)) {
      return { state: 'skipped', detail: 'no Longhorn node/disk status readable — cannot judge budget' };
    }

    if (best >= neededBytes) {
      return {
        state: 'ok',
        detail: `best disk headroom ${(best / 2 ** 30).toFixed(1)}Gi ≥ recovery volume ${(neededBytes / 2 ** 30).toFixed(1)}Gi (over-provisioning ${pct}%)`,
        neededBytes,
        bestDiskHeadroomBytes: best,
      };
    }

    // 5. Insufficient — name the reclaim candidates (Released system-db
    //    PVs from prior PITRs) so the error is directly actionable.
    let reclaimCandidates: Array<{ name: string; size: string }> = [];
    try {
      const pvList = (await k8s.core.listPersistentVolume(
        {} as unknown as Parameters<typeof k8s.core.listPersistentVolume>[0],
      )) as {
        items?: Array<{
          metadata?: { name?: string };
          status?: { phase?: string };
          spec?: { claimRef?: { namespace?: string; name?: string }; capacity?: { storage?: string } };
        }>;
      };
      reclaimCandidates = (pvList.items ?? [])
        .filter((p) =>
          p.status?.phase === 'Released' &&
          p.spec?.claimRef?.namespace === opts.namespace &&
          (p.spec?.claimRef?.name ?? '').startsWith('system-db'))
        .map((p) => ({ name: p.metadata?.name ?? '?', size: p.spec?.capacity?.storage ?? '?' }));
    } catch { /* candidates are advisory */ }

    const candidateNote = reclaimCandidates.length > 0
      ? ` Reclaimable: ${reclaimCandidates.map((c) => `${c.name} (${c.size}, Released pre-restore copy — delete the PV AND its volumes.longhorn.io CR once superseded)`).join('; ')}.`
      : '';
    return {
      state: 'insufficient',
      detail:
        `Longhorn cannot schedule the ${(neededBytes / 2 ** 30).toFixed(1)}Gi recovery volume: ` +
        `best disk headroom is ${(Math.max(best, 0) / 2 ** 30).toFixed(1)}Gi at over-provisioning ${pct}%. ` +
        `Starting the restore now would stall mid-cutover with the database DOWN ` +
        `(snapshot-recovery pod Init/FailedAttachVolume).${candidateNote} ` +
        `Alternatively raise the Longhorn storage-over-provisioning-percentage setting temporarily.`,
      neededBytes,
      bestDiskHeadroomBytes: Math.max(best, 0),
      reclaimCandidates,
    };
  } catch (err) {
    // Guard rail, not a failure mode: unreadable cluster state must not
    // block a restore that might well succeed.
    return {
      state: 'skipped',
      detail: `budget preflight unreadable (${err instanceof Error ? err.message : String(err)}) — proceeding without it`,
    };
  }
}
