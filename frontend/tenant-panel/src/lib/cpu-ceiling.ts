import type { Deployment } from '@/types/api';

/**
 * What an application's CPU figure is measured against.
 *
 * Under the tier model (ADR-062) a deployment's `cpuRequest` is the tenant's
 * share under contention — a scheduling weight, not a size. "8m / 100m" read
 * as an app at 8% of its room when it could burst to six cores, and the
 * request is a number the tenant never chose. The ceiling is what bounds the
 * app: the plan's burst ceiling (the namespace LimitRange's per-container
 * default), unless a custom spec declares its own limit on every service —
 * then the sum of those.
 *
 * Null when there is no ceiling to show — a legacy tenant, or an API that
 * predates the tier fields. Callers then fall back to the request.
 */
export function cpuCeilingCores(
  deployment: Pick<Deployment, 'source' | 'customSpec'>,
  burstCores: number | null | undefined,
): number | null {
  const services = deployment.source === 'custom' ? Object.values(deployment.customSpec?.services ?? {}) : [];
  const limits = services.map((svc) => svc.resources?.cpuLimit).filter((l): l is string => Boolean(l));
  // The usage figure is the whole app's, so its ceiling is the SUM of its
  // services' limits. A service without a limit of its own gets the
  // LimitRange default, so the limits decide only when every service sets one.
  if (services.length > 0 && limits.length === services.length) {
    return limits.reduce((sum, l) => sum + cpuCores(l), 0);
  }
  return burstCores != null && burstCores > 0 ? burstCores : null;
}

/** A Kubernetes CPU quantity ("500m", "2", "1.5") in cores. */
export function cpuCores(quantity: string): number {
  if (quantity.endsWith('m')) return Number(quantity.slice(0, -1)) / 1000 || 0;
  return Number(quantity) || 0;
}

/** "6 cores", "1 core", "500m" — how a ceiling reads beside a millicore figure. */
export function formatCpuCeiling(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  const rounded = Math.round(cores * 100) / 100;
  return `${rounded} core${rounded === 1 ? '' : 's'}`;
}
