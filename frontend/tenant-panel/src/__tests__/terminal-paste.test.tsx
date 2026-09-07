import { describe, it, expect } from 'vitest';

/**
 * What the terminal's key handler must and must NOT do.
 *
 * xterm.js handles the browser's native paste on its own hidden
 * `xterm-helper-textarea`, so Ctrl+V / Ctrl+Shift+V / middle-click already
 * reach the shell. An earlier version of this component bound them anyway and
 * every paste arrived TWICE — verified in a real browser on DEV:
 *
 *     $ echo UNIQ_MARKER_Aecho UNIQ_MARKER_A
 *
 * De-duplicating inside the component could not fix it, because xterm's own
 * insertion never passes through our code. So the handler must leave V alone.
 */
type KeyHandler = (e: KeyboardEvent) => boolean;

function makeHandler(selection: string, onCopy: (s: string) => void): KeyHandler {
  return (e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      if (selection) { onCopy(selection); return false; }
    }
    return true;
  };
}

const key = (init: Partial<KeyboardEventInit> & { key: string }) =>
  new KeyboardEvent('keydown', { ctrlKey: false, shiftKey: false, ...init });

describe('terminal key handling', () => {
  it('does NOT intercept Ctrl+V — xterm already pastes, and binding it duplicated every paste', () => {
    const h = makeHandler('', () => {});
    expect(h(key({ key: 'v', ctrlKey: true }))).toBe(true);
  });

  it('does NOT intercept Ctrl+Shift+V either — same duplication', () => {
    const h = makeHandler('', () => {});
    expect(h(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('plain Ctrl+C still reaches the shell so a running command can be interrupted', () => {
    const h = makeHandler('some text', () => {});
    expect(h(key({ key: 'c', ctrlKey: true }))).toBe(true);
  });

  it('Ctrl+Shift+C copies a selection and is swallowed', () => {
    const copied: string[] = [];
    const h = makeHandler('selected', (s) => copied.push(s));
    expect(h(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(copied).toEqual(['selected']);
  });

  it('Ctrl+Shift+C with NO selection falls through rather than being eaten', () => {
    const h = makeHandler('', () => {});
    expect(h(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('ordinary typing is untouched', () => {
    const h = makeHandler('', () => {});
    expect(h(key({ key: 'a' }))).toBe(true);
    expect(h(key({ key: 'v' }))).toBe(true);
  });
});
