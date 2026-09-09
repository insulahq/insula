import { useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import Footer from './Footer';
import UpdateBanner from '../UpdateBanner';
import SystemHealthBanner from '../SystemHealthBanner';
import PlatformStorageHaBanner from '../PlatformStorageHaBanner';
import { useTokenRefresh } from '@/hooks/use-token-refresh';
import { useDocumentTitle } from '@/hooks/use-system-info';

export default function Layout() {
  useTokenRefresh();
  // Keep <title> in sync with the platform name. Individual pages can still
  // call useDocumentTitle('Something') to prepend a page-specific prefix.
  useDocumentTitle();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900" data-testid="layout">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={openSidebar} />
        <SystemHealthBanner />
        <PlatformStorageHaBanner />
        <UpdateBanner />

        {/* `relative` is load-bearing, not cosmetic.
            Rows render `sr-only` spans, which Tailwind implements as
            `position: absolute`. With an all-`static` ancestor chain their
            containing block is the INITIAL containing block — and
            `overflow: hidden` never clips an absolutely-positioned
            descendant whose containing block lies outside it. On a long
            page (200 WAF events) the deepest span sat ~12600px down in
            DOCUMENT coordinates, so the document grew a scroll area of its
            own and the operator saw TWO scrollbars.
            Making the scroll container a positioning context confines them
            here, so only this element scrolls. Fixed on the container
            rather than per-table: any long page had the same bug. */}
        <main className="relative flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
