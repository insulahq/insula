import { useSyncExternalStore } from 'react';
import { PHONE_QUERY } from '@/lib/phone-layout';

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isPhone(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * True below Tailwind's `sm` breakpoint. For a list with its own phone layout
 * (cards instead of a table) that renders ONE of the two rather than both and
 * hiding one with CSS: a page of 200 rows would otherwise carry 400, with every
 * test id and text twice in the DOM. False where matchMedia is missing (tests).
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}
