import { hostingPlans, tenants } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectTenantMetrics } from './resource-metrics.js';
import type { Database } from '../../db/index.js';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour total cycle
const STAGGER_DELAY_MS = 2000; // 2 seconds between each tenant
const INITIAL_DELAY_MS = 30_000; // 30 seconds after startup

export function startMetricsScheduler(db: Database): NodeJS.Timeout {
  console.log('[metrics-scheduler] Starting hourly staggered refresh');

  const runCycle = async () => {
    try {
      const kubeconfigPath = process.env.KUBECONFIG_PATH;
      let k8s: ReturnType<typeof createK8sClients>;
      try {
        k8s = createK8sClients(kubeconfigPath);
      } catch {
        console.warn('[metrics-scheduler] K8s not available, skipping cycle');
        return;
      }

      // Get all provisioned tenants
      const allTenants = await db.select({
        id: tenants.id,
        namespace: tenants.kubernetesNamespace,
        planId: tenants.planId,
        cpuLimitOverride: tenants.cpuLimitOverride,
        memoryLimitOverride: tenants.memoryLimitOverride,
        storageLimitOverride: tenants.storageLimitOverride,
        provisioningStatus: tenants.provisioningStatus,
      }).from(tenants);

      const provisioned = allTenants.filter(c => c.provisioningStatus === 'provisioned');

      // Get all plans for limit resolution
      const allPlans = await db.select().from(hostingPlans);
      const planMap = new Map(allPlans.map(p => [p.id, p]));

      for (let i = 0; i < provisioned.length; i++) {
        const tenant = provisioned[i];
        const plan = planMap.get(tenant.planId);

        const planLimits = {
          cpuLimit: Number(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
          memoryLimitGi: Number(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
          storageLimitGi: Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 50),
        };

        try {
          await collectTenantMetrics(db, k8s, tenant.id, tenant.namespace, planLimits);
        } catch (err) {
          console.warn(`[metrics-scheduler] Failed for ${tenant.id}:`, err instanceof Error ? err.message : String(err));
        }

        // Stagger to avoid overwhelming K8s API
        if (i < provisioned.length - 1) {
          await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
        }
      }

      console.log(`[metrics-scheduler] Refreshed ${provisioned.length} tenants`);
    } catch (err) {
      console.error('[metrics-scheduler] Cycle error:', err);
    }
  };

  // Run first cycle after 30 seconds (let app fully start)
  setTimeout(runCycle, INITIAL_DELAY_MS);

  return setInterval(runCycle, REFRESH_INTERVAL_MS);
}
