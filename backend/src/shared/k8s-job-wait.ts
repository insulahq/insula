/**
 * Read-after-create race tolerance for Job poll loops.
 *
 * Several subsystems create a short-lived Job and immediately poll
 * `readNamespacedJob` until it reaches a terminal state. On a
 * multi-apiserver (HA) k3s control plane the GET that immediately
 * follows the create can be routed (via the API load-balancer) to a
 * *different* apiserver whose watch cache has not yet observed the
 * just-committed object — so the read returns a transient
 * `404 jobs.batch "<name>" not found` even though the create returned
 * 201 and the object is durably in etcd.
 *
 * The capture (`tenant-bundles`) Job loops happen to dodge this because
 * they perform an ownerReference PATCH round-trip between create and the
 * first read, which gives the object time to propagate. The
 * storage-lifecycle snapshot Job (legacy hostpath / S3 stores) has *no*
 * intervening apiserver call, so its first read fires nanoseconds after
 * create and is the one that surfaced the 404 in the restore-cart
 * pre-restore snapshot. This helper removes the reliance on luck for all
 * of them.
 *
 * Contract: a 404 within `JOB_VISIBILITY_GRACE_MS` of the create is
 * "not visible yet — keep polling" (returns `null`). A 404 *after* the
 * grace window is a genuinely-missing Job (deleted out from under us, or
 * a create that never persisted) and throws a clear error. Non-404 read
 * failures always re-throw.
 */

import { isNotFound } from './k8s-errors.js';

/**
 * How long after a Job create a 404 read is treated as a propagation
 * race rather than a missing Job. The race resolves in milliseconds in
 * practice; 60s is generous headroom while staying far below every
 * caller's overall Job timeout (30 min – 6 h).
 */
export const JOB_VISIBILITY_GRACE_MS = 60_000;

export interface JobStatusLite {
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ type: string; status: string; reason?: string; message?: string }>;
    readonly succeeded?: number;
    readonly failed?: number;
  };
}

export interface JobReader {
  readNamespacedJob(args: { name: string; namespace: string }): Promise<JobStatusLite>;
}

/**
 * Read a Job, tolerating the brief post-create window where an HA
 * apiserver may 404 a freshly-created object.
 *
 * @returns the Job when readable, or `null` when it is not yet visible
 *   AND we are still inside the grace window (caller should sleep + retry).
 * @throws when the read fails for any non-404 reason, or when the Job is
 *   still 404 after the grace window has elapsed.
 */
export async function readJobToleratingEarlyAbsence(
  batch: JobReader,
  name: string,
  namespace: string,
  createdAtMs: number,
  now: () => number = Date.now,
): Promise<JobStatusLite | null> {
  try {
    return await batch.readNamespacedJob({ name, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const elapsed = now() - createdAtMs;
    if (elapsed < JOB_VISIBILITY_GRACE_MS) {
      // Read-after-create propagation race — not yet visible.
      return null;
    }
    throw new Error(
      `Job ${namespace}/${name} not found ${Math.round(elapsed / 1000)}s after creation — `
      + 'it was deleted out from under us or the create never persisted',
    );
  }
}
