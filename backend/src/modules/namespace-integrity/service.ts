import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, hostingPlans, notifications, users } from '../../db/schema.js';
import {
  applyNamespace,
  applyResourceQuota,
  applyNetworkPolicy,
  applyPVC,
} from '../k8s-provisioner/service.js';

// Issue 1 fix: a namespace can lose its tenant PVC / ResourceQuota /
// NetworkPolicies after a cluster rebootstrap (sqlite→etcd, DR
// restore, etc.) while tenants.provisioning_status stays
// "provisioned". The lifecycle module recreates the namespace +
// file-manager but not these other resources, leaving deployments
// stuck in pending forever.
//
// This module audits a single tenant (or the full fleet) for missing
// resources and repairs the gap.

export type { IntegrityFinding, NamespaceIntegrityReport, QuotaComparison } from '@insula/api-contracts';
import type { IntegrityFinding, NamespaceIntegrityReport, QuotaComparison } from '@insula/api-contracts';
import { compareK8sQuantities, formatGiBQuantity, parseK8sQuantity } from '../../shared/k8s-quantity.js';

const REQUIRED_NETPOLS = ['default-deny-ingress', 'allow-intra-namespace'] as const;

async function exists(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) return false;
    throw err;
  }
}

/** Effective plan limits, as the tenant's subscription expresses them. */
export interface SubscriptionLimits {
  /** GiB */ readonly storageGi: number;
  /** cores */ readonly cpuCores: number;
  /** GiB */ readonly memoryGi: number;
}

/** The live cluster side of the comparison. */
export interface ClusterState {
  /** Merged `status.hard` across EVERY ResourceQuota in the namespace. */
  readonly hard: Record<string, string>;
  /** Merged `status.used`. */
  readonly used: Record<string, string>;
  /** The tenant PVC's requested size, e.g. `2Gi`. Null if absent/unreadable. */
  readonly pvcRequest: string | null;
  /** False when nothing could be read — the caller must not render "healthy". */
  readonly readable: boolean;
}

/**
 * Read every ResourceQuota in the namespace plus the tenant PVC.
 *
 * MUST list rather than read one name. `applyResourceQuota` deliberately
 * writes TWO objects (k8s rejects a scoped quota that carries
 * `requests.storage`, so pod resources and storage are split):
 *
 *   <ns>-quota          scoped   requests.cpu, requests.memory, limits.memory
 *   <ns>-storage-quota  unscoped requests.storage
 *
 * An earlier revision of this function read only `<ns>-quota` and would have
 * missed the storage case entirely — which is the case this whole feature
 * exists for.
 *
 * Reads `status.hard`, not `spec.hard`: the status copy is what the quota
 * controller is actually enforcing. They differ until a quota edit is
 * observed, and enforcement is what the operator needs to see.
 */
export async function readClusterState(k8s: K8sClients, namespace: string): Promise<ClusterState> {
  const hard: Record<string, string> = {};
  const used: Record<string, string> = {};
  let readable = false;

  try {
    const list = await (k8s.core as unknown as {
      listNamespacedResourceQuota: (a: { namespace: string }) => Promise<{
        items?: Array<{ status?: { hard?: Record<string, string>; used?: Record<string, string> } }>;
      }>;
    }).listNamespacedResourceQuota({ namespace });
    for (const q of list.items ?? []) {
      Object.assign(hard, q.status?.hard ?? {});
      Object.assign(used, q.status?.used ?? {});
    }
    readable = true;
  } catch {
    // leave readable=false
  }

  let pvcRequest: string | null = null;
  try {
    const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({
      name: `${namespace}-storage`,
      namespace,
    }) as { spec?: { resources?: { requests?: Record<string, string> } } };
    pvcRequest = pvc.spec?.resources?.requests?.storage ?? null;
  } catch {
    // `pvc_missing` already covers this.
  }

  return { hard, used, pvcRequest, readable };
}

