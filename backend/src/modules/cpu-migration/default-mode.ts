/**
 * Which CPU model a NEW tenant is created on (ADR-062): always CPU shares.
 *
 * This used to be decided once per cluster and recorded in
 * `platform_settings.cpu_scheduling_default` — `tiered` for a fresh install,
 * `legacy` for an upgrade, so an upgraded cluster kept creating reservation
 * tenants beside its migrated ones. With CPU cores retired as a plan
 * parameter there is no reservation left to size a legacy tenant from, and
 * every tenant still on the old model is moved to shares automatically
 * (auto-migrate.ts). So a new tenant starts on shares, on every cluster. The
 * stored setting is no longer read.
 *
 * If the namespace cannot be built tiered, provisioning leaves the tenant on
 * the old model (k8s-provisioner) and the automatic migration picks it up.
 */
import type { Database } from '../../db/index.js';

export type CpuSchedulingDefault = 'legacy' | 'tiered';

/** The mode a tenant created now should get. */
export async function cpuModeForNewTenant(
  _db?: Database,
  _log?: { info?: (o: object, m?: string) => void },
): Promise<CpuSchedulingDefault> {
  return 'tiered';
}
