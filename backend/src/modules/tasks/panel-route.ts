/**
 * A task-center target for a task that either panel can start.
 *
 * The chip renders in the panel of the user who started the task, and the two
 * panels are separate apps: `/tenants/<id>/domains/<id>` exists only in the
 * admin panel, `/domains/<id>` only in the tenant panel. A single href is a
 * dead link in one of them. Name both, keyed by panel — the link guard
 * (ui-links/link-targets.test.ts) checks each against its own panel.
 */
export function panelRoute(
  scope: 'admin' | 'tenant',
  hrefs: { readonly admin: string; readonly tenant: string },
): { readonly type: 'route'; readonly href: string } {
  return { type: 'route', href: scope === 'admin' ? hrefs.admin : hrefs.tenant };
}
