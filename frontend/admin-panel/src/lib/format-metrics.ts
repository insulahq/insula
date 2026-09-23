/**
 * Resource-metric formatters, shared by the tenant list and tenant detail.
 *
 * These existed as two near-identical private copies. One of them crashed the
 * whole admin Tenants page — `Cannot read properties of null (reading
 * 'toFixed')` — because a metric arrived null where the hand-written type
 * promised a number. The other copy survived only by accident (`null <= 0` is
 * true, so it returned early).
 *
 * Both lessons are baked in here: ONE implementation, and every entry point is
 * total over null/undefined/NaN. A number that cannot be rendered becomes a
 * dash; it never takes a page down.
 */

/** Rendered in place of a metric the API gave us no usable number for. */
export const METRIC_UNAVAILABLE = '—';

/** Finite numbers only — null, undefined and NaN all mean "no reading". */
export function isMetricValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** CPU cores. Precision shrinks as the number grows: 12, 3.4, 0.25. */
export function formatMetricsCpu(value: number | null | undefined): string {
  if (!isMetricValue(value)) return METRIC_UNAVAILABLE;
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/**
 * Gibibytes, stepping down to Mi below 1 Gi.
 *
 * `space` inserts a gap before the unit ("1.5 Gi" vs "1.5Gi") — the table wants
 * it tight, the detail cards want it spaced, and that was the only real
 * difference between the two former copies.
 */
export function formatMetricsBytes(
  valueGi: number | null | undefined,
  opts: { readonly space?: boolean } = {},
): string {
  if (!isMetricValue(valueGi)) return METRIC_UNAVAILABLE;
  const sep = opts.space ? ' ' : '';
  if (valueGi <= 0) return `0${sep}Mi`;
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)}${sep}Mi`;
    if (mi >= 10) return `${mi.toFixed(1)}${sep}Mi`;
    return `${mi.toFixed(2)}${sep}Mi`;
  }
  if (valueGi >= 10) return `${valueGi.toFixed(0)}${sep}Gi`;
  return `${valueGi.toFixed(1)}${sep}Gi`;
}

/** `formatMetricsBytes` with the spaced unit the detail cards use. */
export function formatMetricsGi(valueGi: number | null | undefined): string {
  return formatMetricsBytes(valueGi, { space: true });
}
