/**
 * W9 / ADR-045 — platform-migration registry types.
 *
 * A platform-migration is an idempotent, order-stable convergence step applied
 * at backend startup (deploy a DaemonSet, record a baseline, enable a
 * reconciler, …). DISTINCT from the SQL schema migrations in db/migrations/.
 *
 * Authoring discipline (enforced by scripts/ci-migration-idempotency.sh):
 *   - idempotent      — re-running up() is a no-op
 *   - self-contained  — may assume earlier-numbered migrations ran, never that
 *                       "we were on version X when this runs"
 *   - order-stable    — a shipped migration's id (numeric prefix) is its
 *                       contract; renaming/renumbering is forbidden
 *   - no down()       — forward-only by design (locked decision #5)
 */
import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';

export interface MigrationLogger {
  info: (msg: string) => void;
  warn: (msg: string, err?: unknown) => void;
}

/** Subset of platform config a migration may read. */
export interface PlatformMigrationConfig {
  readonly PLATFORM_VERSION?: string;
  readonly KUBECONFIG_PATH?: string;
}

/** Context passed to each migration's up(). */
export interface PlatformMigrationContext {
  readonly db: Database;
  /**
   * k8s clients, or null when no kubeconfig is available at startup. A
   * migration that needs the cluster but receives null should no-op (it is
   * retried, idempotently, on the next boot that has a client) rather than
   * throw — a missing kubeconfig must not brick boot.
   */
  readonly k8s: K8sClients | null;
  readonly config: PlatformMigrationConfig;
  readonly log: MigrationLogger;
  /**
   * True in dry-run: a migration MUST NOT mutate cluster/DB state — it may
   * read and log what it WOULD do. The runner also skips recording the row.
   */
  readonly dryRun: boolean;
}

export interface PlatformMigration {
  /** Stable, order-bearing id, e.g. '0001_record_baseline'. */
  readonly id: string;
  /** CalVer the migration first shipped in (e.g. '2026.6.1'). */
  readonly version: string;
  readonly description: string;
  /** Idempotent forward step. No down() by design. */
  up(ctx: PlatformMigrationContext): Promise<void>;
}

export type MigrationStatus =
  | 'applied'        // up() ran + row recorded this pass
  | 'would-apply'    // dry-run: up() ran (no-mutation contract) but not recorded
  | 'failed'         // up() threw — the run HALTS here
  | 'drift';         // already-applied migration's source checksum changed (WARN)

export interface MigrationOutcome {
  readonly id: string;
  readonly status: MigrationStatus;
  readonly durationMs: number;
  readonly error?: string;
  readonly driftDetail?: string;
}

export interface RunMigrationsResult {
  /** false when skipped via the escape hatch or the lock was held elsewhere. */
  readonly ran: boolean;
  readonly skippedReason?: string;
  readonly dryRun: boolean;
  /** Migrations whose up() ran this pass (recorded; 0 in dry-run). */
  readonly applied: number;
  /** How many were pending at the start of the pass. */
  readonly pending: number;
  /** True if a migration's up() threw — the run halted. */
  readonly failed: boolean;
  readonly outcomes: readonly MigrationOutcome[];
}

/** What the runner persists about an applied migration. */
export interface AppliedMigrationRecord {
  readonly id: string;
  readonly version: string;
  readonly checksum: string;
  readonly durationMs: number;
}

/**
 * DB + advisory-lock seam. The real impl (store.ts) uses Drizzle + a dedicated
 * pg client holding a session-level `pg_try_advisory_lock`; tests inject a fake
 * so the runner is pure, DB-less, unit-testable logic.
 */
export interface MigrationStore {
  /** Map of id → {checksum} for every already-applied migration. */
  listApplied(): Promise<Map<string, { readonly checksum: string }>>;
  /** Record one freshly-applied migration. */
  recordApplied(rec: AppliedMigrationRecord): Promise<void>;
  /**
   * Run `fn` while holding the single-runner advisory lock. Returns
   * `{ acquired:false }` WITHOUT running `fn` when another replica holds the
   * lock (non-blocking — a stuck peer must never block this pod's boot).
   */
  withLock<T>(fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }>;
}
