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
  /**
   * Persist the given live, allow-listed sysctls to the managed /etc/sysctl.d
   * drop-in so they survive a reboot — a /proc write alone is RAM-only and the
   * kernel resets it at boot. Re-validates each key against the allow-list
   * before rendering; called only when enforcing.
   */
  readonly persistSysctls: (specs: readonly SysctlSpec[]) => void;
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
  | 'run-failed' // ran, non-zero exit → halts the pass iff it blocks-on-failure
  | 'blocked' // a prior BLOCKING script failed this pass → not attempted
  | 'skipped' // operator recorded a .skipped marker — never ran, never blocks
  | 'deferred' // `phase: after-services`, and the services have not reached its release yet (ADR-064)
  | 'invalid'; // failed catalog validation (bad version/name/phase) → never run

/**
 * ADR-064 §3. When a host-migration runs relative to the services' roll.
 *  - before-services (default): runs as soon as the node has the release's CLI —
 *    during an upgrade, BEFORE the services roll — so it must work with the
 *    release still running.
 *  - after-services: may rely on what the new release deploys; runs only once
 *    the services run that release (the platform-version ConfigMap, which Flux
 *    changes together with the containers), and must not break the previous one.
 */
export type HostMigrationPhase = 'before-services' | 'after-services';

export interface HostMigrationItem {
  readonly key: string; // "<version>/<name>" — marker + ordering key
  readonly state: HostMigrationState;
  readonly error?: string;
  /**
   * ADR-056 §3. Consecutive failures recorded for this script, and when it first
   * started failing. A wedge announces itself instead of repeating one silent
   * line forever — DEV sat at 11-pending behind one failure for five weeks.
   */
  readonly attempt?: number;
  readonly failingSince?: string;
  /** Operator-supplied reason from the .skipped marker (ADR-056 §2). */
  readonly skipReason?: string;
  /**
   * ADR-056 §5. Set (always `true`) on an `already-applied` item whose ledger
   * entry is a `.baseline` marker: a fresh bootstrap of that release already
   * produced its end state, so it was never run on this node. Absent for a
   * script that really ran (`.done`), which takes precedence.
   */
  readonly baseline?: boolean;
  /** ADR-064 §3. The script's declared phase (absent only for an invalid script). */
  readonly phase?: HostMigrationPhase;
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

/**
 * ADR-056 §1. Does a failure of this script stop later ones?
 *
 * Parsed from the `# blocks-on-failure: yes|no` header. ABSENT MEANS YES: the
 * safe default is that a failure halts, because a later migration may assume an
 * earlier one applied. `no` is a claim the author makes about their own script —
 * that nothing later depends on it — and is reviewed like any other code.
 */
/**
 * ADR-064 §3. The `# phase: before-services|after-services` header. ABSENT MEANS
 * before-services — every script shipped before the header existed ran that way
 * (or was baselined). An unrecognised value returns null: the script is invalid
 * and never runs (CI rejects it before it ships).
 */
export function hostMigrationPhase(body: string): HostMigrationPhase | null {
  for (const line of body.split('\n', 40)) {
    const m = /^#\s*phase:\s*(\S+)/i.exec(line.trim());
    if (m) {
      const v = (m[1] ?? '').toLowerCase();
      return v === 'before-services' || v === 'after-services' ? v : null;
    }
  }
  return 'before-services';
}

export function hostMigrationBlocksOnFailure(body: string): boolean {
  for (const line of body.split('\n', 40)) {
    const m = /^#\s*blocks-on-failure:\s*(\S+)/i.exec(line.trim());
    if (m) return (m[1] ?? '').toLowerCase() !== 'no';
  }
  return true;
}

export interface HostMigrationDeps {
  /** host-migrations-desired mode (enforce|observe|…); null = absent/unreachable. */
  readonly readMode: () => Promise<string | null>;
  /**
   * ADR-064 §3. The release the services run (the platform-version ConfigMap),
   * read before the pass. An after-services script runs only once this has
   * reached its release; null (unreadable) defers every after-services script.
   */
  readonly servicesVersion?: string | null;
  /** Has this script already applied on this node (marker present)? */
  readonly isApplied: (key: string) => boolean;
  /** Record a script as applied (write its marker); throws on failure. */
  readonly markApplied: (key: string) => void;
  /**
   * Operator-recorded skip for this script, or null. ADR-056 §2 — an honest
   * escape hatch, distinct from `.done`, so the node never reports `applied`
   * for something a human decided to skip.
   */
  readonly readSkip?: (key: string) => { reason: string } | null;
  /**
   * ADR-056 §5. Does this script carry a `.baseline` marker (stamped by
   * `host-config baseline` on a fresh node)? Treated as applied — never run —
   * but reported as such, never as `.done`. Optional: absent = no baselines.
   */
  readonly readBaseline?: (key: string) => boolean;
  /**
   * Consecutive-failure bookkeeping (ADR-056 §3). `noteFailure` returns the
   * updated count + first-seen so the report can escalate; `clearFailure` is
   * called when a script finally applies.
   */
  readonly noteFailure?: (key: string) => { attempt: number; failingSince: string };
  readonly clearFailure?: (key: string) => void;
  /** Run a script (bash, argv-only, timeout); throws on non-zero exit. */
  readonly runScript: (script: HostMigrationScript) => void;
  /** Where the catalog came from (for reporting). */
  readonly source: 'embedded' | 'filesystem' | 'absent';
}

// ── host-config baseline (ADR-056 §5) ────────────────────────────────────────
// A FRESH node's ledger is empty, so its first converge would replay every
// migration ever shipped — even though bootstrap.sh at release X already
// produced the end state of every migration <= X. `host-config baseline` stamps
// those as `.baseline` (never `.done`: they never ran here) so they are skipped.

/** The ledger marker kinds that record a script as dealt with on this node. */
export type HostMigrationMarkerKind = 'done' | 'skipped' | 'baseline';

export interface HostMigrationCatalog {
  readonly source: 'embedded' | 'filesystem' | 'absent';
  readonly scripts: readonly HostMigrationScript[];
}

export interface HostMigrationBaselineOptions {
  /** Release the node was bootstrapped at; scripts with version <= this are stamped. */
  readonly upTo: string;
  /** Stamp even though the ledger shows converge history (NOT a fresh node). */
  readonly force: boolean;
  /** Report only — write nothing. */
  readonly dryRun: boolean;
}

export interface HostMigrationBaselineDeps {
  /** The ledger marker this script already has (.done > .skipped > .baseline), or null. */
  readonly existingMarker: (key: string) => HostMigrationMarkerKind | null;
  /**
   * Evidence this node has ALREADY converged: counts of `.done` (ran) and
   * `.failing` (attempted) markers anywhere in the ledger. Throws when the
   * ledger cannot be read — freshness is then unproven and baseline refuses.
   */
  readonly ledgerHistory: () => { done: number; failing: number };
  /** Write `<name>.baseline` with this content (0644, contained path, never overwrites); throws on failure. */
  readonly writeBaseline: (key: string, content: string) => void;
  readonly now: () => Date;
}

export interface HostMigrationBaselineResult {
  /** ok → exit 0 · refused (node has converge history, no --force) → exit 3 · failed → exit 1. */
  readonly status: 'ok' | 'refused' | 'failed';
  readonly dryRun: boolean;
  readonly upTo: string;
  readonly source: 'embedded' | 'filesystem' | 'absent';
  /** Keys stamped this run (or that WOULD be, in a dry-run). */
  readonly stamped: readonly string[];
  /** Keys <= upTo that already carry a .done / .skipped / .baseline marker. */
  readonly alreadyRecorded: readonly string[];
  /** Keys > upTo — left pending; the next converge runs them. */
  readonly pending: readonly string[];
  /** Keys that failed catalog validation — never stamped, never run. */
  readonly invalid: readonly string[];
  readonly failed: readonly { readonly key: string; readonly error: string }[];
  /** Why the run was refused / failed as a whole. */
  readonly reason?: string;
}

// ── ulimits / limits.d (W10 follow-up) ───────────────────────────────────────
// Render the platform's desired limits into a single managed drop-in,
// /etc/security/limits.d/90-platform.conf. File-level converge (compare+write),
// mode-gated like sysctls/packages.

export type UlimitState =
  | 'ok' // drop-in already matches desired
  | 'would-write' // differs, dry-run
  | 'written' // differs, written (enforce)
  | 'write-failed'
  | 'refused' // policy exceeds the line cap — never written
  | 'absent'; // no policy

export interface UlimitConvergeResult {
  readonly ok: boolean;
  readonly mode: 'enforce' | 'dry-run';
  readonly desiredSource: 'configmap' | 'absent';
  readonly state: UlimitState;
  /** limits.conf lines that failed validation and were dropped. */
  readonly invalidLines: readonly string[];
  readonly detail: string;
}

export interface UlimitDeps {
  readonly readDesired: () => Promise<{ lines: readonly string[]; mode: string } | null>;
  /** Current managed drop-in content, or null if absent. */
  readonly readCurrent: () => string | null;
  /** Write the managed drop-in (validated content); throws on refusal. */
  readonly writeDropIn: (content: string) => void;
}

// ── kernel modules (W10 follow-up) ───────────────────────────────────────────
// Ensure declared kernel modules are loaded (and persisted via modules-load.d).
// ADDITIVE-ONLY: load missing modules; never unload.

export type ModuleState =
  | 'loaded' // already loaded
  | 'would-load' // not loaded, dry-run
  | 'loaded-now' // loaded this pass (enforce)
  | 'load-failed'
  | 'not-allowed'; // invalid module name — never loaded

export interface ModuleItem {
  readonly name: string;
  readonly state: ModuleState;
  readonly error?: string;
}

export interface ModuleConvergeResult {
  readonly ok: boolean;
  readonly mode: 'enforce' | 'dry-run';
  readonly desiredSource: 'configmap' | 'absent';
  readonly items: readonly ModuleItem[];
  readonly loadedCount: number;
  /** Set when the policy was refused wholesale (e.g. exceeds the module cap). */
  readonly reason?: string;
}

export interface ModuleSpec {
  readonly name: string;
}

export interface ModuleDeps {
  readonly readDesired: () => Promise<{ modules: readonly ModuleSpec[]; mode: string } | null>;
  readonly isLoaded: (name: string) => boolean;
  /** Load a module (re-validates name; modprobe argv-only) + persist; throws on failure. */
  readonly loadModule: (name: string) => void;
}
