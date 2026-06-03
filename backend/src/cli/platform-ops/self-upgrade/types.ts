/**
 * Types for `platform-ops self-upgrade` (ADR-045 W11.5). The orchestrator
 * (upgrade.ts) is pure over `SelfUpgradeDeps`, so the whole flow — target
 * resolution, version gating, cosign verify, atomic replace — is unit-testable
 * with no network, k8s, or filesystem.
 */

/** Where the target version came from. */
export type TargetSource =
  | 'explicit' // operator passed --version X.Y.Z
  | 'configmap' // cluster-up: the running version from the platform-version ConfigMap
  | 'releases'; // cluster-down fallback: newest stable GitHub Release

export type SelfUpgradeAction =
  | 'upgraded' // downloaded + cosign-verified + atomically replaced
  | 'already-current' // target not newer than current, and no --force
  | 'no-target' // couldn't determine a target (cluster unreachable + offline)
  | 'download-failed' // binary/sig download failed (transient)
  | 'verify-failed' // signature did not verify / key unreadable (SECURITY — fail-closed)
  | 'replace-failed' // atomic replace failed (permissions / cross-device)
  | 'invalid-version'; // bad --version argument

export interface SelfUpgradeOptions {
  /** 'check' = the unattended daily-timer mode; 'apply' = an interactive run.
   * Both APPLY a newer verified version — they differ only in output verbosity
   * and in how transient download failures map to exit codes. */
  readonly mode: 'check' | 'apply';
  /** Apply even if the target is not strictly newer (reinstall / pinned downgrade). */
  readonly force: boolean;
  /** Explicit target version (overrides cluster/Release resolution). */
  readonly version?: string;
}

export interface SelfUpgradeResult {
  /** false when the outcome warrants operator attention (download/verify/replace
   * failure or a bad version). NOTE: not a 1:1 exit-code proxy — the command
   * layer maps `download-failed` to exit 0 under --check (transient, don't flap
   * the timer) despite ok:false. Branch on `action`, not `ok`, for exit codes. */
  readonly ok: boolean;
  readonly action: SelfUpgradeAction;
  readonly current: string;
  readonly target: string | null;
  readonly source: TargetSource | null;
  readonly arch: string;
  readonly reason?: string;
}

export interface SelfUpgradeDeps {
  /** The version compiled into the running binary (PLATFORM_OPS_VERSION → /etc/platform/VERSION → 'unknown'). */
  readonly currentVersion: () => string;
  /** Release-asset arch token: 'amd64' | 'arm64' (from process.arch). */
  readonly arch: () => string;
  /** Cluster-up: the cluster's RUNNING version from the platform-version ConfigMap; null if unreachable. */
  readonly readRunningVersion: () => Promise<string | null>;
  /** Cluster-down fallback: newest stable released version from GitHub Releases; null if unreachable. */
  readonly fetchLatestReleaseVersion: () => Promise<string | null>;
  /** Download a release asset (the binary or its .sig) for version+arch; null on any failure. */
  readonly downloadAsset: (version: string, arch: string, kind: 'bin' | 'sig') => Promise<Buffer | null>;
  /** The pinned cosign public key PEM (host trust anchor, /etc/platform/cosign.pub); null if unreadable. */
  readonly readPublicKey: () => string | null;
  /** Verify a cosign-format signature over the binary bytes (pure Node crypto). */
  readonly verify: (binary: Buffer, signatureB64: string, pubKeyPem: string) => boolean;
  /** Atomically replace the running binary with `binary`; false on any failure. */
  readonly atomicReplace: (binary: Buffer) => Promise<boolean>;
  readonly log: (level: 'info' | 'warn', msg: string) => void;
}
