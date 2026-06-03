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
  let appliedCount = 0;
  let ok = true;
  for (const spec of specs) {
    const want = normalizeSysctl(spec.value);
    if (!sysctlAllowed(spec.key)) {
      items.push({ key: spec.key, desired: want, actual: null, state: 'not-allowed' });
      continue;
    }
    const actual = deps.readSysctl(spec.key);
    if (actual === null) {
      items.push({ key: spec.key, desired: want, actual: null, state: 'unreadable' });
      continue;
    }
    if (normalizeSysctl(actual) === want) {
      items.push({ key: spec.key, desired: want, actual, state: 'ok' });
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
    appliedCount++;
  }
  return { ok, mode, desiredSource: 'configmap', items, appliedCount };
}
