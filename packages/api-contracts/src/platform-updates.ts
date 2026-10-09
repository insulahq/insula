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
  /**
   * A `warn` that only means "a scheduled process has not run yet" — e.g. nodes
   * that apply the release's host changes on their own update timer. Rendered
   * neutrally (catching up), never as a fault. Absent = an ordinary gate.
   */
  scheduled: z.boolean().optional(),
});

export const upgradePreflightResponseSchema = z.object({
  gates: z.array(upgradeGateSchema),
  ok: z.boolean(),
  failures: z.number(),
  warnings: z.number(),
  environment: z.string(),
});

/** A Kubernetes node name (DNS-1123 subdomain). */
const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export const upgradeApplyRequestSchema = z.object({
  /** Explicit target version (CalVer); omitted → the verified available version.
   *  Charset-pinned here (defence-in-depth + no log-injection) on top of the
   *  downstream isValidVersion / gitTagForVersion / patch-time re-validation. */
  version: z
    .string()
    .max(64)
    .regex(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]{1,40})?$/, 'version must be CalVer X.Y.Z[-suffix]')
    .optional(),
  /** false (default) = dry-run plan only; true = start the upgrade run. */
  apply: z.boolean().optional(),
  /**
   * ADR-064 §5: nodes the operator chooses to upgrade WITHOUT (offline at the
   * start). They catch up through their own update timer when they return.
   * Node names are DNS-1123 subdomains.
   */
  excludeNodes: z
    .array(z.string().max(253).regex(NODE_NAME_RE, 'not a node name'))
    .max(100)
    .optional(),
});

/** GET …/upgrade/preflight?exclude=a,b — the same exclusions the apply would carry. */
export const upgradePreflightQuerySchema = z.object({
  exclude: z
    .string()
    .max(4096)
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter((s) => s !== '') : []))
    .pipe(z.array(z.string().max(253).regex(NODE_NAME_RE, 'not a node name')).max(100)),
});

// ── What a release brings (ADR-064 §6) ───────────────────────────────────────
/**
 * Carried in the cosign-signed release manifest (release.yml) and stored by the
 * version poller once verified. Bounded and charset-pinned on top of the
 * signature: it is rendered in the upgrade review.
 */
// The key follows the CLI's own naming rule (host-config/host-migrations.ts NAME_RE).
export const releaseHostMigrationSchema = z.object({
  key: z.string().max(120).regex(/^\d+\.\d+\.\d+\/[0-9]{3,}-[a-z0-9][a-z0-9-]*\.sh$/),
  phase: z.enum(['before-services', 'after-services']),
  // Rendered as text today; no control characters for any future renderer.
  description: z.string().min(10).max(200).regex(/^[^\x00-\x1f\x7f]+$/),
});
export const releaseSqlMigrationSchema = z.string().max(120).regex(/^\d{4}_[a-z0-9_]+\.sql$/);
export const releasePlatformMigrationSchema = z.string().max(120).regex(/^\d{4}_[a-z0-9_]+$/);
export const releaseContentsSchema = z.object({
  hostMigrations: z.array(releaseHostMigrationSchema).max(1000),
  migrations: z.object({
    sql: z.array(releaseSqlMigrationSchema).max(5000),
    platform: z.array(releasePlatformMigrationSchema).max(1000),
  }),
});
export type ReleaseContents = z.infer<typeof releaseContentsSchema>;

/** GET /admin/platform/upgrade/changes — what an upgrade to the available release changes. */
export const upgradeChangesResponseSchema = z.object({
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  /** false = the release's manifest carries no contents (cut before they existed). */
  known: z.boolean(),
  databaseMigrations: z.number().int(),
  platformMigrations: z.number().int(),
  hostChanges: z.array(z.object({
    key: z.string(),
    phase: z.enum(['before-services', 'after-services']),
    description: z.string(),
    /** The nodes this change still has to run on. */
    nodes: z.array(z.string()),
  })),
  /** Nodes that have not reported their host-migration state: unknown, not "nothing to do". */
  unreportedNodes: z.array(z.string()),
});
export type UpgradeChangesResponse = z.infer<typeof upgradeChangesResponseSchema>;

// ── Upgrade runs (ADR-064) ─────────────────────────────────────────────────────
export const upgradeRunStepSchema = z.enum(['prepare-nodes', 'update-services', 'finish', 'done']);
export type UpgradeRunStep = z.infer<typeof upgradeRunStepSchema>;

/**
 * One node in a run. `excluded` is a node upgraded without — it updates on its
 * own timer when back; `waiting` is a node the run waits for (not Ready). Only
 * `failed` is a fault.
 */
export const upgradeRunNodeStateSchema = z.enum([
  'queued', 'updating', 'ready', 'waiting', 'excluded', 'failed',
]);
export const upgradeRunNodeSchema = z.object({
  node: z.string(),
  state: upgradeRunNodeStateSchema,
  /** The node's CLI version as last reported (null = not reported). */
  cliVersion: z.string().nullable(),
  /** One line an operator can act on. */
  detail: z.string(),
  /**
   * The release's host changes this step applies on the node: before-services
   * ones while preparing, all of them when finishing. null = not reported yet.
   */
  hostChanges: z.object({ done: z.number().int(), total: z.number().int() }).nullable().optional(),
});
export type UpgradeRunNode = z.infer<typeof upgradeRunNodeSchema>;

