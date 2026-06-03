/**
 * W9 / ADR-045 — platform-migration runner.
 *
 * Pure orchestration over the {@link MigrationStore} seam (DB + advisory lock):
 *   1. escape hatch — PLATFORM_SKIP_MIGRATIONS short-circuits to a no-op
 *   2. validate the registry (unique, sorted ids) — fail fast on author error
 *   3. acquire the single-runner advisory lock (non-blocking; a held lock means
 *      another replica is applying → this pod skips and serves immediately)
 *   4. drift-check already-applied migrations (WARN if a shipped migration's
 *      source changed — never fails the boot)
 *   5. apply the pending set in id order; HALT on the first failure (never run
 *      a later migration on top of a broken base)
 *
 * Runs at backend startup BEFORE app.listen (the 300s startupProbe window
 * covers it) and is re-entered by `platform-ops migrations apply`.
 */
import { createHash } from 'node:crypto';
import type {
  MigrationLogger, MigrationOutcome, MigrationStore, PlatformMigration,
  PlatformMigrationContext, RunMigrationsResult,
} from './types.js';

/**
 * A migration's drift checksum — TOOLCHAIN-INDEPENDENT (hashes the declared
 * metadata, NOT `up.toString()`).
 *
 * Why not the function source: the runner runs from TWO build outputs — the
 * tsc-compiled backend (`node dist/server.js`, the startup path) and the
 * esbuild-bundled `platform-ops` binary (the `migrations apply/list` path).
 * The two transpile the same source differently, so `up.toString()` would
 * disagree across them → false "drift" on every migration the other one
 * recorded. Hashing the stable id/version/description makes both agree.
 *
 * This catches re-versioning or re-describing a SHIPPED migration (an
 * order-stable-contract violation). Silent body edits are caught by
 * `scripts/ci-migration-idempotency.sh` + code review — the documented primary
 * enforcement — not by this hash.
 */
export function migrationChecksum(m: PlatformMigration): string {
  return createHash('sha256').update(`${m.id}\n${m.version}\n${m.description}`).digest('hex');
}

/** Throw if the registry has duplicate ids (an author error worth failing on). */
export function assertUniqueIds(migrations: readonly PlatformMigration[]): void {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) {
      throw new Error(`platform-migrations: duplicate migration id '${m.id}'`);
    }
    seen.add(m.id);
  }
}

/** Default per-migration wall-clock budget. A migration exceeding it is treated
 *  as failed (halting the pass) so a hung up() can never hold the advisory lock
 *  or a pool slot indefinitely. Generous: convergence migrations are quick. */
export const DEFAULT_MIGRATION_TIMEOUT_MS = 120_000;

export interface RunnerDeps {
  readonly store: MigrationStore;
  readonly migrations: readonly PlatformMigration[];
  /** Per-migration context minus dryRun (the runner stamps dryRun in). */
  readonly ctx: Omit<PlatformMigrationContext, 'dryRun'>;
  readonly dryRun: boolean;
  /** PLATFORM_SKIP_MIGRATIONS escape hatch. */
  readonly skip: boolean;
  readonly log: MigrationLogger;
  /** Injectable clock (ms) for deterministic duration tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Per-migration timeout (ms). Defaults to DEFAULT_MIGRATION_TIMEOUT_MS; ≤0 disables. */
  readonly timeoutMs?: number;
}

/**
 * Race a migration's up() against a wall-clock timeout. On timeout the returned
 * promise REJECTS (the runner records a failure + halts), but the underlying
 * up() promise is abandoned, not cancelled — the point is to stop WAITING so the
 * advisory lock + pool slot are released, not to interrupt the hung work.
 */
function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`migration '${id}' exceeded ${ms}ms timeout`)), ms);
    // Avoid keeping the event loop alive solely for this timer.
    if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function skipped(reason: string, dryRun: boolean): RunMigrationsResult {
  return { ran: false, skippedReason: reason, dryRun, applied: 0, pending: 0, failed: false, outcomes: [] };
}

export async function runPlatformMigrations(deps: RunnerDeps): Promise<RunMigrationsResult> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_MIGRATION_TIMEOUT_MS;
  if (deps.skip) {
    deps.log.info('[platform-migrations] PLATFORM_SKIP_MIGRATIONS set — skipping (no migrations applied)');
    return skipped('PLATFORM_SKIP_MIGRATIONS', deps.dryRun);
  }

  assertUniqueIds(deps.migrations);
  // id is the contract-position; apply in lexicographic id order (zero-padded
  // numeric prefixes sort correctly).
  const ordered = [...deps.migrations].sort((a, b) => a.id.localeCompare(b.id));

  const locked = await deps.store.withLock(async (): Promise<RunMigrationsResult> => {
    const applied = await deps.store.listApplied();

    // 4. Drift check (WARN only — never fail boot on drift).
    const outcomes: MigrationOutcome[] = [];
    for (const m of ordered) {
      const rec = applied.get(m.id);
      if (!rec) continue;
      const cur = migrationChecksum(m);
      if (rec.checksum !== cur) {
        const driftDetail = `recorded ${rec.checksum.slice(0, 12)}… now ${cur.slice(0, 12)}…`;
        deps.log.warn(`[platform-migrations] DRIFT: shipped migration '${m.id}' was edited after it applied (${driftDetail}). This violates the order-stable contract.`);
        outcomes.push({ id: m.id, status: 'drift', durationMs: 0, driftDetail });
      }
    }

    // 5. Apply pending in id order; HALT on first failure.
    const pending = ordered.filter((m) => !applied.has(m.id));
    let appliedCount = 0;
    for (const m of pending) {
      const t0 = now();
      try {
        await withTimeout(m.up({ ...deps.ctx, dryRun: deps.dryRun }), timeoutMs, m.id);
        const durationMs = now() - t0;
        if (deps.dryRun) {
          deps.log.info(`[platform-migrations] would apply '${m.id}' (${m.description})`);
          outcomes.push({ id: m.id, status: 'would-apply', durationMs });
        } else {
          await deps.store.recordApplied({ id: m.id, version: m.version, checksum: migrationChecksum(m), durationMs });
          deps.log.info(`[platform-migrations] applied '${m.id}' in ${durationMs}ms`);
          outcomes.push({ id: m.id, status: 'applied', durationMs });
          appliedCount++;
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        deps.log.warn(`[platform-migrations] FAILED '${m.id}': ${error} — halting (later migrations not applied)`, err);
        outcomes.push({ id: m.id, status: 'failed', durationMs: now() - t0, error });
        return { ran: true, dryRun: deps.dryRun, applied: appliedCount, pending: pending.length, failed: true, outcomes };
      }
    }
    return { ran: true, dryRun: deps.dryRun, applied: appliedCount, pending: pending.length, failed: false, outcomes };
  });

  if (!locked.acquired) {
    deps.log.info('[platform-migrations] advisory lock held by another replica — skipping this pass (the holder applies; idempotent on next boot)');
    return skipped('lock-held-by-another-replica', deps.dryRun);
  }
  // result is always set when acquired (fn returns a RunMigrationsResult).
  return locked.result as RunMigrationsResult;
}
