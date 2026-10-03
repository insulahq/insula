import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { TABBED_PAGES, type TabbedPage, type TabOf } from '@/routes/tabbed-pages';

/**
 * Tab state held in the URL path, so a tab is a linkable destination:
 * `/monitoring/slos`, `/tenants/<id>/backups`. The page's route is declared
 * `<page>/:tab?` in App.tsx and its tabs live in routes/tabbed-pages.ts.
 *
 * Global search, dashboard tiles, notifications and task chips all link to
 * tabs — most of what an operator hunts for is one level BELOW a nav item.
 *
 * - The default tab is the bare page (`/monitoring`).
 * - `?tab=<id>` still works: old links, bookmarks and stored notification
 *   links keep landing on the right tab.
 * - A tab that does not exist falls back to the default view rather than to
 *   "Page Not Found".
 * - The URL itself is put into canonical form by `<TabRoute>` (routes/
 *   TabRoute.tsx) BEFORE the page mounts — never from in here, where it raced
 *   the page's own mount-time URL writes.
 * - Switching tabs REPLACES the history entry: Back leaves the page instead of
 *   stepping through every tab the user looked at.
 */
export function useTabParam<P extends TabbedPage>(page: P): readonly [TabOf<P>, (tab: TabOf<P>) => void] {
  const tabs = TABBED_PAGES[page] as readonly TabOf<P>[];
  const { tab: routeTab } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // The route declares `:tab?`; if a page is ever mounted without it (a test
  // under `path="*"`, a route that forgot it), the last path segment still
  // counts when it names one of this page's tabs. No page's own path ends in
  // one of its own tab ids, so this cannot misread the page path as a tab.
  const lastSegment = location.pathname.replace(/\/+$/, '').split('/').pop();
  const pathTab = routeTab ?? ((tabs as readonly string[]).includes(lastSegment ?? '') ? lastSegment : undefined);

  const resolved = resolveTab(tabs, location.pathname, location.search, pathTab);

  const setActiveTab = (tab: TabOf<P>): void => {
    navigate({ ...tabLocation(tabs, resolved.base, resolved.search, tab), hash: location.hash }, { replace: true });
  };

  return [resolved.active, setActiveTab] as const;
}

export interface ResolvedTab<T extends string> {
  readonly active: T;
  /** The page's own path, without any tab segment. */
  readonly base: string;
  /** The query string without `tab`, with its leading `?` (or ''). */
  readonly search: string;
  /** Where to rewrite the URL to, or null when it is already canonical. */
  readonly canonical: { readonly pathname: string; readonly search: string } | null;
}

/** Pure: which tab the URL asks for, and its canonical form. */
export function resolveTab<T extends string>(
  tabs: readonly T[],
  pathname: string,
  search: string,
  pathTab: string | undefined,
): ResolvedTab<T> {
  const params = new URLSearchParams(search);
  const queryTab = params.get('tab');
  params.delete('tab');
  const rest = params.toString() ? `?${params.toString()}` : '';

  const trimmed = pathname.replace(/\/+$/, '') || '/';
  const base = pathTab !== undefined && trimmed.endsWith(`/${pathTab}`)
    ? trimmed.slice(0, -(pathTab.length + 1)) || '/'
    : trimmed;

  const requested = pathTab ?? queryTab;
  const known = requested !== null && (tabs as readonly string[]).includes(requested);
  const active = (known ? requested : tabs[0]) as T;

  // Rewrite the legacy query form, and a tab that does not exist.
  const needsRewrite = queryTab !== null || (pathTab !== undefined && !known);
  const canonical = needsRewrite ? tabLocation(tabs, base, rest, active) : null;
  return { active, base, search: rest, canonical };
}

/** Pure: the location of `tab` on the page at `base`. */
export function tabLocation<T extends string>(
  tabs: readonly T[],
  base: string,
  search: string,
  tab: T,
): { pathname: string; search: string } {
  const pathname = tab === tabs[0] ? base : `${base === '/' ? '' : base}/${tab}`;
  return { pathname, search };
}
