/**
 * One threshold policy for every resource usage indicator.
 *
 * Before this module the platform had FOUR different answers to "is this bar a
 * warning?", so the same tenant at the same utilisation saw different colours
 * depending on which screen they opened:
 *
 *   Dashboard storage bar   hardcoded amber — ALWAYS orange, at 1% or 99%
 *   ResourceMetricsModal    amber at 50%, red at 80%
 *   ResourceUsage page      amber at 80%, red at 100%
 *   Files page              amber at 70%, red at 90%
 *   Admin ResourceBar       amber at 70%, red at 90%
 *
 * A tenant using 6 GB of a 10 GB plan therefore saw an orange "warning" bar at
 * 60% on the dashboard and in the modal, while the Resource Usage page — the
 * page dedicated to exactly this question — showed the same number as normal.
 * The dashboard's orange was not even a threshold: the colour was passed in as
 * a per-metric decoration, so storage was orange unconditionally.
 *
 * The policy below is the Resource Usage page's, because it is the one tied to
 * a real event: `available` is the PLAN LIMIT, so 100% means "you cannot
 * allocate any more", and 80% is a genuine heads-up. 60% of plan is normal
 * healthy usage and must render as normal.
 */

/** Fraction of the plan limit at which we warn the tenant. */
export const RESOURCE_WARNING_RATIO = 0.8;
/** Fraction at which the plan limit is reached and allocation fails. */
export const RESOURCE_CRITICAL_RATIO = 1;

export type ResourceStatus = 'ok' | 'warning' | 'critical';

/**
 * inUse / available, clamped to a finite number. Returns 0 when `available` is
 * 0 or unknown — an unknown limit must never render as "critical", which is
 * what `x / 0 = Infinity` would do.
 */
export function resourceRatio(inUse: number, available: number): number {
  if (!Number.isFinite(inUse) || !Number.isFinite(available) || available <= 0) return 0;
  return inUse / available;
}

export function resourceStatus(ratio: number): ResourceStatus {
  if (ratio >= RESOURCE_CRITICAL_RATIO) return 'critical';
  if (ratio >= RESOURCE_WARNING_RATIO) return 'warning';
  return 'ok';
}

/** Tailwind classes for the in-use portion of a usage bar. */
export function resourceBarColor(ratio: number): string {
  switch (resourceStatus(ratio)) {
    case 'critical': return 'bg-red-500 dark:bg-red-400';
    case 'warning': return 'bg-amber-500 dark:bg-amber-400';
    default: return 'bg-brand-500 dark:bg-brand-400';
  }
}

/** Width percentage for a bar segment, clamped to [0, 100]. */
export function resourcePercent(value: number, available: number): number {
  return Math.min(100, Math.max(0, resourceRatio(value, available) * 100));
}

// ─── Shared value formatting ───────────────────────────────────────────────
// Kept here with the thresholds so a tile cannot show the same number in a
// different shape from its neighbour.

/** CPU cores. */
export function formatCpu(value: number): string {
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/** Memory / storage, given a value already expressed in GiB. */
export function formatGiB(valueGi: number): string {
  if (valueGi <= 0) return '0';
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)} Mi`;
    return `${mi.toFixed(1)} Mi`;
  }
  if (valueGi >= 10) return valueGi.toFixed(0);
  return valueGi.toFixed(1);
}
