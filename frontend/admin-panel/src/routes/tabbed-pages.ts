/**
 * Every admin page whose view is chosen by a tab, keyed by its route path.
 *
 * This is the ONE place a tab exists. App.tsx declares each page as
 * `<page>/:tab?`, `useTabParam(page)` reads and writes the tab from it, and
 * the link guard (backend/src/modules/ui-links/link-targets.test.ts) checks
 * every dashboard tile, notification, task and search link against it — so a
 * link to a tab that does not exist fails a test instead of landing an
 * operator on the default view.
 *
 * The FIRST tab is the page's default: `/monitoring` shows it, and a tab that
 * is not listed falls back to it.
 *
 * Pure data, no imports: the guard reads this file as text.
 */
export const TABBED_PAGES = {
  '/applications': ['catalog', 'installed', 'upgrades', 'repos'],
  '/tenants/:id': ['domains', 'deployments', 'files', 'email', 'backups', 'snapshots', 'users', 'sftp'],
  // Traffic is the landing view — operator decision: Monitoring opens on what
  // the platform is doing; SLOs and Active Alerts are one click away.
  '/monitoring': [
    'traffic', 'active-alerts', 'alert-history', 'activity', 'health', 'storage', 'pods', 'node-health', 'slos', 'mail',
  ],
  '/security/posture': ['overview', 'ssh', 'mesh', 'firewall', 'hardening', 'k8s', 'auth', 'netpol', 'events'],
  '/security/network-trust': ['trusted-ranges', 'pending-peers', 'trusted-proxies', 'blacklist'],
  '/security/web-defense': ['waf', 'bans', 'exclusions', 'settings'],
  '/email/settings': ['mail', 'webmail', 'bundle-engine'],
  '/email/operations': ['placement', 'backups', 'storage'],
  '/platform/notifications': ['categories', 'providers', 'templates', 'deliveries'],
  // The three backup pages share BackupClassPage, which renders a tab only when
  // its page passes content for it — keep each list equal to what that page
  // passes, or a link to a listed tab would show the page's first tab instead.
  '/backups/system': ['backups', 'snapshots', 'routing'],
  '/backups/tenants': ['backups', 'snapshots', 'routing'],
  '/backups/mail': ['backups', 'routing'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type TabbedPage = keyof typeof TABBED_PAGES;
export type TabOf<P extends TabbedPage> = (typeof TABBED_PAGES)[P][number];
