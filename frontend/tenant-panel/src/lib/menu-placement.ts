/**
 * Where a fixed-position menu goes so that all of it stays on screen.
 *
 * A right-click menu opened at the pointer near the right or bottom edge, or a
 * tall one on a short screen, used to run past the viewport with no way to
 * reach the items beyond it.
 */

/** What the menu opens from: the pointer, or the button that opened it. */
export type MenuAnchor =
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | { readonly kind: 'rect'; readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };

export interface MenuPlacement {
  readonly left: number;
  readonly top: number;
  /** Set when the menu is taller than the screen allows: it scrolls inside this. */
  readonly maxHeight?: number;
}

/** Room kept between the menu and the screen edge. */
export const MENU_EDGE_MARGIN = 8;
/** Gap between a button and the menu it opened. */
const BUTTON_GAP = 4;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * Place a `size` menu for `anchor` inside a `viewport`, both in CSS pixels.
 *
 * From the pointer it opens down and right, like a desktop context menu, and
 * flips left or up where it would not fit. From a button it opens below,
 * aligned to the button's right edge, and above where there is no room below.
 * Either way the result is clamped inside the margins, and a menu taller than
 * the screen gets a `maxHeight` to scroll in.
 */
export function placeMenu(
  anchor: MenuAnchor,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  margin: number = MENU_EDGE_MARGIN,
): MenuPlacement {
  const room = Math.max(0, viewport.height - 2 * margin);
  const height = Math.min(size.height, room);
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - height - margin);

  let left: number;
  let top: number;
  if (anchor.kind === 'point') {
    left = anchor.x + size.width > viewport.width - margin ? anchor.x - size.width : anchor.x;
    top = anchor.y + height > viewport.height - margin ? anchor.y - height : anchor.y;
  } else {
    left = anchor.right - size.width;
    const below = anchor.bottom + BUTTON_GAP;
    top = below + height > viewport.height - margin ? anchor.top - BUTTON_GAP - height : below;
  }

  return {
    left: clamp(left, margin, maxLeft),
    top: clamp(top, margin, maxTop),
    ...(size.height > room ? { maxHeight: room } : {}),
  };
}
