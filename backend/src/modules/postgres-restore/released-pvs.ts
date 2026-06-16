/**
 * Superseded Released system-db PVs — operator surface (R17 item 3).
 *
 * Every PITR auto-promote leaves the PREVIOUS system-db PV `Released`
 * with reclaimPolicy=Retain. That is a deliberate safety net (the last
 * pre-restore copy of the platform DB), but the Longhorn replica behind
 * it keeps pinning the FULL volume size of scheduling budget — on a
 * small single node one retained copy is enough to make the NEXT PITR
 * fail its budget preflight (see longhorn-budget-preflight.ts), and
 * without the preflight it would stall mid-cutover with system-db down.
 *
 * This module lists those PVs and reclaims them on explicit,
 * name-confirmed operator action. Reclaim deletes BOTH the PV object
 * AND the volumes.longhorn.io CR — deleting only the PV leaves the
 * Longhorn volume (and its budget pin) behind.
 *
 * Safety model:
 *   - List/reclaim filter is strict: phase=Released AND
 *     claimRef platform/system-db-* — nothing else is ever listed or
 *     deletable through this surface.
 *   - The reclaim handler re-reads and re-verifies the PV against the
 *     filter at delete time (no delete-by-name of arbitrary PVs).
 *   - Type-to-confirm with the PV name, mirroring the other
 *     destructive admin surfaces.
 */

import type { SupersededSystemPv, ReclaimReleasedPvResponse } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';

const SYSTEM_NAMESPACE = 'platform';
const SYSTEM_CLAIM_PREFIX = 'system-db';
const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';

interface PvShape {
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: string | Date };
  readonly status?: { readonly phase?: string };
  readonly spec?: {
    readonly claimRef?: { readonly namespace?: string; readonly name?: string };
    readonly capacity?: { readonly storage?: string };
    readonly storageClassName?: string;
  };
}

function isSupersededSystemPv(pv: PvShape): boolean {
  return (
    pv.status?.phase === 'Released' &&
    pv.spec?.claimRef?.namespace === SYSTEM_NAMESPACE &&
    (pv.spec?.claimRef?.name ?? '').startsWith(SYSTEM_CLAIM_PREFIX)
  );
}

export async function listSupersededSystemPvs(
  k8s: Pick<K8sClients, 'core'>,
): Promise<ReadonlyArray<SupersededSystemPv>> {
  const pvList = (await k8s.core.listPersistentVolume(
    {} as unknown as Parameters<typeof k8s.core.listPersistentVolume>[0],
  )) as { items?: PvShape[] };
  return (pvList.items ?? [])
    .filter(isSupersededSystemPv)
    .map((pv) => ({
      name: pv.metadata?.name ?? '?',
      claimName: pv.spec?.claimRef?.name ?? '?',
      size: pv.spec?.capacity?.storage ?? '?',
      createdAt: pv.metadata?.creationTimestamp
        ? new Date(pv.metadata.creationTimestamp).toISOString()
        : null,
      storageClassName: pv.spec?.storageClassName ?? null,
    }));
}

export async function reclaimSupersededSystemPv(
  k8s: Pick<K8sClients, 'core' | 'custom'>,
  pvName: string,
  confirmName: string,
): Promise<ReclaimReleasedPvResponse> {
  if (confirmName.trim() !== pvName) {
    throw new ApiError(
      'CONFIRM_NAME_MISMATCH',
      `Confirmation token did not match. Expected '${pvName}'.`,
      400,
    );
  }

  // Re-read and re-verify against the strict filter — this endpoint
  // must never become a generic delete-PV-by-name primitive.
  let pv: PvShape;
  try {
    pv = (await k8s.core.readPersistentVolume({
      name: pvName,
    } as unknown as Parameters<typeof k8s.core.readPersistentVolume>[0])) as PvShape;
  } catch {
    throw new ApiError('PV_NOT_FOUND', `PersistentVolume '${pvName}' not found`, 404);
  }
  if (!isSupersededSystemPv(pv)) {
    throw new ApiError(
      'PV_NOT_RECLAIMABLE',
      `PersistentVolume '${pvName}' is not a Released ${SYSTEM_NAMESPACE}/${SYSTEM_CLAIM_PREFIX}-* volume — ` +
      `only superseded pre-restore system-db copies are reclaimable through this surface ` +
      `(live phase=${pv.status?.phase ?? '?'}, claim=${pv.spec?.claimRef?.namespace ?? '?'}/${pv.spec?.claimRef?.name ?? '?'})`,
      409,
    );
  }

  await k8s.core.deletePersistentVolume({
    name: pvName,
  } as unknown as Parameters<typeof k8s.core.deletePersistentVolume>[0]);

  // The Longhorn volume CR shares the PV name. Best-effort: on
  // non-Longhorn storage (local-path DinD) the CR simply doesn't exist.
  let longhornVolumeDeleted = false;
  try {
    await k8s.custom.deleteNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS,
      plural: 'volumes', name: pvName,
    } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
    longhornVolumeDeleted = true;
  } catch { /* absent on non-Longhorn storage — the PV delete is the contract */ }

  return { pvDeleted: true, longhornVolumeDeleted };
}
