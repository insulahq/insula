/**
 * Placement math for the global tooltip layer — pure, so it is unit-tested
 * without a layout engine.
 *
 * Rules: prefer ABOVE the trigger; flip BELOW when the bubble does not fit
 * above (and below has room, or more room); clamp horizontally so the bubble
 * stays VIEWPORT_MARGIN px inside the viewport, while the arrow keeps pointing
 * at the trigger. The bubble is `position: fixed`, so every number here is in
 * viewport (client) coordinates.
 *
 * NOTE: this file is duplicated byte-for-byte in admin-panel and tenant-panel
 * (`src/lib/tooltip/`). `tooltip-parity.test.ts` fails if they drift.
 */

/** Distance between the trigger and the bubble; the arrow lives in it. */
export const TOOLTIP_GAP = 8;
/** Minimum distance between the bubble and any viewport edge. */
export const VIEWPORT_MARGIN = 8;
/** Half the width of the arrow's base (the arrow is 2×ARROW_HALF by ARROW_HEIGHT). */
export const ARROW_HALF = 5;
export const ARROW_HEIGHT = 5;
/** Closest the arrow's centre may get to the bubble's side — clears the rounded corner. */
export const ARROW_EDGE_PAD = 10;

export type TooltipPlacement = 'top' | 'bottom';

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface TooltipLayoutInput {
  /** The trigger's client rect (getBoundingClientRect). */
  readonly trigger: Box;
  /** The bubble's measured size. */
  readonly bubble: Size;
  /** The usable viewport (excluding scrollbars). */
  readonly viewport: Size;
  /**
   * Optional horizontal anchor (client x). Wide triggers anchor at the pointer
   * rather than their centre, which can be far from where the user is looking.
   * Clamped into the trigger's visible extent.
   */
  readonly anchorX?: number;
}

export interface TooltipLayout {
  readonly placement: TooltipPlacement;
  /** Bubble's top-left corner, in client px. */
  readonly top: number;
  readonly left: number;
  /** Arrow centre, measured from the bubble's left edge. */
  readonly arrowLeft: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeTooltipLayout({ trigger, bubble, viewport, anchorX }: TooltipLayoutInput): TooltipLayout {
  // Work from the part of the trigger that is actually on screen: a trigger
  // taller than the viewport (or scrolled half out of it) must not push the
  // bubble off-screen.
  const visTop = clamp(trigger.top, 0, viewport.height);
  const visBottom = clamp(trigger.bottom, 0, viewport.height);
  const visLeft = clamp(trigger.left, 0, viewport.width);
  const visRight = clamp(trigger.right, 0, viewport.width);

  const roomAbove = visTop - TOOLTIP_GAP - VIEWPORT_MARGIN;
  const roomBelow = viewport.height - visBottom - TOOLTIP_GAP - VIEWPORT_MARGIN;
  const fitsAbove = bubble.height <= roomAbove;
  const fitsBelow = bubble.height <= roomBelow;
  const placement: TooltipPlacement =
    fitsAbove || (!fitsBelow && roomAbove >= roomBelow) ? 'top' : 'bottom';

  const rawTop = placement === 'top' ? visTop - TOOLTIP_GAP - bubble.height : visBottom + TOOLTIP_GAP;
  const top = clamp(rawTop, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - bubble.height));

  const x = anchorX === undefined ? (visLeft + visRight) / 2 : clamp(anchorX, visLeft, visRight);
  const left = clamp(x - bubble.width / 2, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - bubble.width));
  const arrowLeft = clamp(x - Math.round(left), ARROW_EDGE_PAD, Math.max(ARROW_EDGE_PAD, bubble.width - ARROW_EDGE_PAD));

  return {
    placement,
    top: Math.round(top),
    left: Math.round(left),
    arrowLeft: Math.round(arrowLeft),
  };
}
