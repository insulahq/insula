import type { Database } from '../../db/index.js';
import { getSettings } from '../system-settings/service.js';
import { resolveTenantDiskLimits, type TenantDiskLimits } from './pod-bounds.js';

/**
 * The node-disk limits to render into tenant pods right now, from the admin
 * Limits page (system_settings, read through its 5 s cache). Read at render
 * time: a changed value reaches a workload when it is next deployed, never by
 * restarting running ones.
 */
export async function getTenantDiskLimits(db: Database): Promise<TenantDiskLimits> {
  try {
    return resolveTenantDiskLimits(await getSettings(db));
  } catch (err) {
    // The settings row is unreadable (DB blip). Deploy with the documented
    // defaults rather than fail the deploy or render an unbounded pod.
    console.warn(`[tenant-disk] could not read the disk limits; using the defaults: ${(err as Error).message}`);
    return resolveTenantDiskLimits(undefined);
  }
}
