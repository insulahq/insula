/**
 * Where an error string stops being fit for a tenant.
 *
 * Job watchers append operator-only detail to the errors they throw, and those
 * errors are stored verbatim (`backup_jobs.last_error`) and shown to tenants
 * after a cut. Two markers start operator-only text:
 *
 *   `; diagnosis:` — why a Job pod never ran: node names, pod names, raw
 *                    Kubernetes event text, where the pod was pinned.
 *   `; logs:`      — the pod's own output, which can carry credential
 *                    challenges, internal URLs and master-user identities.
 *
 * Diagnosis always precedes logs, so an operator surface can drop the logs and
 * keep the diagnosis, and a tenant surface cuts at whichever comes first. Every
 * reader uses these helpers rather than its own `indexOf`, so a new marker
 * cannot be honoured by one surface and missed by another.
 */

export const DIAGNOSIS_MARKER = '; diagnosis:';
export const LOGS_MARKER = '; logs:';

function cutAt(raw: string, markers: readonly string[]): string {
  const cuts = markers.map((m) => raw.indexOf(m)).filter((i) => i >= 0);
  return cuts.length > 0 ? raw.slice(0, Math.min(...cuts)) : raw;
}

/** The part of an error a tenant may read: everything before the first marker. */
export function tenantVisibleText(raw: string): string {
  return cutAt(raw, [DIAGNOSIS_MARKER, LOGS_MARKER]);
}

/** The part an operator NOTIFICATION may carry: the diagnosis, not the pod logs. */
export function operatorNotificationText(raw: string): string {
  return cutAt(raw, [LOGS_MARKER]);
}
