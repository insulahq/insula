/**
 * Canonical labels for platform-managed PVCs (and the PVs they bind to).
 *
 * Problem
 * ───────
 * Kubernetes' CSI external-provisioner names every dynamically-provisioned
 * PV `pvc-<pvc.metadata.uid>` — an opaque UUID. `kubectl get pv` and the
 * Longhorn UI show those UUIDs and operators can't tell what's what.
 * Static provisioning would let us choose PV names, but that defeats
 * dynamic provisioning entirely.
 *
 * Solution
 * ────────
 * Stamp every platform-managed PVC with a small, predictable label set.
 * A reconciler (see modules/storage-policy-pvc-pv-mirror) then mirrors
 * the labels onto the bound PV at steady state, so:
 *
 *   kubectl get pv -L platform/role,platform/owner,platform/canonical-name
 *
 * shows meaningful columns next to the UUID. Same labels are queryable in
 * Longhorn's volume detail page and via the Labels filter.
 *
 * Labels
 * ──────
 * - platform/role           required — what kind of PVC this is
 * - platform/owner          required — who owns it (system | tenant-<id8> | mail).
 *                           NB: `:` is invalid in K8s label values — separator
 *                           is `-`, not `:`. The string still parses two-fold
 *                           (`tenant-` prefix + 8-hex id) for filtering.
 * - platform/canonical-name optional — the PVC name for self-describing
 *                           filters; omit for CNPG-instance PVCs that
 *                           inherit one set of labels but have per-instance
 *                           names
 * - platform/managed-by     always 'platform-api' — marker the reconciler
 *                           uses to ignore PVCs we don't manage
 */

export const CANONICAL_LABEL_KEYS = {
  role: 'platform/role',
  owner: 'platform/owner',
  canonicalName: 'platform/canonical-name',
  managedBy: 'platform/managed-by',
} as const;

export const PLATFORM_API_MANAGER = 'platform-api';

export type PvcRole =
  | 'system-db'
  | 'mail-db'
  | 'tenant-storage'
  | 'mail-blob-store';

export interface CanonicalLabelInput {
  readonly role: PvcRole;
  /** 'system' | 'mail' | `tenant-${shortId}` */
  readonly owner: string;
  /** Omit for CNPG-instance PVCs (system-db-1/2/3 share one label set). */
  readonly canonicalName?: string;
}

export function buildCanonicalLabels(
  input: CanonicalLabelInput,
): Record<string, string> {
  const out: Record<string, string> = {
    [CANONICAL_LABEL_KEYS.role]: input.role,
    [CANONICAL_LABEL_KEYS.owner]: input.owner,
    [CANONICAL_LABEL_KEYS.managedBy]: PLATFORM_API_MANAGER,
  };
  if (input.canonicalName !== undefined) {
    out[CANONICAL_LABEL_KEYS.canonicalName] = input.canonicalName;
  }
  return out;
}

/**
 * `tenant-abc12345` — first 8 hex chars of the tenant UUID. Stable per
 * tenant; matches the convention `<namespace>-storage` uses for the
 * tenant namespace name (`tenant-<slug>-<8chars>`).
 *
 * NB: separator is `-` not `:` because K8s rejects `:` in label values
 * with HTTP 422 (regex `^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$`).
 */
export function tenantOwnerLabel(tenantUuid: string): string {
  return `tenant-${tenantUuid.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Build the canonical label set for a tenant tenant-storage PVC.
 * Used at PVC creation and at destructive-resize PVC recreate.
 */
export function tenantStoragePvcLabels(
  tenantUuid: string,
  namespace: string,
): Record<string, string> {
  return buildCanonicalLabels({
    role: 'tenant-storage',
    owner: tenantOwnerLabel(tenantUuid),
    canonicalName: `${namespace}-storage`,
  });
}

/**
 * Same as `tenantStoragePvcLabels` but derives the owner short-id from
 * the namespace itself. Tenant namespaces follow the canonical form
 * `tenant-<slug>-<8hex>` (see k8s-provisioner.namespaceFor); the trailing
 * 8 hex chars are the shortened tenant UUID. Used at call sites that
 * have only the namespace string in scope (applyPVC, applyPVCMib).
 */
export function tenantStoragePvcLabelsFromNamespace(
  namespace: string,
): Record<string, string> {
  const match = namespace.match(/-([0-9a-f]{8})$/);
  const shortId = match ? match[1] : 'unknown';
  return buildCanonicalLabels({
    role: 'tenant-storage',
    owner: `tenant-${shortId}`,
    canonicalName: `${namespace}-storage`,
  });
}