/**
 * Compare each resource across subscription / enforced quota / what actually
 * exists.
 *
 * The headline column is `provisioned`. A plan change does not shrink anything
 * the tenant already holds, so a tenant moved down to a 512 MiB plan keeps its
 * 2 GiB volume — and every existing screen hides that, because the tenant panel
 * reports bytes WRITTEN (79 MB) against the plan (512 MiB) and the admin panel
 * showed the plan values from the DB. Production 2026-09-03.
 */
export function compareSubscriptionToCluster(
  limits: SubscriptionLimits,
  cluster: ClusterState,
): QuotaComparison[] {
  if (!cluster.readable) return [];

  const BYTES_PER_GI = 1024 ** 3;

  // `subscription` is a DISPLAY string and `exact` is the value to COMPARE
  // against. They must stay separate: formatGiBQuantity rounds to one decimal
  // so a plan reads as "10.2Mi" rather than "10.24Mi", and comparing through
  // that rounding mis-judges 170 of the 200 two-decimal GiB values a
  // numeric(10,2) plan column can hold — about half of them as FALSE
  // POSITIVES, flagging a volume that exactly matches its plan as over it.
  // Every storage plan currently in production (0.5/1/2/5/100 GiB) happens to
  // land on a clean binary boundary, which is precisely why a check against
  // live data came back clean and did not catch this.
  const rows: Array<{
    resource: QuotaComparison['resource'];
    label: string;
    subscription: string;
    /** Exact value in the resource's base unit — bytes, or cores for CPU. */
    exact: number;
    quotaKey: string;
    provisioned: string | null;
  }> = [
    {
      resource: 'storage',
      label: 'Storage',
      subscription: formatGiBQuantity(limits.storageGi),
      exact: limits.storageGi * BYTES_PER_GI,
      quotaKey: 'requests.storage',
      // The PVC request IS the provisioned size — the quota counts what a
      // volume ASKED for, not what has been written into it.
      provisioned: cluster.pvcRequest,
    },
    {
      resource: 'cpu',
      label: 'CPU',
      subscription: String(limits.cpuCores),
      exact: limits.cpuCores,
      quotaKey: 'requests.cpu',
      // No standing "provisioned" figure: CPU is consumed by pods, which come
      // and go, and that is exactly what the quota's own `used` tracks.
      provisioned: null,
    },
    {
      resource: 'memory',
      label: 'Memory',
      subscription: formatGiBQuantity(limits.memoryGi),
      exact: limits.memoryGi * BYTES_PER_GI,
      quotaKey: 'limits.memory',
      provisioned: null,
    },
  ];

  /**
   * Compare a cluster quantity against the exact subscription value.
   * Returns null when unparseable — the caller must treat that as "unknown",
   * never as "within limits".
   *
   * Both sides are floats derived from binary multiplications, so an exact
   * `===` would call 1Gi and 1.00Gi different on some inputs. A relative
   * epsilon of 1e-9 is far tighter than any real quota difference (the
   * smallest meaningful storage step is a byte, ~1e-9 of a GiB) while
   * absorbing representation noise.
   */
  const cmpToExact = (value: string | null, exact: number): number | null => {
    if (value === null) return null;
    const v = parseK8sQuantity(value);
    if (v === null) return null;
    const tolerance = Math.max(Math.abs(exact), Math.abs(v)) * 1e-9;
    if (Math.abs(v - exact) <= tolerance) return 0;
    return v < exact ? -1 : 1;
  };

  return rows.map((r) => {
    const enforced = cluster.hard[r.quotaKey] ?? null;
    const usedVal = cluster.used[r.quotaKey] ?? null;

    const exceeds = cmpToExact(r.provisioned, r.exact);
    const differs = cmpToExact(enforced, r.exact);
    // used-vs-hard is a like-for-like cluster comparison, so it stays on the
    // string comparator — no subscription rounding is involved.
    const overQuota = enforced !== null && usedVal !== null
      ? compareK8sQuantities(usedVal, enforced)
      : null;

    return {
      resource: r.resource,
      label: r.label,
      subscription: r.subscription,
      enforced,
      provisioned: r.provisioned,
      exceedsSubscription: exceeds !== null && exceeds > 0,
      enforcedDiffers: differs !== null && differs !== 0,
      blocked: overQuota !== null && overQuota > 0,
    };
  });
}

