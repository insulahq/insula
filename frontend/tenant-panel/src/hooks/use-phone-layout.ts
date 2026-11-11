import { useEffect } from 'react';
import { PHONE_QUERY, layoutTables, resetTables, revealActiveTabs } from '@/lib/phone-layout';

/**
 * Keeps the phone layout of tables and tab strips (lib/phone-layout.ts) up to
 * date for the whole document — modals render outside <main>, so it watches
 * <body>. Mounted once, by the app layout.
 *
 * Re-runs at most once per frame after the DOM changes. It watches class,
 * style, hidden and open as well as added nodes: a tab panel or a <details>
 * that is shown by an attribute holds a table that could not be measured while
 * hidden. Its own writes (data-label, data-stack) are not in that list, so it
 * cannot trigger itself.
 */
export function usePhoneLayout(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || typeof MutationObserver === 'undefined') return;
    const phone = window.matchMedia(PHONE_QUERY);
    let frame = 0;
    let width = window.innerWidth;
    const run = () => {
      frame = 0;
      layoutTables(document, phone.matches);
      revealActiveTabs(document);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(run);
    };
    const onResize = () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      resetTables(document);
      schedule();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    window.addEventListener('resize', onResize);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
}
