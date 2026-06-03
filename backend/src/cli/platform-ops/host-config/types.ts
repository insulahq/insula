/**
 * Types for `platform-ops host-config` (ADR-045 W10, amended) — HOST-SIDE
 * convergence. platform-ops runs as root on the host, in the host's namespaces,
 * so it writes /proc/sys (and later loads modules / writes limits.d / installs
 * packages) NATIVELY — no privileged cluster pod, no special caps. The cluster
 * only DECLARES intent (host-config-desired ConfigMap); the always-on read-only
 * observe DaemonSet still surfaces drift to the admin UI.
 *
 * This PR covers SYSCTLS; packages / ulimits / kernel-modules / host-migrations
 * plug into the same `HostConfigDeps` seam as follow-ups.
 */

export type SysctlState =
  | 'ok' // live value already matches desired
  | 'applied' // drifted, now written (enforce)
  | 'would-apply' // drifted, dry-run (no write)
  | 'unreadable' // not present / unreadable on this host
  | 'not-allowed' // outside the allow-list OR on the deny-list — never read/written
  | 'write-failed';

export interface SysctlItem {
  readonly key: string;
  readonly desired: string;
  readonly actual: string | null;
  readonly state: SysctlState;
  readonly error?: string;
}

export interface ConvergeResult {
  readonly ok: boolean;
  readonly mode: 'enforce' | 'dry-run';
  readonly desiredSource: 'configmap' | 'absent';
  readonly items: readonly SysctlItem[];
  readonly appliedCount: number;
  readonly reason?: string;
}

export interface HostConfigOptions {
  /** Force a dry-run regardless of the desired policy's mode. */
  readonly dryRun: boolean;
  /** Force apply regardless of the desired policy's mode (manual operator run). */
  readonly apply: boolean;
}

/** One declared sysctl. */
export interface SysctlSpec {
  readonly key: string;
  readonly value: string;
}

export interface HostConfigDeps {
  /** Read host-config-desired (sysctls + mode) from the cluster; null = absent/unreachable. */
  readonly readDesired: () => Promise<{ sysctls: readonly SysctlSpec[]; mode: string } | null>;
  /** Live /proc/sys value for a key, or null if unreadable. */
  readonly readSysctl: (key: string) => string | null;
  /** Write a sysctl (re-validates allow-list + deny-list + containment); throws on refusal. */
  readonly writeSysctl: (key: string, value: string) => void;
}
