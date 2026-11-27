/**
 * Daily catalog sync. A repository with auto-sync on is synced again once its
 * last good sync is a day old. An hourly tick looks for due repositories, so a
 * sync that failed (last_synced_at unchanged) is tried again the next hour, not
 * the next day. One replica ticks (scheduler lease); due repositories are
 * synced one after another.
 *
 * A failure is written to the repository's status and last error by
 * syncCatalogRepo itself, which the admin Repositories page shows. A repository
 * another sync has marked `syncing` is left alone unless that mark is an hour
 * old: a replica that died mid-sync leaves it behind.
 */
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { catalogRepositories } from '../../db/schema.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { syncCatalogRepo } from './service.js';

export const AUTO_SYNC_EVERY_MS = 24 * 60 * 60 * 1000;
export const AUTO_SYNC_TICK_MS = 60 * 60 * 1000;
/** After this long a `syncing` mark is taken for one a dead replica left. */
export const STALE_SYNCING_MS = 60 * 60 * 1000;
/** The first tick waits for the startup sync of never-synced repositories (app.ts). */
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000;

type Log = Pick<Logger, 'info' | 'warn' | 'error'>;

export interface DueRepo {
  readonly id: string;
  readonly name: string;
}

export interface AutoSyncResult {
  readonly due: number;
  readonly synced: number;
  readonly failed: number;
}

/** The due repositories, or with `onlyId` whether that one still is (each is re-checked right
 * before its sync: syncs run one after another, and an admin may turn one off or sync it by hand
 * meanwhile). */
export async function reposDueForAutoSync(db: Database, now: Date, onlyId?: string): Promise<DueRepo[]> {
  const syncedBefore = new Date(now.getTime() - AUTO_SYNC_EVERY_MS);
  const markedBefore = new Date(now.getTime() - STALE_SYNCING_MS);
  return db
    .select({ id: catalogRepositories.id, name: catalogRepositories.name })
    .from(catalogRepositories)
    .where(and(
      onlyId === undefined ? undefined : eq(catalogRepositories.id, onlyId),
      eq(catalogRepositories.autoSyncEnabled, true),
      or(isNull(catalogRepositories.lastSyncedAt), lte(catalogRepositories.lastSyncedAt, syncedBefore)),
      or(ne(catalogRepositories.status, 'syncing'), lte(catalogRepositories.updatedAt, markedBefore)),
    ));
}

export async function runCatalogAutoSync(db: Database, log: Log, now: Date = new Date()): Promise<AutoSyncResult> {
  const due = await reposDueForAutoSync(db, now);
  let synced = 0;
  let failed = 0;
  for (const repo of due) {
    if ((await reposDueForAutoSync(db, new Date(), repo.id)).length === 0) continue;
    try {
      const result = await syncCatalogRepo(db, repo.id);
      synced += 1;
      log.info({ repoId: repo.id, repoName: repo.name, synced: result.synced, skipped: result.skipped }, 'catalog-auto-sync: repository synced');
    } catch (err) {
      failed += 1;
      log.warn({ repoId: repo.id, repoName: repo.name, err: err instanceof Error ? err.message : String(err) }, 'catalog-auto-sync: repository sync failed, next try in an hour');
    }
  }
  return { due: due.length, synced, failed };
}

export function startCatalogAutoSync(db: Database, log: Log, tickMs: number = AUTO_SYNC_TICK_MS): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await withSchedulerLease(db, 'catalog-auto-sync', tickMs * 1.5, () => runCatalogAutoSync(db, log), { log });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'catalog-auto-sync: tick threw');
    }
  };
  const first = setTimeout(() => { void tick(); }, Math.min(FIRST_TICK_DELAY_MS, tickMs));
  first.unref();
  const timer = setInterval(() => { void tick(); }, tickMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
