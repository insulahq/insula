import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { resolveTab } from '@/hooks/use-tab-param';
import { TABBED_PAGES, type TabbedPage } from './tabbed-pages';

/**
 * Route element for a tabbed page (`<page>/:tab?` in App.tsx).
 *
 * Puts the URL into its canonical form BEFORE the page mounts: an old
 * `?tab=` link becomes the path form, and a tab that does not exist becomes
 * the bare page. Doing this from inside the page raced the page's own
 * mount-time URL writes — NetworkTrust strips `?prefill=` once consumed — and
 * whichever replace-navigation ran last won. Here the page simply is not
 * rendered until the URL is final, so nothing can race it.
 */
export default function TabRoute({ page, children }: { readonly page: TabbedPage; readonly children: ReactNode }) {
  const { tab } = useParams();
  const location = useLocation();
  const resolved = resolveTab(TABBED_PAGES[page], location.pathname, location.search, tab);
  if (resolved.canonical !== null) {
    return <Navigate replace to={{ ...resolved.canonical, hash: location.hash }} />;
  }
  return <>{children}</>;
}
