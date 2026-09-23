import { isReplacedPodRecord } from '../../lib/container-termination.js';
import { getRedis } from '../../shared/redis.js';
import { effectivePodRequest, type PodSpecResourcesLike } from '../../shared/pod-resources.js';
import { parseResourceValue } from '../../shared/resource-parser.js';
import { queryInstant } from '../monitoring/vm-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

const CACHE_KEY_PREFIX = 'metrics:';
const CACHE_TTL = 7200; // 2 hours (auto-expire even if refresh fails)

export interface ResourceMetrics {
  /**
   * Did the Metrics API answer at all?
   *
   * `cpu.inUse`/`memory.inUse` are ZERO both when a tenant is idle and when
   * the metrics read failed, and the dashboard was inferring "unavailable"
   * from the zero. That inference was wrong on 23 of 27 production tenants:
   * metrics-server was answering, the tenants were simply using less than a
   * millicore. Consumers that need to tell the two apart must read this, not
   * test the number.
   */
  readonly usageMeasured: boolean;
  readonly tenantId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number }; // in Gi
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number }; // in Gi
  readonly lastUpdatedAt: string;
}

/**
 * Escape a value for use inside a PromQL double-quoted label matcher.
 * Namespaces are `[a-z0-9-]` in practice, so this is belt-and-braces against a
 * crafted namespace ever reaching the query string.
 */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Check if a pod/metrics entry is a system service (file-manager, etc.) */
function isSystemPod(labels: Record<string, string> | undefined): boolean {
  return labels?.['platform.io/system'] === 'true';
}

type PodMetricsItem = {
  readonly metadata?: { readonly labels?: Record<string, string> };
  readonly containers?: ReadonlyArray<{ readonly usage?: { readonly cpu?: string; readonly memory?: string } }>;
};

type PodItem = {
  readonly metadata?: {
    readonly labels?: Record<string, string>;
    readonly deletionTimestamp?: string;
  };
  /**
   * Pod-level status. Previously NOT modelled here at all, which is precisely
   * how the bug below survived: with no `status` field there was nothing to
   * filter on, and every dead pod looked exactly like a running one.
   */
  readonly status?: { readonly phase?: string; readonly reason?: string };
  /**
   * `initContainers` is modelled here for the same reason `status` was: with no
   * field there was nothing to read, and a pod fronted by an oversized init
   * container looked exactly like one that was not.
   */
  readonly spec?: PodSpecResourcesLike;
};

