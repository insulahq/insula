/**
 * ulimits convergence (ADR-045 W10 follow-up) — render the platform's desired
 * limits into a single managed drop-in (/etc/security/limits.d/90-platform.conf)
 * and write it when it drifts. Pure over the UlimitDeps read/write seam.
 *
 * Each desired line must be valid limits.conf syntax (`<domain> <type> <item>
 * <value>`); a malformed line is DROPPED (reported in invalidLines), never
 * written — so a bad ConfigMap can't corrupt the drop-in.
 */
import type { UlimitConvergeResult, UlimitDeps } from './types.js';

// <domain> <type:soft|hard|-> <item> <value:unlimited|N|-N>. domain charset is
// limits.conf's: *, %group, @group, user, ranges — but NO whitespace/shell metas.
// The domain's first real char is non-dash (an optional single leading `-` is
// pam_limits' negation prefix); this rejects `--flag`-lookalike domains. The
// value admits negative integers (e.g. `nice -20`, `-1` = unlimited).
const LIMIT_LINE = /^-?[*%@A-Za-z0-9_][*%@A-Za-z0-9_.:-]*[ \t]+(soft|hard|-)[ \t]+[a-z][a-z_]*[ \t]+(unlimited|-?[0-9]+)$/;

// A limits.conf with more lines than any plausible real one is refused wholesale
// (mirrors host-packages' MAX_PACKAGE_SPECS) — never partially written.
const MAX_ULIMIT_LINES = 200;

export const DROP_IN_HEADER =
  '# Managed by platform-ops host-config (ADR-045 W10). Do NOT edit — overwritten on converge.';

export function ulimitLineValid(line: string): boolean {
  return LIMIT_LINE.test(line.trim());
}

/** Render desired lines into the canonical drop-in content + the valid/invalid split. */
export function renderUlimits(lines: readonly string[]): { content: string; valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) continue;
    if (ulimitLineValid(t)) valid.push(t.replace(/[ \t]+/g, ' '));
    else invalid.push(t);
  }
  // Trailing newline — a limits.d file should end with one.
  const content = [DROP_IN_HEADER, ...valid, ''].join('\n');
  return { content, valid, invalid };
}

export function convergeUlimits(
  lines: readonly string[] | null,
  enforcing: boolean,
  deps: UlimitDeps,
): UlimitConvergeResult {
  const mode: 'enforce' | 'dry-run' = enforcing ? 'enforce' : 'dry-run';
  if (lines === null) {
    return { ok: true, mode, desiredSource: 'absent', state: 'absent', invalidLines: [], detail: 'no ulimit policy' };
  }
  const { content, valid, invalid } = renderUlimits(lines);
  if (valid.length + invalid.length > MAX_ULIMIT_LINES) {
    // Refuse the whole policy — never partially write a suspiciously large list.
    return {
      ok: false,
      mode,
      desiredSource: 'configmap',
      state: 'refused',
      invalidLines: [],
      detail: `host-ulimits-desired declares ${valid.length + invalid.length} limit lines (> ${MAX_ULIMIT_LINES} cap) — refusing`,
    };
  }
  const current = deps.readCurrent();
  const base = { mode, desiredSource: 'configmap' as const, invalidLines: invalid };

  if (current === content) {
    return { ok: true, ...base, state: 'ok', detail: `drop-in matches (${valid.length} limit line(s))` };
  }
  if (!enforcing) {
    return { ok: true, ...base, state: 'would-write', detail: `drop-in differs (${valid.length} desired line(s))` };
  }
  try {
    deps.writeDropIn(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, ...base, state: 'write-failed', detail: message };
  }
  return { ok: true, ...base, state: 'written', detail: `wrote ${valid.length} limit line(s)` };
}
