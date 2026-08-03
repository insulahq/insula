/**
 * backend/src/cli/platform-ops/ui.ts — the insula console renderer (TypeScript side).
 *
 * The mirror of scripts/lib/ui.sh. Both implement the contract in
 * docs/development/CONSOLE_OUTPUT.md: same phase/step model, same plain-mode
 * prefixes, same mode-detection rules. An operator should not be able to tell
 * which one produced a given line.
 *
 * Deliberately ADDITIVE rather than an interception of Deps.out.
 *
 * `out` carries two very different kinds of traffic: human lines, and 24
 * `out(JSON.stringify(...))` call sites across 8 modules serving `--json`.
 * Decorating `out` centrally would have converted every human line for free —
 * and silently corrupted every machine consumer, which is a worse bug than the
 * one being fixed. So `out`/`err` stay raw passthroughs, and human-facing
 * output moves onto `ui.*` explicitly. `ui.raw()` exists for the JSON path so
 * the intent is visible at the call site rather than implied by absence.
 */

export type UiMode = 'rich' | 'plain';

export interface UiSink {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface UiOptions {
  /** Force a mode. Omit to auto-detect from the environment + TTY. */
  mode?: UiMode;
  /** Environment used for auto-detection (NO_COLOR, TERM, CI). */
  env?: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal. Injected so tests need no pty. */
  isTTY?: boolean;
}

const SYM = {
  ok: '✔',
  warn: '!',
  fail: '✖',
  step: '·',
} as const;

const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  yellow: '[33m',
  red: '[31m',
  blue: '[34m',
} as const;

/**
 * Same precedence as ui.sh's ui_init, and it must stay that way: an operator
 * setting NO_COLOR expects it to hold across the whole binary, not just the
 * half of it written in bash.
 */
export function detectMode(opts: UiOptions = {}): UiMode {
  if (opts.mode) return opts.mode;
  const env = opts.env ?? process.env;
  const tty = opts.isTTY ?? Boolean(process.stdout.isTTY);
  if (!tty) return 'plain';
  if (env.NO_COLOR) return 'plain';
  if (!env.TERM || env.TERM === 'dumb') return 'plain';
  if (env.CI === 'true') return 'plain';
  return 'rich';
}

function bar(done: number, total: number, width = 24): string {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(width, Math.floor((done * width) / total)));
  return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏`;
}

export class Ui {
  readonly mode: UiMode;
  private phaseIndex = 0;
  private totalPhases = 0;
  private warns = 0;
  private fails = 0;

  constructor(
    private readonly sink: UiSink,
    opts: UiOptions = {},
  ) {
    this.mode = detectMode(opts);
  }

  private get rich(): boolean {
    return this.mode === 'rich';
  }

  /** Counters, so a caller can exit non-zero on warnings if it wants to. */
  get counts(): { warnings: number; errors: number } {
    return { warnings: this.warns, errors: this.fails };
  }

  /**
   * Machine output — JSON and anything else a consumer parses. Never decorated,
   * never counted, never routed anywhere but stdout.
   */
  raw(s: string): void {
    this.sink.out(s);
  }

  phaseTotal(n: number): void {
    this.totalPhases = n;
  }

  phase(name: string): void {
    this.phaseIndex += 1;
    if (this.rich) {
      this.sink.out(
        `\n${C.bold}${C.blue}[${this.phaseIndex}/${this.totalPhases}]${C.reset} ` +
          `${C.bold}${name}${C.reset} ${C.dim}${bar(this.phaseIndex - 1, this.totalPhases)}${C.reset}`,
      );
    } else {
      this.sink.out(`PHASE: [${this.phaseIndex}/${this.totalPhases}] ${name}`);
    }
  }

  step(label: string): void {
    if (this.rich) this.sink.out(`  ${C.dim}${SYM.step}${C.reset} ${label}`);
    else this.sink.out(`STEP: ${label}`);
  }

  ok(label: string): void {
    if (this.rich) this.sink.out(`  ${C.green}${SYM.ok}${C.reset} ${label}`);
    else this.sink.out(`OK: ${label}`);
  }

  /** Context worth showing, but not itself an outcome. */
  detail(s: string): void {
    if (this.rich) this.sink.out(`    ${C.dim}${s}${C.reset}`);
    else this.sink.out(`INFO: ${s}`);
  }

  warn(s: string): void {
    this.warns += 1;
    if (this.rich) this.sink.err(`  ${C.yellow}${SYM.warn}${C.reset} ${s}`);
    else this.sink.err(`WARN: ${s}`);
  }

  fail(s: string): void {
    this.fails += 1;
    if (this.rich) this.sink.err(`  ${C.red}${SYM.fail}${C.reset} ${s}`);
    else this.sink.err(`ERROR: ${s}`);
  }

  /**
   * Run a unit of work, showing one line on success and the full detail on
   * failure. `fn` returns the captured output so it can be replayed — the
   * moment it is actually needed, rather than streamed past when it is not.
   */
  async run<T>(
    label: string,
    fn: () => Promise<{ code: number; output?: string; value?: T }>,
  ): Promise<{ code: number; value?: T }> {
    this.step(label);
    const r = await fn();
    if (r.code === 0) {
      this.ok(label);
    } else {
      this.fail(`${label} (exit ${r.code})`);
      if (r.output) {
        for (const line of r.output.split('\n')) {
          if (line.trim()) this.sink.err(this.rich ? `      ${C.dim}${line}${C.reset}` : `    ${line}`);
        }
      }
    }
    return { code: r.code, value: r.value };
  }

  /**
   * Final line. Reports phases ACTUALLY reached — never a bar forced to 100%.
   * A run that stopped at phase 3 of 9 must not sign off looking complete;
   * that reading is the whole reason this layer exists.
   */
  summary(headline: string): void {
    const parts: string[] = [];
    if (this.warns > 0) parts.push(`${this.warns} warning(s)`);
    if (this.fails > 0) parts.push(`${this.fails} error(s)`);
    const counts = parts.length > 0 ? ` — ${parts.join(' ')}` : '';
    if (this.rich) {
      this.sink.out(`\n${C.bold}${headline}${C.reset}${counts}`);
      this.sink.out(
        `${C.dim}${bar(this.phaseIndex, this.totalPhases)} ${this.phaseIndex}/${this.totalPhases} phases${C.reset}`,
      );
    } else {
      this.sink.out(`SUMMARY: ${headline}${counts} (${this.phaseIndex}/${this.totalPhases} phases)`);
    }
  }
}

/** Build a Ui over a Deps-shaped sink. */
export function makeUi(sink: UiSink, opts: UiOptions = {}): Ui {
  return new Ui(sink, opts);
}

/**
 * Resolve the renderer for a Deps, building one over its out/err if the caller
 * did not supply one.
 *
 * This is why `Deps.ui` is optional. Every test fake is constructed with
 * `as unknown as Deps`, so a REQUIRED field would still compile and then be
 * `undefined` at runtime — a crash reachable only from tests, i.e. exactly the
 * kind of breakage a type system is supposed to prevent and here would not.
 * Falling back to the fake's own out/err also means existing tests keep
 * asserting on the arrays they already capture.
 */
export function uiOf(deps: { out: (s: string) => void; err: (s: string) => void; ui?: Ui }): Ui {
  return deps.ui ?? makeUi({ out: deps.out, err: deps.err });
}
