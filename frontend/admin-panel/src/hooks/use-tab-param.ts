import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Tab state held in `?tab=`, so a tab is a linkable destination.
 *
 * Global search needs this: most of what an operator hunts for is one
 * level BELOW a nav item — "WAF Events", "Pods", "Trusted Proxies" are
 * all tabs, not pages. A page holding its tab in `useState` can only be
 * linked to at page level, so search would land the user on the default
 * tab and leave them to find the right one.
 *
 * An unrecognised or absent `tab` falls back rather than rendering
 * nothing, so a stale bookmark degrades to the default view instead of a
 * blank page. `replace: true` keeps tab switching out of the history
 * stack — Back should leave the page, not step through every tab the
 * user looked at.
 *
 * Pages that already implement this inline (Monitoring, NetworkTrust,
 * WebDefense, Notifications, BackupClassPage) are left as they are;
 * this hook is for the ones being converted.
 */
export function useTabParam<T extends string>(
  validTabs: readonly T[],
  fallback: T,
): readonly [T, (tab: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');

  const activeTab = useMemo<T>(() => {
    if (requested && (validTabs as readonly string[]).includes(requested)) {
      return requested as T;
    }
    return fallback;
  }, [requested, validTabs, fallback]);

  const setActiveTab = (tab: T): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };

  return [activeTab, setActiveTab] as const;
}