async function inspect(
  k8s: K8sClients,
  namespace: string,
  limits: SubscriptionLimits,
): Promise<{ findings: IntegrityFinding[]; quota: QuotaComparison[] }> {
  const findings: IntegrityFinding[] = [];

  if (!(await exists(() => k8s.core.readNamespace({ name: namespace })))) {
    findings.push('namespace_missing');
    // No point checking children if the parent is gone.
    return { findings, quota: [] };
  }

  if (!(await exists(() =>
    k8s.core.readNamespacedPersistentVolumeClaim({
      name: `${namespace}-storage`,
      namespace,
    })))) {
    findings.push('pvc_missing');
  }

  if (!(await exists(() =>
    k8s.core.readNamespacedResourceQuota({
      name: `${namespace}-quota`,
      namespace,
    })))) {
    findings.push('resource_quota_missing');
  }

  for (const np of REQUIRED_NETPOLS) {
    if (!(await exists(() =>
      k8s.networking.readNamespacedNetworkPolicy({ name: np, namespace })))) {
      findings.push('network_policy_missing');
      break; // single signal — the repair recreates both anyway
    }
  }

  // Subscription-vs-cluster comparison. Two findings, neither auto-repairable
  // — the reconciler recreates MISSING objects, and both of these are objects
  // that exist and are the wrong size.
  //
  // Production 2026-09-03: a tenant was moved to a 512 MiB storage plan while
  // holding a 2 GiB PVC that was never shrunk. Every screen hid it — the
  // tenant panel reports bytes WRITTEN against the plan ("78.8 MB of 512Mi"),
  // and the admin panel showed the plan values straight from the DB. The only
  // symptom was new volumes in that namespace being silently refused.
  const quota = compareSubscriptionToCluster(limits, await readClusterState(k8s, namespace));
  if (quota.some((q) => q.exceedsSubscription)) {
    findings.push('provisioned_exceeds_plan');
  }
  if (quota.some((q) => q.blocked)) {
    findings.push('resource_quota_exceeded');
  }

  return { findings, quota };
}

/**
 * Audit + optionally repair a single tenant's namespace. `repair=false`
 * is the read-only audit used by the UI. `repair=true` is the
 * "Run reconciler" admin action and the cron-driven sweep.
 */
