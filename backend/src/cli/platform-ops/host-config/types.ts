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

// ── Package convergence (W10b) ───────────────────────────────────────────────
// Declared OS packages are kept PRESENT on every node. ADDITIVE-ONLY: the
// converger installs missing packages (optionally at a pinned version) and
// NEVER removes, purges, or auto-downgrades — a daily timer that churned live
// package versions or removed undeclared packages would be a foot-cannon.

export type PackageManagerFamily = 'apt' | 'dnf';

export type PackageState =
  | 'ok' // installed (and pin matches, if pinned)
  | 'installed' // was missing, now installed (enforce)
  | 'would-install' // missing, dry-run (no action)
  | 'version-mismatch' // installed at a version other than the pin — REPORTED, never auto-changed
  | 'not-allowed' // invalid package name / version — never acted on
  | 'install-failed'
  | 'unsupported'; // host has neither apt nor dnf

export interface PackageItem {
  readonly name: string;
  readonly desiredVersion: string | null;
  readonly actualVersion: string | null;
  readonly state: PackageState;
  readonly error?: string;
}

export interface PackageConvergeResult {
  readonly ok: boolean;
  readonly mode: 'enforce' | 'dry-run';
  readonly desiredSource: 'configmap' | 'absent';
  readonly family: PackageManagerFamily | null;
  readonly items: readonly PackageItem[];
  readonly installedCount: number;
  /** Set when the run was refused wholesale (e.g. the policy exceeds the spec cap). */
  readonly reason?: string;
}

/** One declared package: a name, with an optional pinned version. */
export interface PackageSpec {
  readonly name: string;
  readonly version: string | null;
}

export interface PackageDeps {
  /** Read host-packages-desired (packages + mode); null = absent/unreachable. */
  readonly readDesiredPackages: () => Promise<{ packages: readonly PackageSpec[]; mode: string } | null>;
  /** Which package manager this host uses, or null if neither apt nor dnf is present. */
  readonly detectFamily: () => PackageManagerFamily | null;
  /** Query the installed state of one package by exact name. */
  readonly queryInstalled: (name: string) => { installed: boolean; version: string | null };
  /** Install a package (re-validates name+version; argv, no shell; `--` separator); throws on failure. */
  readonly installPackage: (family: PackageManagerFamily, name: string, version: string | null) => void;
}

// ── Host-migration runner (W10c) ─────────────────────────────────────────────
// Per-release one-shot imperative shell scripts, shipped EMBEDDED in the
// platform-ops binary so they travel with every self-upgrade (perfect
// version-binding). Each node applies any pending scripts in (version, name)
// order, records completion with a marker file, HALTS on the first failure, and
// is opt-in gated (host-migrations-desired mode=enforce) exactly like sysctls +
// packages. Scripts are platform-authored (not operator/ConfigMap input) and
// must be idempotent + order-stable (see scripts/ci-host-migrations-check.sh).

export type HostMigrationState =
  | 'already-applied' // marker present → skipped
  | 'applied' // ran successfully this pass (enforce)
  | 'would-run' // pending, dry-run (no action)
  | 'run-failed' // ran, non-zero exit → HALTS the pass
  | 'blocked' // a prior script in this pass failed → not attempted
  | 'invalid'; // failed catalog validation (bad version/name) → never run

export interface HostMigrationItem {
  readonly key: string; // "<version>/<name>" — marker + ordering key
  readonly state: HostMigrationState;
  readonly error?: string;
}

export interface HostMigrationResult {
  readonly ok: boolean;
  readonly mode: 'enforce' | 'dry-run';
  readonly source: 'embedded' | 'filesystem' | 'absent';
  readonly items: readonly HostMigrationItem[];
  readonly appliedCount: number;
  /** Set when the catalog was refused wholesale (e.g. exceeds the script cap). */
  readonly reason?: string;
}

/** One shipped host-migration script discovered in the catalog. */
export interface HostMigrationScript {
  readonly version: string; // CalVer dir, e.g. "2026.6.3"
  readonly name: string; // file name, e.g. "0001-bump-inotify.sh"
  readonly key: string; // "<version>/<name>"
  readonly body: string; // script contents
}

export interface HostMigrationDeps {
  /** host-migrations-desired mode (enforce|observe|…); null = absent/unreachable. */
  readonly readMode: () => Promise<string | null>;
  /** Has this script already applied on this node (marker present)? */
  readonly isApplied: (key: string) => boolean;
  /** Record a script as applied (write its marker); throws on failure. */
  readonly markApplied: (key: string) => void;
  /** Run a script (bash, argv-only, timeout); throws on non-zero exit. */
  readonly runScript: (script: HostMigrationScript) => void;
  /** Where the catalog came from (for reporting). */
  readonly source: 'embedded' | 'filesystem' | 'absent';
}
