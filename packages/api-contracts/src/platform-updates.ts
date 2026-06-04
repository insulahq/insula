import { z } from 'zod';

export const platformVersionResponseSchema = z.object({
  // Version spine (ADR-045): the three coordinates a consumer should read.
  //   installed — durable record of the release the cluster is on (DB row)
  //   running   — the live pod's version (platform-version ConfigMap → env)
  //   available — newest upstream release seen (null until the poller finds one)
  installed: z.string(),
  running: z.string(),
  available: z.string().nullable(),
  // Back-compat aliases retained for existing consumers: currentVersion === running,
  // latestVersion === available.
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  // Where latestVersion came from. 'none' means the upstream repo has no
  // GitHub releases AND no git tags yet — common on fresh installs. The UI
  // uses this to show a sensible message ("no releases published") instead
  // of an em-dash, and to pick the right CTA for auto-update environments.
  latestSource: z.enum(['releases', 'tags', 'none', 'unreachable']),
  updateAvailable: z.boolean(),
  environment: z.string(),
  autoUpdate: z.boolean(),
  imageUpdateStrategy: z.enum(['auto', 'manual']),
  pendingVersion: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  // W11 verified version-poller (ADR-045): `available` prefers the cosign-VERIFIED
  // value; these expose its provenance so the UI can distinguish a verified
  // available version from the unverified `latestVersion` fallback.
  //   availableVerifiedAt   — ISO timestamp of the last successful verify (null = none yet)
  //   availableVerifyStatus — last poll outcome: 'verified' | 'unsigned' |
  //                           'verify-failed' | 'invalid-manifest' | 'no-releases' (null = never polled)
  //   includePrereleases    — whether the poller considers prerelease tags
  availableVerifiedAt: z.string().nullable(),
  availableVerifyStatus: z.string().nullable(),
  includePrereleases: z.boolean(),
});

export const updateSettingsSchema = z.object({
  autoUpdate: z.boolean(),
  // Optional: when present, persists the poller's prerelease-inclusion flag.
  includePrereleases: z.boolean().optional(),
});

export const triggerUpdateResponseSchema = z.object({
  message: z.string(),
  targetVersion: z.string(),
});

// ── Upgrade pre-flight + apply (ADR-045 W14) ─────────────────────────────────
export const upgradeGateSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string(),
});

export const upgradePreflightResponseSchema = z.object({
  gates: z.array(upgradeGateSchema),
  ok: z.boolean(),
  failures: z.number(),
  warnings: z.number(),
  environment: z.string(),
});

export const upgradeApplyRequestSchema = z.object({
  /** Explicit target version (CalVer); omitted → the verified available version.
   *  Charset-pinned here (defence-in-depth + no log-injection) on top of the
   *  downstream isValidVersion / gitTagForVersion / patch-time re-validation. */
  version: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]{1,40})?$/, 'version must be CalVer X.Y.Z[-suffix]')
    .optional(),
  /** false (default) = dry-run plan only; true = perform the Flux re-pin. */
  apply: z.boolean().optional(),
});

export const upgradeApplyResponseSchema = z.object({
  action: z.string(),
  target: z.string().nullable(),
  reason: z.string(),
  proceed: z.boolean(),
  applied: z.boolean(),
  gitRepository: z.string().nullable(),
  environment: z.string(),
  summary: z.string(),
});

export const rollbackRequestSchema = z.object({
  /** false (default) = dry-run preview; true = perform the rollback re-pin. */
  apply: z.boolean().optional(),
  /** false (default) = revision only; true = ALSO revert Longhorn snapshots (destructive). */
  restoreData: z.boolean().optional(),
});
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

// ── Upgrade post-flight (ADR-045 W14 follow-up) ──────────────────────────────
// After an apply re-pins Flux, the cluster reconciles asynchronously. Post-flight
// observes convergence (running==target, CNPG healthy, Deployments available, no
// crashloops). A still-reconciling result right after the re-pin is EXPECTED; it
// only becomes actionable once it persists for `abortThreshold` consecutive
// observations (the scheduler's controlled cadence), at which point the verdict
// flips to `abort-recommended` so the operator can roll back.
export const upgradePostflightResponseSchema = z.object({
  /** idle = no upgrade in flight; reconciling = applied, not yet converged; healthy = converged + clean. */
  phase: z.enum(['idle', 'reconciling', 'healthy']),
  /** Escalation verdict over the consecutive-failure streak. */
  verdict: z.enum(['idle', 'healthy', 'reconciling', 'abort-recommended']),
  /** How many consecutive non-healthy observations have accrued (reset to 0 on healthy/idle). */
  consecutiveFailures: z.number(),
  /** consecutiveFailures at/above this → verdict `abort-recommended`. */
  abortThreshold: z.number(),
  /** The in-flight target version (platform_settings pending_update_version), or null when idle. */
  pendingVersion: z.string().nullable(),
  /** The live pod's running version. */
  runningVersion: z.string(),
  gates: z.array(upgradeGateSchema),
  ok: z.boolean(),
  failures: z.number(),
  warnings: z.number(),
  /** ISO timestamp of the last observer run that advanced the streak, or null if never run. */
  lastCheckedAt: z.string().nullable(),
  environment: z.string(),
});
export type UpgradePostflightResponse = z.infer<typeof upgradePostflightResponseSchema>;

// ── Host-migration preview (ADR-045 W14 follow-up) ───────────────────────────
// Host-migration SCRIPTS are embedded in the platform-ops binary (they travel
// with each release), so the backend cannot enumerate the actual pending scripts.
// What it CAN surface is whether host-migrations would RUN during an upgrade —
// the `host-migrations-desired` ConfigMap mode (observe = report-only, enforce =
// applied by the daily host-config timer / on the next platform-ops run).
export const hostMigrationsPreviewResponseSchema = z.object({
  /** observe = report-only; enforce = applied; absent = no policy CM; unknown = unreadable. */
  mode: z.enum(['observe', 'enforce', 'absent', 'unknown']),
  /** True only when mode === enforce (host-migrations actually run). */
  willRun: z.boolean(),
  /** Operator-facing one-liner. */
  note: z.string(),
});
export type HostMigrationsPreviewResponse = z.infer<typeof hostMigrationsPreviewResponseSchema>;

export type PlatformVersionResponse = z.infer<typeof platformVersionResponseSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type TriggerUpdateResponse = z.infer<typeof triggerUpdateResponseSchema>;
export type UpgradeGate = z.infer<typeof upgradeGateSchema>;
export type UpgradePreflightResponse = z.infer<typeof upgradePreflightResponseSchema>;
export type UpgradeApplyRequest = z.infer<typeof upgradeApplyRequestSchema>;
export type UpgradeApplyResponse = z.infer<typeof upgradeApplyResponseSchema>;
