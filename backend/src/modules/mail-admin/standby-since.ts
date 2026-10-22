/**
 * When a node became a mail standby, and whether it is still making its first
 * copy.
 *
 * Moving the standby to another node labels the new one, and its replicator
 * then copies the whole mail store before it reports anything — minutes in one
 * data centre, hours over a slow link. Until then the node has no complete
 * copy, which the standby check used to read as broken: it alerted "has never
 * finished a copy" during an ordinary move, and the operations page showed the
 * failure in red. A node that has only just become a standby is preparing, not
 * failing.
 *
 * The label reconciler (placement.ts) stamps the moment on the Node as an
 * annotation when it adds the label and removes it with the label. A report
 * from before that moment is from an earlier time the node was a standby — its
 * data was set aside when it was de-elected (standby-cleanup.ts) — so it does
 * not count. A node labelled before the annotation existed has none, and is
 * judged as before.
 */

export const MAIL_STANDBY_SINCE_ANNOTATION = 'insula.host/mail-standby-since';

/**
 * How long a first copy may take before it is reported as failing. A copy that
 * has not finished after this long is not a slow link any more.
 */
export const FIRST_COPY_GRACE_SECONDS = 6 * 3600;

/** The annotation's time, or null when absent or not a time. */
export function standbySinceFrom(annotations: Record<string, string> | undefined): string | null {
  const raw = annotations?.[MAIL_STANDBY_SINCE_ANNOTATION];
  if (!raw || Number.isNaN(Date.parse(raw))) return null;
  return new Date(raw).toISOString();
}

/**
 * Is the node still on its first copy as a standby: it became one at `since`
 * and has no report from after that. Null `since` (labelled before this was
 * recorded) is never "first copy".
 */
export function onFirstCopy(since: string | null, reportedAt: string | null | undefined): boolean {
  if (!since) return false;
  if (!reportedAt) return true;
  return Date.parse(reportedAt) < Date.parse(since);
}

/**
 * How long a new standby's copier may take to start (its pod scheduled, the
 * image pulled) before "not running" counts against it.
 */
export const COPIER_START_SECONDS = 10 * 60;

/**
 * Where a first copy stands:
 *   preparing   — within the grace, and its copier is running (or just
 *                 starting, or could not be checked);
 *   not_running — its copier is not running past the start window: the node is
 *                 down, the pod cannot be scheduled or keeps failing. Waiting
 *                 out the grace would only hide that;
 *   overdue     — still not finished after the grace.
 */
export type FirstCopyState = 'preparing' | 'not_running' | 'overdue';

export function firstCopyState(input: {
  readonly since: string;
  readonly now: number;
  /** Is the replicator pod on the node running? Null when it could not be read. */
  readonly copierRunning: boolean | null;
}): FirstCopyState {
  const elapsed = (input.now - Date.parse(input.since)) / 1000;
  if (elapsed > FIRST_COPY_GRACE_SECONDS) return 'overdue';
  if (input.copierRunning === false && elapsed > COPIER_START_SECONDS) return 'not_running';
  return 'preparing';
}

/** The replicator DaemonSet's pods, as read by the callers below. */
export const STANDBY_REPLICATOR_SELECTOR = 'app=mail-stack-standby-replicate';

type PodLite = {
  spec?: { nodeName?: string };
  status?: { phase?: string; containerStatuses?: Array<{ state?: { running?: unknown } }> };
};

/** Node name → is its replicator pod running (Running, every container running). Pure. */
export function copierRunningByNode(pods: ReadonlyArray<PodLite>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const p of pods) {
    const node = p.spec?.nodeName;
    if (!node) continue;
    const statuses = p.status?.containerStatuses ?? [];
    const running = p.status?.phase === 'Running' && statuses.length > 0 && statuses.every((c) => !!c.state?.running);
    out.set(node, (out.get(node) ?? false) || running);
  }
  return out;
}