export const upgradeRunSchema = z.object({
  id: z.string(),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  mode: z.enum(['manual', 'auto']),
  /** cancelled = stopped by an operator before the services changed; rolled-back = a rollback took over. */
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'rolled-back']),
  step: upgradeRunStepSchema,
  excludedNodes: z.array(z.string()),
  nodes: z.array(upgradeRunNodeSchema),
  message: z.string().nullable(),
  startedAt: z.string(),
  stepStartedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type UpgradeRun = z.infer<typeof upgradeRunSchema>;

export const upgradeApplyResponseSchema = z.object({
  action: z.string(),
  target: z.string().nullable(),
  reason: z.string(),
  proceed: z.boolean(),
  applied: z.boolean(),
  gitRepository: z.string().nullable(),
  environment: z.string(),
  summary: z.string(),
  /** ADR-064: the run an apply started (null on a dry-run or a refusal). */
  runId: z.string().nullable().optional(),
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

// ── Release notes for a target version ───────────────────────────────────────
// The operator is asked to approve an upgrade; "what changed" is part of that
// decision and used to live only in the GitHub release page. The backend
// already talks to the Releases API to discover versions, so it proxies the
// release body too — the browser needs no internet, and a cluster with no
// egress degrades to an honest "couldn't fetch" instead of a dead link.

/** CalVer/SemVer MAJOR.MINOR.PATCH, no leading-zero segments, optional
 *  `-<suffix>`. Mirrors the backend's VERSION_RE. Anchored on purpose: the
 *  value is interpolated into an outbound URL, so anything looser would be an
 *  SSRF surface. */
export const PLATFORM_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.]+)?$/;

export const platformChangelogQuerySchema = z.object({
  version: z.string().regex(PLATFORM_VERSION_PATTERN, 'version must be MAJOR.MINOR.PATCH with an optional -suffix'),
});
export type PlatformChangelogQuery = z.infer<typeof platformChangelogQuerySchema>;

export const platformChangelogResponseSchema = z.object({
  /** The version the notes belong to, without a leading `v`. */
  version: z.string(),
  /** Release body as published (markdown), or null when there is nothing to show. */
  notes: z.string().nullable(),
  /** `release` = real notes; `none` = no release/body for this tag (a dev build,
   *  or a release published without notes); `unreachable` = GitHub could not be
   *  reached. The UI must distinguish "nothing to say" from "we don't know". */
  source: z.enum(['release', 'none', 'unreachable']),
  /** Link to the release page, when one exists. */
  url: z.string().nullable(),
});
export type PlatformChangelogResponse = z.infer<typeof platformChangelogResponseSchema>;

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
    // ADR-064: an after-services script waiting for the services to run its release.
    'deferred',
    'invalid',
  ]),
  error: z.string().nullable().optional(),
  /** ADR-064 §3: before-services | after-services (absent from older CLIs). */
  phase: z.enum(['before-services', 'after-services']).nullable().optional(),
  /** ADR-056: how many consecutive times this has failed, and since when. */
  attempt: z.number().int().nullable().optional(),
  failingSince: z.string().nullable().optional(),
  /** Operator-recorded reason from a `.skipped` marker. */
  skipReason: z.string().nullable().optional(),
  /**
   * ADR-056 §5: `true` on an `already-applied` item recorded by a `.baseline`
   * marker — a fresh bootstrap of that release already produced its end state,
   * so it NEVER RAN on this node. Absent/null for a script that really ran.
   */
  baseline: z.boolean().nullable().optional(),
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
  /** ADR-064: after-services scripts waiting for the services to run their release. */
  deferredCount: z.number().int().optional(),
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
  /**
   * The node's insula CLI version, as its last converge reported it. A release's
   * host-migrations ship inside that binary, so a node on an older CLI has not
   * seen them yet. null = not reported (a CLI that predates the field).
   */
  cliVersion: z.string().nullable().optional(),
  /**
   * The node's CLI is older than the cluster's release — its host changes for
   * that release are still to come (the node updates on its own timer). null
   * when either version is unknown.
   */
  cliBehind: z.boolean().nullable().optional(),
  /**
   * ADR-064 §6: the node can verify a release (its pinned cosign key is present
   * and parses). false blocks an upgrade; null = a CLI that predates the field.
   */
  trustAnchor: z.boolean().nullable().optional(),
});
export type HostMigrationNodeStatus = z.infer<typeof hostMigrationNodeStatusSchema>;

export const hostMigrationStatusResponseSchema = z.object({
  nodes: z.array(hostMigrationNodeStatusSchema),
  /** True when ANY node has a failed, blocked or invalid migration, or refused
   *  the whole run. Drives the alert. */
  degraded: z.boolean(),
  /** Runbook the UI links to for remediation. */
  runbookUrl: z.string(),
  /** The release the nodes are compared against (the cluster's running version). */
  targetVersion: z.string().nullable().optional(),
});
export type HostMigrationStatusResponse = z.infer<typeof hostMigrationStatusResponseSchema>;

// ─── R29a: request validation for a route that previously cast ─────────
//
// These fields are consumed by the service as `if (input.X !== undefined)`,
// so before this schema a MISSPELLED field was not a 400 — it was a field the
// service skipped, and the route answered 200 having changed nothing.
// `.strict()` is the point: Zod's default STRIPS unknown keys, which would
// preserve exactly that silence.

export const capacityCheckRequestSchema = z.object({
  // Kubernetes quantity strings ('500m', '2Gi'), parsed downstream — validated
  // here as present and non-empty rather than re-implementing the grammar.
  cpu: z.string().min(1).max(32),
  memory: z.string().min(1).max(32),
  storage: z.string().min(1).max(32),
}).strict();
export type CapacityCheckRequest = z.infer<typeof capacityCheckRequestSchema>;
