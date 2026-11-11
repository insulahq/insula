import { describe, it, expect } from 'vitest';
import { initialTerminalSize, parseTerminalShell, parseTerminalSize, terminalCommand } from './terminal-shell.js';

describe('terminal shell', () => {
  it('defaults to auto, and takes only the shells the panel offers', () => {
    expect(parseTerminalShell(undefined)).toBe('auto');
    expect(parseTerminalShell('/bin/bash')).toBe('/bin/bash');
    expect(parseTerminalShell('/bin/sh')).toBe('/bin/sh');
    expect(parseTerminalShell('/bin/zsh')).toBe('auto');
    expect(parseTerminalShell('/bin/sh; rm -rf /')).toBe('auto');
  });

  it('auto prefers a shell with line editing over dash', () => {
    const [bin, flag, script] = terminalCommand('auto');
    expect([bin, flag]).toEqual(['/bin/sh', '-c']);
    expect(script).toMatch(/^export TERM=xterm-256color; /);
    expect(script.indexOf('exec /bin/bash')).toBeLessThan(script.indexOf('exec /bin/ash'));
    expect(script.indexOf('exec /bin/ash')).toBeLessThan(script.indexOf('exec /bin/sh'));
  });

  it('starts an explicit choice through itself, with TERM set', () => {
    expect(terminalCommand('/bin/bash')).toEqual(['/bin/bash', '-c', 'export TERM=xterm-256color; exec /bin/bash']);
  });

  it('reads a size from the query string or a resize message', () => {
    expect(parseTerminalSize('132', '40')).toEqual({ columns: 132, rows: 40 });
    expect(parseTerminalSize(132, 40)).toEqual({ columns: 132, rows: 40 });
  });

  it('refuses what is not a terminal size', () => {
    expect(parseTerminalSize('0', '40')).toBeNull();
    expect(parseTerminalSize('12.5', '40')).toBeNull();
    expect(parseTerminalSize('', '40')).toBeNull();
    expect(parseTerminalSize(5000, 40)).toBeNull();
    expect(parseTerminalSize(undefined, undefined)).toBeNull();
  });

  it('starts at 80x24 when the panel sent no size', () => {
    expect(initialTerminalSize(undefined, undefined)).toEqual({ columns: 80, rows: 24 });
    expect(initialTerminalSize('200', '50')).toEqual({ columns: 200, rows: 50 });
  });
});
