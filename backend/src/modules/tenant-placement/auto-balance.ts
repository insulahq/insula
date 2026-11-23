/**
 * Longhorn replica auto-balance, kept off on volumes with one copy.
 *
 * The cluster setting is best-effort (scripts/bootstrap.sh): it re-spreads an
 * HA volume's copies when a server joins (ADR-031). A volume with one copy has
 * nothing to spread, and there it does harm. Auto-balance counts copies on
 * Ready nodes only, so while the node holding the only copy is NotReady — for
 * seconds is enough — it finds none and creates a copy on another node at
 * once; replica-replenishment-wait-interval does not apply to it (it waits
 * only for a failed copy to come back). Once the node is back, the new copy
 * is built from the old one and then deleted, because data locality keeps the
 * local one. In production a 4-second NotReady did this to every single-copy
 * volume on the node: two full copies of one tenant's 18 GB, and a copy of a
 * platform database volume, all thrown away. Upstream changed this only for a
 * restarting longhorn-manager (longhorn/longhorn#13941), not for a node that
 * drops out.
 *
 * So a volume with one copy whose auto-balance follows the cluster setting
 * ("ignored") is set to "disabled", with an annotation saying the platform did
 * it; a volume so marked that has more than one copy again (its tenant moved
 * to the HA tier) goes back to the cluster setting. A value set by hand — any
 * other, or "disabled" without the annotation — is left alone. Healing a
 * degraded volume is a separate Longhorn path and is not affected.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { VolumeFact } from '../tenant-health/service.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export const AUTO_BALANCE_ANNOTATION = 'insula.host/replica-auto-balance';
export const AUTO_BALANCE_SINGLE_COPY = 'off-single-copy';

export interface AutoBalanceChange {
  readonly volumeName: string;
  /** What spec.replicaAutoBalance becomes. */
  readonly mode: 'disabled' | 'ignored';
}

/** The volumes whose auto-balance is not what their copy count calls for. Pure. */
export function autoBalanceChanges(volumes: readonly VolumeFact[]): AutoBalanceChange[] {
  const out: AutoBalanceChange[] = [];
  for (const v of volumes) {
    const ab = v.autoBalance;
    if (!ab || ab.replicas === null) continue;
    // Longhorn writes "ignored" for a volume created without the parameter;
    // an empty value means the same.
    const followsCluster = ab.mode === null || ab.mode === 'ignored';
    if (ab.replicas === 1 && followsCluster) out.push({ volumeName: v.volumeName, mode: 'disabled' });
    else if (ab.replicas > 1 && ab.mode === 'disabled' && ab.setByPlatform) out.push({ volumeName: v.volumeName, mode: 'ignored' });
  }
  return out;
}

/** The merge patch for one change: the mode, and the annotation set or removed. Pure. */
export function autoBalancePatch(change: AutoBalanceChange): Record<string, unknown> {
  return {
    metadata: { annotations: { [AUTO_BALANCE_ANNOTATION]: change.mode === 'disabled' ? AUTO_BALANCE_SINGLE_COPY : null } },
    spec: { replicaAutoBalance: change.mode },
  };
}

export interface AutoBalanceResult {
  readonly applied: readonly AutoBalanceChange[];
  readonly failed: readonly { readonly volumeName: string; readonly error: string }[];
}

/** Apply each change; one volume failing does not stop the others. */
export async function applyAutoBalanceChanges(
  k8s: K8sClients,
  changes: readonly AutoBalanceChange[],
): Promise<AutoBalanceResult> {
  const applied: AutoBalanceChange[] = [];
  const failed: { volumeName: string; error: string }[] = [];
  for (const change of changes) {
    try {
      await k8s.custom.patchNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
        name: change.volumeName, body: autoBalancePatch(change),
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0], MERGE_PATCH);
      applied.push(change);
    } catch (err) {
      failed.push({ volumeName: change.volumeName, error: (err as Error).message ?? 'patch failed' });
    }
  }
  return { applied, failed };
}
