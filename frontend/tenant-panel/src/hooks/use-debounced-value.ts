/**
 * useDebouncedValue — returns `value` delayed by `delayMs`.
 *
 * Mirrors the admin-panel hook of the same name. The two panels share no
 * component library, so shared UI logic lives as a matched pair rather
 * than an import across the boundary.
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
