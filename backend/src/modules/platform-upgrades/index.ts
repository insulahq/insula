/**
 * W9 / ADR-045 — platform-migration registry: public surface.
 *
 * `runStartupMigrations` is the one entry both the backend startup path
 * (server.ts, before app.listen) and `platform-ops migrations apply` call.
 * `listMigrationStatus` powers `platform-ops migrations list` (read-only).
 */
import type pg from 'pg';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runPlatformMigrations, migrationChecksum } from './registry/runner.js';
import { realMigrationStore } from './registry/store.js';
import { ensureHostDesiredConfigMaps } from './host-desired-state.js';
import { PLATFORM_MIGRATIONS } from './migrations/index.js';
import { platformMigrations } from '../../db/schema.js';
import type { MigrationLogger, RunMigrationsResult } from './registry/types.js';

export interface RunStartupMigrationsOpts {
  readonly db: Database;
  readonly pool: pg.Pool;
  readonly k8s: K8sClients | null;
  readonly config: { readonly PLATFORM_VERSION?: string; readonly KUBECONFIG_PATH?: string };
  readonly log: MigrationLogger;
  readonly dryRun?: boolean;
  readonly skip?: boolean;
}

/** Apply pending platform-migrations (startup + `migrations apply`). */
export async function runStartupMigrations(opts: RunStartupMigrationsOpts): Promise<RunMigrationsResult> {
  const store = realMigrationStore(opts.db, opts.pool);
  const result = await runPlatformMigrations({
    store,
    migrations: PLATFORM_MIGRATIONS,
    ctx: { db: opts.db, k8s: opts.k8s, config: opts.config, log: opts.log },
    dryRun: opts.dryRun ?? false,
    skip: opts.skip ?? false,
    log: opts.log,
  });

  // Self-heal: the seed migrations create the host desired-state ConfigMaps
  // exactly once, so a deleted CM was never restored. This create-if-absent
  // pass runs every boot (both callers) to recreate any that went missing —
  // never overwriting an existing (operator-edited) CM. Honours the same skip
  // escape hatch + dry-run; isolated so it can never fail the migration run.
  if (!(opts.skip ?? false)) {
    try {
      const healed = await ensureHostDesiredConfigMaps(opts.k8s, opts.log, { dryRun: opts.dryRun ?? false });
      if (healed.created.length > 0) {
        opts.log.info(
          `[host-desired-state] ${opts.dryRun ? 'would recreate' : 'recreated'} `
          + `${healed.created.length} absent desired ConfigMap(s): ${healed.created.join(', ')}`,
        );
      }
    } catch (err) {
      opts.log.warn('[host-desired-state] self-heal reconcile errored (continuing)', err);
    }
  }

  return result;
}

export type MigrationListStatus = 'applied' | 'pending' | 'drift' | 'unknown';

export interface MigrationStatusItem {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly status: MigrationListStatus;
  readonly appliedAt: string | null;
}

/**
 * Merge the compiled-in registry with the applied rows for a read-only status
 * view. Read-only: never applies anything (that's `runStartupMigrations`).
 */
export async function listMigrationStatus(db: Database): Promise<MigrationStatusItem[]> {
  const rows = await db
    .select({ id: platformMigrations.id, checksum: platformMigrations.checksum, appliedAt: platformMigrations.appliedAt })
    .from(platformMigrations);
  const applied = new Map(rows.map((r) => [r.id, r]));
  return PLATFORM_MIGRATIONS.map((m) => {
    const rec = applied.get(m.id);
    let status: MigrationListStatus = 'pending';
    if (rec) status = rec.checksum === migrationChecksum(m) ? 'applied' : 'drift';
    return {
      id: m.id,
      version: m.version,
      description: m.description,
      status,
      appliedAt: rec ? new Date(rec.appliedAt).toISOString() : null,
    };
  });
}

/**
 * The registry view with NO DB — every migration reported `unknown` (we know it
 * exists in this release but not whether it has applied). Lets `migrations list`
 * still enumerate the release's migrations when the DB is unreachable.
 */
export function registryStatusOffline(): MigrationStatusItem[] {
  return PLATFORM_MIGRATIONS.map((m) => ({
    id: m.id,
    version: m.version,
    description: m.description,
    status: 'unknown' as const,
    appliedAt: null,
  }));
}

export { PLATFORM_MIGRATIONS } from './migrations/index.js';
export { migrationChecksum } from './registry/runner.js';
export type { PlatformMigration, RunMigrationsResult, MigrationOutcome } from './registry/types.js';
