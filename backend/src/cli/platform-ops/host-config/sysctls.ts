/**
 * Sysctl allow-list, deny-list, key→path mapping, and the pure convergence
 * decision tree — ported from the Go enforcer (images/host-config-reconciler)
 * now that host-config writes happen HOST-SIDE in platform-ops. Pure over the
 * HostConfigDeps read/write seam so the whole decision tree (incl. the
 * never-write-not-allowed + deny-list invariants) is unit-testable.
 */

import type { ConvergeResult, HostConfigDeps, SysctlItem, SysctlSpec } from './types.js';

// The host-tunable namespaces the platform manages. A desired key outside these
// is "not-allowed" and never read or written.
const ALLOWED_PREFIXES = ['net.', 'vm.', 'fs.', 'kernel.'] as const;

// Keys WITHIN an allowed prefix that are dangerous to write — they grant host
// root code execution or downgrade kernel hardening, and the platform never
// tunes them. Checked BEFORE the prefix allow-list (refused in both report +
// enforce). kernel.core_pattern (a leading "|" → ROOT RCE on core dump) is the
// reason this list exists; see the Go original for the full rationale.
const DENY_LIST = new Set<string>([
  'kernel.core_pattern',
  'kernel.modprobe',
  'kernel.poweroff_cmd',
  'kernel.hotplug',
  'kernel.sysrq',
  'kernel.dmesg_restrict',
  'kernel.kptr_restrict',
  'kernel.perf_event_paranoid',
  'kernel.unprivileged_bpf_disabled',
  'kernel.yama.ptrace_scope',
  'kernel.randomize_va_space', // =0 disables ASLR system-wide (hardening downgrade)
  'fs.suid_dumpable',
  'fs.protected_hardlinks',
  'fs.protected_symlinks',
  'fs.protected_fifos',
  'fs.protected_regular',
  'net.ipv4.conf.all.route_localnet',
  'net.ipv4.conf.default.route_localnet', // persistent variant of the .all loopback exposure
]);

/** A real sysctl value is a short scalar / space-separated tuple. */
export const MAX_SYSCTL_VALUE_LEN = 1024;

// A real sysctl value is digits/letters/spaces and a few separators. Reject
// control chars (newline, NUL, …) and directive/shell metacharacters (=, |, %,
// …) so a crafted value can never corrupt the /proc write or smuggle a second
// directive into the persisted sysctl.d line. Same injection-safe discipline as
// the ulimits-line and module-name validators in this converger.
const SYSCTL_VALUE_RE = /^[A-Za-z0-9 \t._:,/+-]*$/;

export function sysctlValueValid(value: string): boolean {
  return value.length <= MAX_SYSCTL_VALUE_LEN && SYSCTL_VALUE_RE.test(value);
}

