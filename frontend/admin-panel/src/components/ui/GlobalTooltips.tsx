import { useEffect } from 'react';
import { installGlobalTooltips } from '@/lib/tooltip/tooltip-layer';

/**
 * Mount ONCE at the app root. Every `title="…"` in the panel then renders as a
 * styled, never-clipped tooltip instead of the browser's native one — so
 * components keep using plain `title` attributes and get this for free. Opt a
 * subtree out with `data-native-title`. See `lib/tooltip/tooltip-layer.ts`.
 *
 * Renders nothing: the layer is one delegated listener set on the document.
 *
 * NOTE: duplicated byte-for-byte in admin-panel and tenant-panel;
 * `tooltip-parity.test.ts` fails if they drift.
 */
export function GlobalTooltips(): null {
  useEffect(() => installGlobalTooltips(), []);
  return null;
}
