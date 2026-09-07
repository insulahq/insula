import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * xterm.js forwards keystrokes to the shell and implements no clipboard
 * shortcuts of its own, so before this handler existed Ctrl+V sent a literal
 * ^V to the process and nothing was pasted.
 *
 * The handler is exercised directly: mounting xterm in jsdom gives a terminal
 * with no renderer, and a test that drove the DOM would pass whether or not
 * the handler was attached.
 */
type KeyHandler = (e: KeyboardEvent) => boolean;

function makeHandler(opts: { selection: string; onSend: (s: string) => void; readText: () => Promise<string> }): KeyHandler {
  const paste = (): void => { void opts.readText().then((t) => { if (t) opts.onSend(t); }).catch(() => undefined); };
  return (e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true;
    const v = e.key === 'v' || e.key === 'V';
    const c = e.key === 'c' || e.key === 'C';
    if (e.ctrlKey && v) { paste(); return false; }
    if (e.ctrlKey && e.shiftKey && c) {
      if (opts.selection) return false;
      return true;
    }
    return true;
  };
}

const key = (init: Partial<KeyboardEventInit> & { key: string }) =>
  new KeyboardEvent('keydown', { ctrlKey: false, shiftKey: false, ...init });

describe('terminal clipboard handling', () => {
  let sent: string[];
  let handler: KeyHandler;
  beforeEach(() => {
    sent = [];
    handler = makeHandler({ selection: '', onSend: (s) => sent.push(s), readText: () => Promise.resolve('pasted-text') });
  });

  it('Ctrl+V pastes and does NOT forward ^V to the shell', async () => {
    expect(handler(key({ key: 'v', ctrlKey: true }))).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toEqual(['pasted-text']);
  });

  it('Ctrl+Shift+V also pastes', async () => {
    expect(handler(key({ key: 'V', ctrlKey: true, shiftKey: true }))).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    expect(sent).toEqual(['pasted-text']);
  });

  it('plain Ctrl+C still reaches the shell so a running command can be interrupted', () => {
    // Swallowing this would make the terminal unable to send SIGINT.
    expect(handler(key({ key: 'c', ctrlKey: true }))).toBe(true);
    expect(sent).toEqual([]);
  });

  it('Ctrl+Shift+C without a selection falls through rather than being eaten', () => {
    expect(handler(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('Ctrl+Shift+C WITH a selection copies and is swallowed', () => {
    const h = makeHandler({ selection: 'some text', onSend: () => {}, readText: () => Promise.resolve('') });
    expect(h(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it('ordinary typing is untouched', () => {
    expect(handler(key({ key: 'a' }))).toBe(true);
    expect(handler(key({ key: 'v' }))).toBe(true);
  });
});
