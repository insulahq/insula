/**
 * How often an application list re-reads itself. A deployment that fails after
 * it was created (a quota refusal, a crash loop, an image that will not pull) is
 * only ever discovered by the server's reconcile, so a list that does not poll
 * keeps showing "Deploying" until the page is reloaded — which is what the
 * Custom Containers tab did. Fast while anything is changing state, slow
 * otherwise so a crash later still shows without a reload.
 */
export const TRANSITIONAL_DEPLOYMENT_STATUSES: readonly string[] = ['deploying', 'pending', 'upgrading', 'deleting'];
export const DEPLOYMENT_POLL_FAST_MS = 3_000;
export const DEPLOYMENT_POLL_IDLE_MS = 15_000;

export function isTransitionalDeploymentStatus(status: string): boolean {
  return TRANSITIONAL_DEPLOYMENT_STATUSES.includes(status);
}

/** The interval for a list holding these rows. Pure. */
export function deploymentListPollMs(rows: ReadonlyArray<{ readonly status: string }> | undefined): number {
  return rows?.some((r) => isTransitionalDeploymentStatus(r.status)) ? DEPLOYMENT_POLL_FAST_MS : DEPLOYMENT_POLL_IDLE_MS;
}
