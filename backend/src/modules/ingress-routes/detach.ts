/**
 * Detaching an ingress route from its deployment.
 *
 * `ingress_routes.site_folder` names a directory *inside a deployment's*
 * storage, so it cannot outlive the link to that deployment. The DB agrees:
 * `ingress_routes_site_folder_needs_deployment` (migration 0104) rejects any
 * row with a folder and no `deployment_id`.
 *
 * Three paths detach a route, and every one of them shipped without clearing
 * the folder — so each hit the CHECK instead:
 *   - deleting the deployment (aborted the delete half-applied),
 *   - PATCHing a route's target to nothing,
 *   - PATCHing a route onto a private worker.
 *
 * The invariant lives here, once, so a fourth detach path cannot re-invent it
 * wrongly.
 */
export const DETACHED_ROUTE_TARGET = {
  deploymentId: null,
  siteFolder: null,
  appRoot: null,
} as const;

/**
 * Returns a copy of `values` with `siteFolder` and `appRoot` cleared when the
 * same write
 * detaches the route. An explicit `siteFolder` in the same patch is left
 * alone — setting one without a target is rejected before this point.
 */
export function clearOrphanedSiteFolder<T extends Record<string, unknown>>(values: T): T {
  if (values.deploymentId === null && values.siteFolder === undefined) {
    return { ...values, siteFolder: null, appRoot: null };
  }
  return values;
}