export async function checkTenantNamespaceIntegrity(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  repair: boolean,
): Promise<NamespaceIntegrityReport> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }
  if (tenant.provisioningStatus !== 'provisioned') {
    return {
      tenantId,
      name: tenant.name,
      namespace: tenant.kubernetesNamespace,
      findings: [],
      repaired: [],
      errors: [],
      quota: [],
    };
  }

  // The plan is now needed BEFORE inspect() — the subscription-vs-cluster
  // comparison is the point of the audit, and the effective limit is the
  // tenant's per-resource override falling back to the plan (same resolution
  // the quota reconciler and provisioner use).
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)).limit(1);
  const limits: SubscriptionLimits = {
    storageGi: Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 0),
    cpuCores: Number(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? 0),
    memoryGi: Number(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? 0),
  };

  const { findings, quota } = await inspect(k8s, tenant.kubernetesNamespace, limits);
  if (findings.length === 0 || !repair) {
    return {
      tenantId,
      name: tenant.name,
      namespace: tenant.kubernetesNamespace,
      findings,
      repaired: [],
      errors: [],
      quota,
    };
  }

  // Unified tenant SC; tier is encoded as Volume.spec.numberOfReplicas
  // and patched live by applyTenantTier rather than baked into the SC.
  const storageClass = 'longhorn-tenant';

  const repaired: IntegrityFinding[] = [];
  const errors: string[] = [];
  const ns = tenant.kubernetesNamespace;

  // Repair each missing resource. Order matters: namespace first, then
  // PVC + RQ + NetPol (can be parallel but the failure mode is clearer
  // serial).
  if (findings.includes('namespace_missing')) {
    try {
      // Mirror the provisionTenant PSA-label logic: read the cluster's
      // `allow_host_ports_*` toggles so the recreated namespace matches
      // what a fresh provisioning call would produce. Without this, a
      // recovered namespace would always land at PSA=baseline even on
      // host-ports-enabled clusters, and any hostPort deployment would
      // re-fail until the next routine applyNamespace touch.
      const { getSettings } = await import('../system-settings/service.js');
      const settings = await getSettings(db).catch(() => null);
      const allowHostPorts = !!(settings?.allowHostPortsServer || settings?.allowHostPortsWorker);
      await applyNamespace(k8s, ns, tenantId, { allowHostPorts });
      repaired.push('namespace_missing');
    } catch (err) {
      errors.push(`namespace_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('pvc_missing')) {
    try {
      const sharedPvcSize = Math.min(10, Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 10));
      await applyPVC(k8s, ns, String(sharedPvcSize), storageClass);
      repaired.push('pvc_missing');
    } catch (err) {
      errors.push(`pvc_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('resource_quota_missing')) {
    try {
      const cpu = String(parseFloat(String(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? '2')));
      const memory = String(parseFloat(String(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? '4')));
      const storage = String(parseFloat(String(tenant.storageLimitOverride ?? plan?.storageLimit ?? '50')));
      await applyResourceQuota(k8s, ns, { cpu, memory, storage });
      repaired.push('resource_quota_missing');
    } catch (err) {
      errors.push(`resource_quota_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('network_policy_missing')) {
    try {
      await applyNetworkPolicy(k8s, ns);
      repaired.push('network_policy_missing');
    } catch (err) {
      errors.push(`network_policy_missing: ${(err as Error).message}`);
    }
  }

  // Surface findings to every admin-panel super_admin / admin so the
  // bell icon picks them up. notifications.user_id is per-recipient,
  // so we fan out one row per admin.
  if (repaired.length > 0 || errors.length > 0) {
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.roleName, ['super_admin', 'admin']));
    const title = errors.length > 0
      ? `Namespace integrity issues for '${tenant.name}'`
      : `Namespace integrity repaired for '${tenant.name}'`;
    const message = errors.length > 0
      ? `Auto-repair partially failed. Repaired: ${repaired.join(', ') || 'none'}. Errors: ${errors.join('; ')}`
      : `Auto-repaired missing resources: ${repaired.join(', ')}`;
    for (const a of adminRows) {
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: a.id,
        type: errors.length > 0 ? 'error' : 'success',
        title,
        message,
        resourceType: 'tenant',
        resourceId: tenantId,
      }).catch((err) => {
        console.error('[namespace-integrity] notification write failed:', (err as Error).message);
      });
    }
  }

  return {
    tenantId,
    name: tenant.name,
    namespace: ns,
    findings,
    repaired,
    errors,
    quota,
  };
}

/**
 * Cron-driven fleet sweep — audit every active provisioned tenant, repair
 * any gaps. Runs from the storage-lifecycle scheduler so it shares the
 * same k8s tenant + DB pool.
 */
export async function sweepFleetIntegrity(
  db: Database,
  k8s: K8sClients,
): Promise<{ readonly checked: number; readonly repaired: number; readonly errored: number }> {
  const provisioned = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.provisioningStatus, ['provisioned']));

  let repairedTotal = 0;
  let erroredTotal = 0;

  for (const c of provisioned) {
    try {
      const report = await checkTenantNamespaceIntegrity(db, k8s, c.id, true);
      if (report.repaired.length > 0) repairedTotal += 1;
      if (report.errors.length > 0) erroredTotal += 1;
    } catch (err) {
      erroredTotal += 1;
      console.error(`[namespace-integrity] sweep failed for ${c.id}:`, (err as Error).message);
    }
  }

  return { checked: provisioned.length, repaired: repairedTotal, errored: erroredTotal };
}