export async function collectTenantMetrics(
  _db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
  planLimits: { readonly cpuLimit: number; readonly memoryLimitGi: number; readonly storageLimitGi: number },
): Promise<ResourceMetrics> {
  // 1. Actual usage from Metrics API — exclude system pods
  let cpuInUse = 0;
  let memoryInUse = 0;
  let usageMeasured = true;

  try {
    const metricsResult = await k8s.custom.listNamespacedCustomObject({
      group: 'metrics.k8s.io',
      version: 'v1beta1',
      namespace,
      plural: 'pods',
    });

    const pods = (metricsResult as { items?: readonly PodMetricsItem[] }).items ?? [];

    for (const pod of pods) {
      if (isSystemPod(pod.metadata?.labels)) continue; // Skip file-manager etc.
      for (const container of pod.containers ?? []) {
        if (container.usage?.cpu) {
          cpuInUse += parseResourceValue(container.usage.cpu, 'cpu');
        }
        if (container.usage?.memory) {
          memoryInUse += parseResourceValue(container.usage.memory, 'memory');
        }
      }
    }
  } catch (err) {
    // NOT a zero reading. Leaving the counters at 0 and saying nothing is how
    // "no data" came to render as "idle" — and then, downstream, as
    // "unavailable" for every genuinely idle tenant too.
    usageMeasured = false;
    console.warn(`[metrics] Failed to get metrics for ${namespace}:`, err instanceof Error ? err.message : String(err));
  }

  // 2. Reserved (allocated) from actual pod specs — exclude system pods
  //    This is more accurate than ResourceQuota status.used which includes
  //    system services (file-manager) that shouldn't count against user quota.
  let cpuReserved = 0;
  let memoryReserved = 0;

  try {
    const podList = await k8s.core.listNamespacedPod({ namespace });
    const pods = (podList as { items?: readonly PodItem[] }).items ?? [];

    for (const pod of pods) {
      if (isSystemPod(pod.metadata?.labels)) continue; // Skip file-manager etc.
      // A terminal pod keeps its full spec forever — Kubernetes garbage-collects
      // terminal pods only past --terminated-pod-gc-threshold (default 12500),
      // so corpses sit beside the running workload for weeks. Summing their
      // requests reported memory that nothing is holding.
      //
      // Production, tenant PHOENIX: 3.594Gi of a 4Gi plan reported
      // "reserved" while the workload held 2.172Gi. The 1.422Gi gap was three
      // Succeeded pods from ONE graceful node shutdown at 12:30:18Z — exit 0,
      // reason Completed. Kubernetes' own ResourceQuota said 2224Mi (= 2.172Gi)
      // throughout, because quota excludes terminal pods. Ten tenants were
      // affected, 1.953Gi phantom in total.
      //
      // The in-use loop above needs no such guard: it reads metrics-server,
      // which only reports pods that are actually running.
      //
      // Same helper and same reason as the four scans fixed in PR #517. This
      // was the fifth, missed then.
      if (isReplacedPodRecord({
        phase: pod.status?.phase,
        reason: pod.status?.reason,
        deletionTimestamp: pod.metadata?.deletionTimestamp,
      })) continue;
      // The EFFECTIVE pod request, not the container sum. Init containers are
      // charged for the pod's whole life, so summing `spec.containers` reports
      // headroom the cluster will not honour — and this panel is what a tenant
      // reads before sizing the next deploy.
      // See shared/pod-resources.ts for the rule and the sidecar case.
      cpuReserved += effectivePodRequest(pod.spec, 'cpu');
      memoryReserved += effectivePodRequest(pod.spec, 'memory');
    }
  } catch {
    // Fall back to ResourceQuota if pod listing fails
    try {
      const quota = await k8s.core.readNamespacedResourceQuota({
        name: `${namespace}-quota`,
        namespace,
      });
      const used = (quota as { status?: { used?: Record<string, string> } }).status?.used ?? {};
      // Same requests-first rule as the pod path above.
      const qCpu = used['requests.cpu'] ?? used['limits.cpu'];
      const qMem = used['requests.memory'] ?? used['limits.memory'];
      if (qCpu) cpuReserved = parseResourceValue(qCpu, 'cpu');
      if (qMem) memoryReserved = parseResourceValue(qMem, 'memory');
    } catch {
      // Quota might not exist yet
    }
  }

  // 3. Storage reserved from ResourceQuota (PVC-level, not affected by system pods)
  let storageReserved = 0;
  try {
    const quota = await k8s.core.readNamespacedResourceQuota({
      name: `${namespace}-quota`,
      namespace,
    });
    const used = (quota as { status?: { used?: Record<string, string> } }).status?.used ?? {};
    if (used['requests.storage']) storageReserved = parseResourceValue(used['requests.storage'], 'storage');
  } catch {
    // Quota might not exist yet
  }

  // 4. Storage actual usage.
  //
  //    PRIMARY: kubelet volume stats via VictoriaMetrics. The kubelet reports
  //    used bytes for every PVC it has mounted, which is CSI-agnostic (no
  //    Longhorn-specific query) and, crucially, does not depend on any
  //    tenant-namespace pod of ours being awake.
  //
  //    FALLBACK: the file-manager's /disk-usage. This used to be the ONLY
  //    source, which is why storage usage read 0 nearly all the time — the
  //    file-manager is created with replicas: 0 and the idle-cleanup loop
  //    scales it back to 0 after 10 minutes, so the proxy usually threw and the
  //    catch left storageInUse at 0.
  //
  //    Caveat worth knowing: the kubelet only reports volumes it has MOUNTED,
  //    so a tenant whose every workload is stopped reports no volume stats. The
  //    file-manager fallback covers exactly that case when it happens to be up.
  let storageInUse = 0;
  try {
    const samples = await queryInstant(
      `sum(kubelet_volume_stats_used_bytes{namespace="${escapeLabelValue(namespace)}"})`,
    );
    if (samples.length > 0) {
      storageInUse = samples[0].value / (1024 * 1024 * 1024); // bytes to Gi
    }
  } catch {
    // vmsingle unreachable — fall through to the file-manager probe.
  }

  if (storageInUse === 0) {
    try {
      const { proxyToFileManager } = await import('../file-manager/service.js');
      const kubeconfigPath = process.env.KUBECONFIG_PATH;
      const result = await proxyToFileManager(kubeconfigPath, namespace, '/disk-usage');
      if (result.status === 200) {
        const data = JSON.parse(result.body) as { usedBytes?: number };
        storageInUse = (data.usedBytes ?? 0) / (1024 * 1024 * 1024); // bytes to Gi
      }
    } catch {
      // File manager not running either — leave storageInUse as 0.
    }
  }

  const metrics: ResourceMetrics = {
    tenantId,
    usageMeasured,
    cpu: {
      // SIX decimals, not three. Three is a whole millicore, and real tenant
      // usage lives below it: measured across production, 23 of 27 tenants sat
      // between 0 and 0.5 millicores, so rounding to millicores collapsed the
      // measurement to exactly 0 before anything could display it.
      inUse: Math.round(cpuInUse * 1_000_000) / 1_000_000,
      reserved: Math.round(cpuReserved * 1000) / 1000,
      available: planLimits.cpuLimit,
    },
    memory: {
      inUse: Math.round(memoryInUse * 1000) / 1000,
      reserved: Math.round(memoryReserved * 1000) / 1000,
      available: planLimits.memoryLimitGi,
    },
    storage: {
      inUse: Math.round(storageInUse * 1000) / 1000,
      reserved: Math.round(storageReserved * 1000) / 1000,
      available: planLimits.storageLimitGi,
    },
    lastUpdatedAt: new Date().toISOString(),
  };

  // Cache in Redis
  const redis = getRedis();
  await redis.setex(`${CACHE_KEY_PREFIX}${tenantId}`, CACHE_TTL, JSON.stringify(metrics));

  return metrics;
}

export async function getCachedMetrics(tenantId: string): Promise<ResourceMetrics | null> {
  const redis = getRedis();
  const cached = await redis.get(`${CACHE_KEY_PREFIX}${tenantId}`);
  if (!cached) return null;
  return JSON.parse(cached) as ResourceMetrics;
}

export async function getAllCachedMetrics(tenantIds: readonly string[]): Promise<Record<string, ResourceMetrics>> {
  if (tenantIds.length === 0) return {};
  const redis = getRedis();
  const keys = tenantIds.map(id => `${CACHE_KEY_PREFIX}${id}`);
  const values = await redis.mget(...keys);

  const result: Record<string, ResourceMetrics> = {};
  for (let i = 0; i < tenantIds.length; i++) {
    const raw = values[i];
    if (raw) {
      result[tenantIds[i]] = JSON.parse(raw) as ResourceMetrics;
    }
  }
  return result;
}
