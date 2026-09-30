import { useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import Footer from './Footer';
import LifecycleBanner from '@/components/LifecycleBanner';
import { useTokenRefresh } from '@/hooks/use-token-refresh';
import { useDocumentTitle } from '@/hooks/use-system-info';
import { useFileManagerKeepalive } from '@/hooks/use-file-manager-keepalive';

export default function Layout() {
  useTokenRefresh();
  useDocumentTitle();
  useFileManagerKeepalive();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900" data-testid="layout">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onMenuClick={openSidebar} />
        <LifecycleBanner />

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
        {/* `overflow-x-clip`, and it is not belt-and-braces. Setting ONLY
            `overflow-y` makes the browser compute `overflow-x: auto`, so any
            child a single pixel too wide gives the whole page a horizontal
            scrollbar — a hover card did exactly that. `clip` suppresses it
            without creating a scroll container, so a future stray child
            cannot reintroduce the bar. */}
        <main className="relative flex-1 overflow-y-auto overflow-x-clip p-4 lg:p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
