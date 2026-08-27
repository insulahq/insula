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

/**
 * Per-node host-migration status (ADR-045 W10c + ADR-056), relayed to the API by
 * the host-config-reconciler DaemonSet from the status document platform-ops
 * writes after each converge.
 *
 * Exists because a failed migration blocks every later one and was previously
 * invisible until someone SSHed in: the DEV cluster sat at 11 pending behind a
 * single failure for five weeks before anyone noticed.
 */
export const hostMigrationItemSchema = z.object({
  key: z.string(),
  state: z.enum([
    'applied',
    'already-applied',
    'would-run',
    'run-failed',
    'blocked',
    'skipped',
    'invalid',
  ]),
  error: z.string().nullable().optional(),
  /** ADR-056: how many consecutive times this has failed, and since when. */
  attempt: z.number().int().nullable().optional(),
  failingSince: z.string().nullable().optional(),
  /** Operator-recorded reason from a `.skipped` marker. */
  skipReason: z.string().nullable().optional(),
});
export type HostMigrationItem = z.infer<typeof hostMigrationItemSchema>;

export const hostMigrationNodeStatusSchema = z.object({
  node: z.string(),
  /** null when the node has never converged — normal on a fresh install. */
  collectedAt: z.string().nullable(),
  mode: z.string().nullable(),
  source: z.string().nullable(),
  ok: z.boolean().nullable(),
  appliedCount: z.number().int(),
  failedCount: z.number().int(),
  blockedCount: z.number().int(),
  pendingCount: z.number().int(),
  skippedCount: z.number().int(),
  /** A script whose name/version failed validation — it will NEVER run. */
  invalidCount: z.number().int(),
  /**
   * A whole-run refusal, e.g. the catalog exceeded MAX_SCRIPTS. This arrives
   * with `ok: false` and an EMPTY item list — the run never got far enough to
   * produce per-item state — so it must be surfaced on its own, or the node
   * renders as healthy while applying nothing at all.
   */
  reason: z.string().nullable().optional(),
  items: z.array(hostMigrationItemSchema),
  /** Why this node has no data, when it has none. */
  note: z.string().nullable().optional(),
  /**
   * The node has NEVER converged — no host-migration state has ever been
   * relayed from it. This is a fault, not a "not yet".
   *
   * A converge runs hourly from `platform-ops-host-config.timer`, so a node
   * that has been up for more than an hour and still reports nothing does not
   * have that timer. Silence looked identical to health here: the production
   * cluster was bootstrapped 2026-08-13 with the timer never installed (the
   * bootstrap "already at <version>" path skipped it), and sat for two weeks
   * with an EMPTY migration ledger while every page showed green — including
   * the traefik wait-for-plugin-registry fix for its own 2026-08-20 outage.
   */
  neverConverged: z.boolean().optional(),
  /**
   * The reconciler itself is not publishing for this node — the node exists in
   * the cluster but has no host-config-drift ConfigMap at all. Distinct from
   * `neverConverged`: there, the relay works and has nothing to relay.
   */
  reconcilerMissing: z.boolean().optional(),
  /** Shell commands that fix this node, in order. Rendered verbatim in the UI. */
  remediation: z.array(z.string()).optional(),
});
export type HostMigrationNodeStatus = z.infer<typeof hostMigrationNodeStatusSchema>;

export const hostMigrationStatusResponseSchema = z.object({
  nodes: z.array(hostMigrationNodeStatusSchema),
  /** True when ANY node has a failed, blocked or invalid migration, or refused
   *  the whole run. Drives the alert. */
  degraded: z.boolean(),
  /** Runbook the UI links to for remediation. */
  runbookUrl: z.string(),
});
export type HostMigrationStatusResponse = z.infer<typeof hostMigrationStatusResponseSchema>;
