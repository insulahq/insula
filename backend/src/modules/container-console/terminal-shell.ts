/**
 * The command a deployment terminal runs in the container, and its size.
 *
 * Arrow-up (history) and Tab (completion) did not work in the panel's
 * terminal. The keys arrived; the shell could not use them:
 *  - the default was `/bin/sh`, which on Debian and Ubuntu images is dash —
 *    built without line editing, so arrow-up printed `^[[A` and Tab a tab;
 *  - `kubectl exec` sets no `TERM`, so even bash's readline started on a
 *    terminal it did not know;
 *  - the size the panel reported was dropped, so the shell kept 80 columns
 *    and a recalled command longer than that redrew garbled.
 * `auto` (the default) now picks the first shell with line editing the image
 * has, the shell starts with TERM set, and the size reaches the pod.
 */

/** `auto` first: what the panel offers, and the only values accepted. */
export const TERMINAL_SHELLS = ['auto', '/bin/bash', '/bin/ash', '/bin/sh'] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

/** The panel's terminal is xterm.js, which speaks xterm-256color. */
const TERM_SETUP = 'export TERM=xterm-256color';

/**
 * bash and busybox ash have line editing, history and completion; dash (the
 * Debian /bin/sh) has none, so it is the last resort.
 */
const AUTO_SHELL = 'if [ -x /bin/bash ]; then exec /bin/bash; elif [ -x /bin/ash ]; then exec /bin/ash; else exec /bin/sh; fi';

export function parseTerminalShell(value: string | undefined): TerminalShell {
  return (TERMINAL_SHELLS as readonly string[]).includes(value ?? '') ? (value as TerminalShell) : 'auto';
}

/**
 * The exec command for `shell`. An explicit choice starts through itself, so
 * an image without /bin/sh still gets the bash it asked for; `auto` needs a
 * POSIX shell to look around with. Only the fixed values above are ever
 * placed in the script.
 */
export function terminalCommand(shell: TerminalShell): string[] {
  if (shell === 'auto') return ['/bin/sh', '-c', `${TERM_SETUP}; ${AUTO_SHELL}`];
  return [shell, '-c', `${TERM_SETUP}; exec ${shell}`];
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 };
const MAX_COLUMNS = 1000;
const MAX_ROWS = 500;

const dimension = (value: unknown, max: number): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
};

/** A size from the panel (query string or resize message), or null if it is not one. */
export function parseTerminalSize(cols: unknown, rows: unknown): TerminalSize | null {
  const c = dimension(cols, MAX_COLUMNS);
  const r = dimension(rows, MAX_ROWS);
  return c !== null && r !== null ? { columns: c, rows: r } : null;
}

/** The size to start with: the panel's, or the classic 80x24 when it sent none. */
export function initialTerminalSize(cols: unknown, rows: unknown): TerminalSize {
  return parseTerminalSize(cols, rows) ?? DEFAULT_SIZE;
}
