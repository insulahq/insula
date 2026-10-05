import { describe, expect, it } from 'vitest';
import {
  ARROW_EDGE_PAD,
  TOOLTIP_GAP,
  VIEWPORT_MARGIN,
  computeTooltipLayout,
  type Box,
} from './tooltip-position';

const VIEWPORT = { width: 1000, height: 800 };

function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

describe('computeTooltipLayout', () => {
  it('centres the bubble above the trigger when there is room', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, 200, 40, 20),
      bubble: { width: 80, height: 24 },
      viewport: VIEWPORT,
    });
    expect(layout.placement).toBe('top');
    expect(layout.top).toBe(200 - TOOLTIP_GAP - 24);
    expect(layout.left).toBe(80); // centre 120 minus half the bubble
    expect(layout.arrowLeft).toBe(40); // arrow sits under the trigger centre
  });

  it('flips below when the bubble does not fit above', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, 10, 40, 20),
      bubble: { width: 80, height: 24 },
      viewport: VIEWPORT,
    });
    expect(layout.placement).toBe('bottom');
    expect(layout.top).toBe(30 + TOOLTIP_GAP);
  });

  it('stays above when neither side fits but above has more room, clamped into the viewport', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, 50, 40, 10),
      bubble: { width: 80, height: 60 },
      viewport: { width: 400, height: 100 },
    });
    expect(layout.placement).toBe('top');
    expect(layout.top).toBe(VIEWPORT_MARGIN);
  });

  it('picks below when neither side fits but below has more room', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, 30, 40, 10),
      bubble: { width: 80, height: 80 },
      viewport: { width: 400, height: 120 },
    });
    expect(layout.placement).toBe('bottom');
    expect(layout.top + 80).toBeLessThanOrEqual(120 - VIEWPORT_MARGIN);
  });

  it('clamps against the right edge while the arrow keeps pointing at the trigger', () => {
    const trigger = box(900, 400, 40, 20);
    const layout = computeTooltipLayout({ trigger, bubble: { width: 200, height: 24 }, viewport: VIEWPORT });
    expect(layout.left + 200).toBe(VIEWPORT.width - VIEWPORT_MARGIN);
    expect(layout.left + layout.arrowLeft).toBe(920); // trigger centre
  });

  it('clamps against the left edge and keeps the arrow off the rounded corner', () => {
    const layout = computeTooltipLayout({
      trigger: box(0, 400, 20, 20),
      bubble: { width: 200, height: 24 },
      viewport: VIEWPORT,
    });
    expect(layout.left).toBe(VIEWPORT_MARGIN);
    expect(layout.arrowLeft).toBe(ARROW_EDGE_PAD);
  });

  it('keeps the arrow off the far corner when the trigger hugs the right edge', () => {
    const layout = computeTooltipLayout({
      trigger: box(985, 400, 15, 20),
      bubble: { width: 200, height: 24 },
      viewport: VIEWPORT,
    });
    expect(layout.arrowLeft).toBe(200 - ARROW_EDGE_PAD);
  });

  it('pins a bubble wider than the viewport to the left margin', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, 400, 20, 20),
      bubble: { width: 500, height: 24 },
      viewport: { width: 300, height: 800 },
    });
    expect(layout.left).toBe(VIEWPORT_MARGIN);
  });

  it('anchors at the given x, clamped into the trigger', () => {
    const wide = box(0, 400, 800, 20);
    const at = computeTooltipLayout({ trigger: wide, bubble: { width: 100, height: 24 }, viewport: VIEWPORT, anchorX: 700 });
    expect(at.left + at.arrowLeft).toBe(700);
    const outside = computeTooltipLayout({ trigger: wide, bubble: { width: 100, height: 24 }, viewport: VIEWPORT, anchorX: 950 });
    expect(outside.left + outside.arrowLeft).toBe(800);
  });

  it('measures from the visible part of a trigger that starts above the viewport', () => {
    const layout = computeTooltipLayout({
      trigger: box(100, -50, 40, 80), // only 0..30 is on screen
      bubble: { width: 80, height: 24 },
      viewport: VIEWPORT,
    });
    expect(layout.placement).toBe('bottom');
    expect(layout.top).toBe(30 + TOOLTIP_GAP);
  });

  it('returns whole pixels so text is not blurred by sub-pixel offsets', () => {
    const layout = computeTooltipLayout({
      trigger: box(100.3, 200.7, 33.3, 19.9),
      bubble: { width: 81.5, height: 23.2 },
      viewport: VIEWPORT,
    });
    for (const v of [layout.left, layout.top, layout.arrowLeft]) expect(Number.isInteger(v)).toBe(true);
  });

  it('never leaves the viewport for any trigger position', () => {
    const bubble = { width: 240, height: 48 };
    for (let x = -20; x <= 1020; x += 37) {
      for (let y = -20; y <= 820; y += 41) {
        const l = computeTooltipLayout({ trigger: box(x, y, 24, 24), bubble, viewport: VIEWPORT });
        expect(l.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(l.left + bubble.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
        expect(l.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(l.top + bubble.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN);
      }
    }
  });
});