export function sysctlAllowed(key: string): boolean {
  if (DENY_LIST.has(key)) return false;
  return ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Map a dotted sysctl key to its /proc/sys-relative path, or null for any key
 * that could escape /proc/sys (slash, "..", leading/trailing dot, empty
 * component). Mirrors the Go sysctlKeyToPath guard exactly.
 */
export function sysctlKeyToRelPath(key: string): string | null {
  if (key === '' || key.startsWith('.') || key.endsWith('.')) return null;
  if (key.includes('/') || key.includes('..')) return null;
  // Explicit charset: alnum + dot/underscore/hyphen only. Rejects null bytes,
  // whitespace, and any other byte before it can reach a filesystem path (don't
  // rely on the Node runtime incidentally throwing on a NUL).
  if (!/^[A-Za-z0-9._-]+$/.test(key)) return null;
  if (key.split('.').some((part) => part === '')) return null;
  return key.split('.').join('/');
}

/** Collapse whitespace runs to single spaces (matches `sysctl` rendering). */
export function normalizeSysctl(s: string): string {
  return s.trim().split(/\s+/).join(' ');
}

/**
 * Converge drifting, allow-listed sysctls to their desired values. A
 * non-allow-listed OR deny-listed key is "not-allowed" and NEVER read or
 * written (the write path in HostConfigDeps re-checks too). When `enforcing` is
 * false this is a DRY-RUN: drift is reported "would-apply", nothing is written.
 */
export function convergeSysctls(
  specs: readonly SysctlSpec[] | null,
  enforcing: boolean,
  deps: HostConfigDeps,
): ConvergeResult {
  const mode = enforcing ? 'enforce' : 'dry-run';
  if (specs === null) {
    return { ok: true, mode, desiredSource: 'absent', items: [], appliedCount: 0 };
  }
  const items: SysctlItem[] = [];
  // Allow-listed keys whose desired value is currently LIVE in /proc (state
  // 'applied' or 'ok') — the set we persist to the reboot drop-in. Never
  // persist 'write-failed' / 'not-allowed' / 'unreadable': a drop-in line the
  // kernel can't honour would error `sysctl --system` at boot.
  const live: SysctlSpec[] = [];
  let appliedCount = 0;
  let ok = true;
  for (const spec of specs) {
    const want = normalizeSysctl(spec.value);
    if (!sysctlAllowed(spec.key)) {
      items.push({ key: spec.key, desired: want, actual: null, state: 'not-allowed' });
      continue;
    }
    // Refuse a malformed value up front (control/metacharacters) — never attempt
    // the /proc write and never let it reach the persisted drop-in. writeSysctl +
    // renderSysctlDropIn re-check the same, so this is the first of three gates.
    if (!sysctlValueValid(want)) {
      items.push({ key: spec.key, desired: want, actual: null, state: 'not-allowed', error: 'invalid value charset' });
      continue;
    }
    const actual = deps.readSysctl(spec.key);
    if (actual === null) {
      items.push({ key: spec.key, desired: want, actual: null, state: 'unreadable' });
      continue;
    }
    if (normalizeSysctl(actual) === want) {
      items.push({ key: spec.key, desired: want, actual, state: 'ok' });
      live.push({ key: spec.key, value: want });
      continue;
    }
    if (!enforcing) {
      items.push({ key: spec.key, desired: want, actual, state: 'would-apply' });
      continue;
    }
    try {
      deps.writeSysctl(spec.key, want);
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      items.push({ key: spec.key, desired: want, actual, state: 'write-failed', error: message });
      continue;
    }
    const after = deps.readSysctl(spec.key);
    items.push({ key: spec.key, desired: want, actual: after ?? actual, state: 'applied' });
    live.push({ key: spec.key, value: want });
    appliedCount++;
  }
  // Persist only when enforcing (never dry-run/observe — no mutation). Closes
  // the reboot-durability gap: writeSysctl touches /proc (RAM) only, so without
  // a drop-in the values are lost on reboot until the next enforce tick.
  if (enforcing) deps.persistSysctls(live);
  return { ok, mode, desiredSource: 'configmap', items, appliedCount };
}

/**
 * Render the managed /etc/sysctl.d drop-in for a set of live, allow-listed
 * sysctls. PURE + re-validates each key against the allow-list (defence in
 * depth — a deny-listed or out-of-namespace key can never reach the persisted
 * drop-in even if a caller passes one). Stable order = input order.
 */
export function renderSysctlDropIn(specs: readonly SysctlSpec[]): string {
  const header =
    '# Managed by platform-ops host-config (ADR-045 W10) — sysctls applied at boot.\n'
    + '# Generated from host-config-desired when mode: enforce. Edit the\n'
    + '# host-config-desired ConfigMap, not this file.\n';
  const lines = specs
    .map((s) => ({ key: s.key, value: normalizeSysctl(s.value) }))
    .filter((s) => sysctlAllowed(s.key) && sysctlValueValid(s.value))
    .map((s) => `${s.key} = ${s.value}`);
  return lines.length === 0 ? header : `${header}${lines.join('\n')}\n`;
}
