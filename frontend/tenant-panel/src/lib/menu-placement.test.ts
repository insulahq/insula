import { describe, it, expect } from 'vitest';
import { placeMenu } from './menu-placement';

const screen = { width: 1024, height: 768 };
const menu = { width: 200, height: 400 };

describe('placeMenu', () => {
  it('opens down and right of the pointer when it fits', () => {
    expect(placeMenu({ kind: 'point', x: 100, y: 100 }, menu, screen)).toEqual({ left: 100, top: 100 });
  });

  it('flips left and up near the bottom-right corner', () => {
    expect(placeMenu({ kind: 'point', x: 1000, y: 700 }, menu, screen)).toEqual({ left: 800, top: 300 });
  });

  it('keeps the margin when a flip alone would still leave the screen', () => {
    // At y=380 a 400px menu fits neither below (ends at 780) nor above (starts at -20).
    expect(placeMenu({ kind: 'point', x: 5, y: 380 }, menu, screen)).toEqual({ left: 8, top: 8 });
  });

  it('opens below a button, aligned to its right edge', () => {
    const button = { kind: 'rect' as const, top: 100, bottom: 124, left: 960, right: 990 };
    expect(placeMenu(button, menu, screen)).toEqual({ left: 790, top: 128 });
  });

  it('opens above a button that sits too low for the menu below it', () => {
    const button = { kind: 'rect' as const, top: 700, bottom: 724, left: 960, right: 990 };
    expect(placeMenu(button, menu, screen)).toEqual({ left: 790, top: 296 });
  });

  it('caps and scrolls a menu taller than the screen', () => {
    expect(placeMenu({ kind: 'point', x: 50, y: 200 }, menu, { width: 400, height: 300 })).toEqual({
      left: 50, top: 8, maxHeight: 284,
    });
  });

  it('keeps a menu wider than the screen at the left margin', () => {
    expect(placeMenu({ kind: 'point', x: 100, y: 10 }, { width: 500, height: 100 }, { width: 320, height: 600 }).left).toBe(8);
  });
});
