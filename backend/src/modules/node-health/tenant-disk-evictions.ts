/**
 * Tenant pods evicted for exceeding their own local disk limit (R37), grouped
 * per tenant for the tenant's notification. Pure — unit tested directly.
 *
 * The kubelet evicts a pod whose container, pod total or emptyDir passes its
 * `ephemeral-storage` bound. The replacement comes up on a clean filesystem
 * and the evicted record is filtered out of the application's status, so
 * without a notification the tenant sees only an unexplained restart.
 */

import type { NormalizedMemoryEvent, TenantRef } from './memory-events.js';

/**
 * The application a pod belongs to, from its generated name:
 *   Deployment pod  <app>-<rs-hash>-<5>     blog-7d4b9c8f6-x2x9z
 *   CronJob pod     <app>-<schedule>-<5>    blog-wp-cron-29345760-k7q2m
 *   Job pod         <app>-<5>               blog-wp-install-k7q2m
 * The catalog names a component's objects after the deployment (or
 * `<deployment>-<component>`), which is what the tenant sees.
 */
export function appNameFromPodName(podName: string): string {
  const twoSuffixes = new RegExp(`^(.+)-(?:${K8S_HASH}{6,10}|\\d{8,})-${K8S_HASH}{5}$`).exec(podName);
  if (twoSuffixes) return twoSuffixes[1];
  const oneSuffix = new RegExp(`^(.+)-${K8S_HASH}{5}$`).exec(podName);
  return oneSuffix ? oneSuffix[1] : podName;
}

/**
 * Kubernetes' generated-name alphabet (apimachinery `rand.SafeEncodeString`):
 * no vowels and no 0/1/3, so a hash can never spell a word like `install` —
 * which is what keeps `blog-wp-install-k7q2m` from losing its `install`.
 * CronJob schedule stamps are all digits and matched separately.
 */
const K8S_HASH = '[bcdfghjklmnpqrstvwxz2456789]';

/** The limit the kubelet names in its eviction message, if any. */
export function diskLimitFromMessage(message: string): string | null {
  const m = /limit(?: of containers)? "?(\d+(?:\.\d+)?[KMGT]i?)"?/i.exec(message);
  return m ? m[1] : null;
}

export interface TenantDiskEvictionSummary {
  readonly tenantId: string;
  /** One item per distinct application — a list on every channel. */
  readonly apps: string[];
}

export function summarizeTenantDiskEvictions(
  events: ReadonlyArray<NormalizedMemoryEvent>,
  tenantFor: (namespace: string) => TenantRef | undefined,
): TenantDiskEvictionSummary[] {
  const byTenant = new Map<string, Map<string, string>>();
  for (const e of events) {
    if (e.kind !== 'pod-evicted' || e.cause !== 'pod-storage-limit') continue;
    if (e.systemWorkload || !e.namespace || !e.podName) continue;
    const tenant = tenantFor(e.namespace);
    if (!tenant) continue;
    const app = appNameFromPodName(e.podName);
    const limit = diskLimitFromMessage(e.message);
    const apps = byTenant.get(tenant.id) ?? new Map<string, string>();
    if (!apps.has(app)) apps.set(app, limit ? `${app} (${limit} limit)` : app);
    byTenant.set(tenant.id, apps);
  }
  return [...byTenant.entries()].map(([tenantId, apps]) => ({
    tenantId,
    apps: [...apps.keys()].sort().map((k) => apps.get(k)!),
  }));
}
