/**
 * Degraded-render reporting.
 *
 * A notification that goes out thin is a defect, not a success. The
 * delivery path never drops a message for a missing variable any more — but
 * "never drops" must not become "never mentions", which is the same silence
 * in a nicer costume.
 *
 * Three destinations, deliberately:
 *   - the metric, so it is alertable and trended;
 *   - the delivery row (`degraded_vars`), so the admin log can filter to
 *     exactly the affected messages and name the template;
 *   - stderr, so it appears in `kubectl logs` triage without a query.
 */
import { notificationDegradedTotal } from '../../../shared/metrics.js';

/** Cap what we log/persist — a runaway template must not write unbounded rows. */
const MAX_REPORTED_VARS = 20;

export function clampDegradedVars(vars: readonly string[]): string[] {
  return vars.slice(0, MAX_REPORTED_VARS);
}

export function recordDegradedRender(
  categoryId: string,
  channel: string,
  degradedVars: readonly string[],
  fallbackUsed: boolean,
): void {
  if (fallbackUsed) {
    notificationDegradedTotal.inc({ category: categoryId, channel, kind: 'fallback' });
  }
  if (degradedVars.length > 0) {
    notificationDegradedTotal.inc({ category: categoryId, channel, kind: 'missing_vars' });
  }

  const what = fallbackUsed ? 'envelope fallback' : `missing ${clampDegradedVars(degradedVars).join(', ')}`;
  console.warn(`[notifications] degraded render ${categoryId}/${channel}: ${what}`);
}
