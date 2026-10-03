/**
 * Every tenant page whose view is chosen by a tab, keyed by its route path.
 *
 * This is the ONE place a tab exists. App.tsx declares each page as
 * `<page>/:tab?`, `useTabParam(page)` reads and writes the tab from it, and
 * the link guard (backend/src/modules/ui-links/link-targets.test.ts) checks
 * every dashboard tile, notification, task and search link against it — so a
 * link to a tab that does not exist fails a test instead of landing a tenant
 * on the default view.
 *
 * The FIRST tab is the page's default: `/monitoring` shows it, and a tab that
 * is not listed falls back to it.
 *
 * Pure data, no imports: the guard reads this file as text.
 */
export const TABBED_PAGES = {
  '/applications': ['installed', 'catalog', 'custom'],
  '/monitoring': ['traffic', 'resource-usage'],
  '/email': ['mailboxes', 'aliases', 'settings', 'dmarc', 'abuse', 'tls'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type TabbedPage = keyof typeof TABBED_PAGES;
export type TabOf<P extends TabbedPage> = (typeof TABBED_PAGES)[P][number];
