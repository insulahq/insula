import { eq } from 'drizzle-orm';
import { hostingPlans, tenants, platformSettings } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectTenantMetrics } from './resource-metrics.js';
import { evaluateTenantSaturation, gcClearedSaturationEpisodes } from './tenant-saturation.js';
import { recordHourlyUsage } from './usage-rollup.js';
import type { Database } from '../../db/index.js';
import { tenantDisplayLimits } from './tenant-display-limits.js';

/** Admin per-tenant saturation alerts are on unless explicitly set to 'off'. */
async function saturationAlertsEnabled(db: Database): Promise<boolean> {
  try {
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, 'resource_saturation_alerts'));
    return row?.value !== 'off';
  } catch {
    return true;
  }
}

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
        name: tenants.name,
        namespace: tenants.kubernetesNamespace,
        planId: tenants.planId,
        cpuLimitOverride: tenants.cpuLimitOverride,
        // ★ The three CPU-model columns. Without them every tenant read as
        // LEGACY here, so a tiered tenant's usage was measured against the
        // old reservation and the hourly saturation check paged an admin
        // about a tenant comfortably inside its real ceiling. The
        // interactive endpoints were right and this one — the only path
        // that actually emails someone — was wrong.
        cpuSchedulingMode: tenants.cpuSchedulingMode,
        cpuTierOverride: tenants.cpuTierOverride,
        cpuBurstCoresOverride: tenants.cpuBurstCoresOverride,
        memoryLimitOverride: tenants.memoryLimitOverride,
        storageLimitOverride: tenants.storageLimitOverride,
        provisioningStatus: tenants.provisioningStatus,
      }).from(tenants);

      const provisioned = allTenants.filter(c => c.provisioningStatus === 'provisioned');

      // Get all plans for limit resolution
      const allPlans = await db.select().from(hostingPlans);
      const planMap = new Map(allPlans.map(p => [p.id, p]));

      // Per-tenant saturation admin alerts run off the SAME fresh collection
      // (no extra metrics-server load, no time-series). Gate read once/cycle.
      const alertsOn = await saturationAlertsEnabled(db);

      for (let i = 0; i < provisioned.length; i++) {
        const tenant = provisioned[i];
        const plan = planMap.get(tenant.planId);

        // Tiered tenants measure usage against their burst CEILING, not
        // against a reservation they do not have — see
        // tenant-display-limits.ts. Same resolver as the HTTP path, so a
        // cached sample and a live read cannot disagree.
        const planLimits = tenantDisplayLimits(tenant, plan);

        try {
          const metrics = await collectTenantMetrics(db, k8s, tenant.id, tenant.namespace, planLimits);
          if (metrics) {
            if (alertsOn) {
              await evaluateTenantSaturation(db, tenant.id, tenant.name, metrics, console);
            }
            // Phase 2: persist the hourly per-tenant sample (aggregate, one row
            // per metric — no per-pod series). Reaped by the usage-reaper.
            await recordHourlyUsage(db, tenant.id, {
              cpu_cores: metrics.cpu.inUse,
              memory_gb: metrics.memory.inUse,
              storage_gb: metrics.storage.inUse,
            });
          }
        } catch (err) {
          console.warn(`[metrics-scheduler] Failed for ${tenant.id}:`, err instanceof Error ? err.message : String(err));
        }

        // Container OOM kills are announced by the node-health reconciler
        // (node-health/memory-event-notify.ts), which judges each one against
        // the kernel's own OOM counters. This loop used to scan for them too,
        // an hour late, so every tenant OOM reached the admins twice.

        // Stagger to avoid overwhelming K8s API
        if (i < provisioned.length - 1) {
          await new Promise(r => setTimeout(r, STAGGER_DELAY_MS));
        }
      }

      // Cleared saturation episodes are a short audit tail; open ones are
      // bounded by (tenant x 3 resources). Once per cycle, not per tenant.
      if (alertsOn) await gcClearedSaturationEpisodes(db, console);

      console.log(`[metrics-scheduler] Refreshed ${provisioned.length} tenants`);
    } catch (err) {
      console.error('[metrics-scheduler] Cycle error:', err);
    }
  };

  // Run first cycle after 30 seconds (let app fully start)
  setTimeout(runCycle, INITIAL_DELAY_MS);

  return setInterval(runCycle, REFRESH_INTERVAL_MS);
}
