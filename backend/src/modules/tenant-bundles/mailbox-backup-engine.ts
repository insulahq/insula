/**
 * Mailbox backup engine selector + concurrency cap helpers.
 *
 * Two platform-settings keys gate the IMAP-vs-JMAP migration:
 *
 *   mailbox_backup_engine            ('jmap' | 'imap')  default 'jmap'
 *   mailbox_backup_max_concurrent    integer            default 4
 *
 * Both are read on every capture + restore — no caching. platform_settings
 * is hot — one extra row read per Job is noise.
 *
 * `mailbox_backup_max_concurrent` caps the number of mailbox Jobs running
 * concurrently across all platform-api replicas. Enforced by reusing the
 * existing cluster-concurrency `acquireGlobalSlot` machinery with a
 * dedicated component value `mailbox-worker` (distinct from the
 * `mailboxes` component used for restic-stream uploads — the two gates
 * serve different purposes and must not deadlock).
 *
 * Operator override path:
 *   UPDATE platform_settings SET setting_value = 'imap'
 *     WHERE setting_key = 'mailbox_backup_engine';
 *   UPDATE platform_settings SET setting_value = '2'
 *     WHERE setting_key = 'mailbox_backup_max_concurrent';
 *
 * No restart required — the next bundle Job picks up the new value.
 *
 * See memory: project_stalwart_imap_perf_2026_05_22 for why 4 is the
 * recommended cap (it cuts per-active-user worst-case Stalwart memory
 * from 1.6 GiB at default-16 to 400 MiB with the 100 MiB
 * x:Imap.maxRequestSize, while preserving the throughput ceiling
 * since parallelism saturates beyond K=4 on a single-pod Stalwart).
 */
import { eq, inArray } from 'drizzle-orm';

import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export type MailboxBackupEngine = 'jmap' | 'imap';

/** The engine that the platform recommends; matches DEFAULT_ENGINE. */
export const RECOMMENDED_DEFAULT_ENGINE: MailboxBackupEngine = 'imap';

/** Returns DEFAULT_MAX_CONCURRENT — exported so the UI can show the default. */
export const RECOMMENDED_DEFAULT_MAX_CONCURRENT = 4;

const SETTING_ENGINE = 'mailbox_backup_engine';
const SETTING_MAX_CONCURRENT = 'mailbox_backup_max_concurrent';

/**
 * Default engine is **'imap'** as of 2026-05-22. Perf testing
 * (project_stalwart_imap_perf_2026_05_22) showed IMAP export is 2.3×
 * faster than JMAP and IMAP MULTIAPPEND import 2.6× faster — a real
 * win at no architectural cost since IMAP4rev2 + MULTIAPPEND +
 * LITERAL+ are all advertised by Stalwart 0.16's post-auth CAPABILITY.
 *
 * Operators on existing clusters auto-upgrade on backend restart (the
 * platform_settings row is absent → falls back to this default).
 * Bootstrap also seeds the row explicitly for fresh installs.
 *
 * Operator override path — flip back to JMAP without redeploy:
 *   UPDATE platform_settings
 *      SET setting_value = 'jmap'
 *    WHERE setting_key = 'mailbox_backup_engine';
 */
const DEFAULT_ENGINE: MailboxBackupEngine = 'imap';
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Read the active mailbox-backup engine from platform_settings.
 * Returns DEFAULT_ENGINE if the row is missing or holds an unknown value.
 */
export async function getMailboxBackupEngine(
  db: Database,
): Promise<MailboxBackupEngine> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, SETTING_ENGINE))
    .limit(1);
  const v = row?.value?.trim().toLowerCase();
  if (v === 'imap' || v === 'jmap') return v;
  return DEFAULT_ENGINE;
}

/**
 * Read the cluster-wide mailbox-worker concurrency cap. Returns
 * DEFAULT_MAX_CONCURRENT if the row is missing or unparseable.
 *
 * `0` is allowed and disables the gate entirely (compatibility shim for
 * operators who want unlimited; matches cluster-concurrency.ts's
 * `globalMaxInFlight <= 0` short-circuit). Negative values are clamped
 * to 0.
 */
export async function getMailboxBackupMaxConcurrent(
  db: Database,
): Promise<number> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, SETTING_MAX_CONCURRENT))
    .limit(1);
  if (!row?.value) return DEFAULT_MAX_CONCURRENT;
  const parsed = Number.parseInt(row.value.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENT;
  return Math.max(0, parsed);
}

/**
 * Fetch all mailbox-backup settings + their latest update timestamp.
 * Used by the GET /admin/mailbox-backup-settings endpoint.
 */
export async function getMailboxBackupSettingsView(db: Database): Promise<{
  engine: MailboxBackupEngine;
  maxConcurrent: number;
  isRecommendedDefault: boolean;
  lastUpdatedAt: string | null;
}> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value, updatedAt: platformSettings.updatedAt })
    .from(platformSettings)
    .where(inArray(platformSettings.key, [SETTING_ENGINE, SETTING_MAX_CONCURRENT]));

  let engine: MailboxBackupEngine = DEFAULT_ENGINE;
  let maxConcurrent: number = DEFAULT_MAX_CONCURRENT;
  let latestUpdate: Date | null = null;
  for (const r of rows) {
    if (r.key === SETTING_ENGINE) {
      const v = r.value?.trim().toLowerCase();
      if (v === 'imap' || v === 'jmap') engine = v;
    } else if (r.key === SETTING_MAX_CONCURRENT) {
      const n = Number.parseInt((r.value ?? '').trim(), 10);
      if (Number.isFinite(n)) maxConcurrent = Math.max(0, n);
    }
    const updatedAt = r.updatedAt instanceof Date ? r.updatedAt : (r.updatedAt ? new Date(r.updatedAt) : null);
    if (updatedAt && (!latestUpdate || updatedAt > latestUpdate)) {
      latestUpdate = updatedAt;
    }
  }
  return {
    engine,
    maxConcurrent,
    isRecommendedDefault: engine === RECOMMENDED_DEFAULT_ENGINE,
    lastUpdatedAt: latestUpdate ? latestUpdate.toISOString() : null,
  };
}

/**
 * Upsert one or both settings rows. Returns the updated view.
 *
 * `engine` and `maxConcurrent` are independently optional — the
 * endpoint accepts a partial body so the operator can change one
 * without re-sending the other.
 */
export async function setMailboxBackupSettings(
  db: Database,
  patch: { engine?: MailboxBackupEngine; maxConcurrent?: number },
): Promise<{
  engine: MailboxBackupEngine;
  maxConcurrent: number;
  isRecommendedDefault: boolean;
  lastUpdatedAt: string | null;
}> {
  // Validate up-front so we don't write a partial update.
  const writes: Array<{ key: string; value: string }> = [];
  if (patch.engine !== undefined) {
    writes.push({ key: SETTING_ENGINE, value: patch.engine });
  }
  if (patch.maxConcurrent !== undefined) {
    if (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1 || patch.maxConcurrent > 64) {
      throw new Error('maxConcurrent must be an integer in [1, 64]');
    }
    writes.push({ key: SETTING_MAX_CONCURRENT, value: String(patch.maxConcurrent) });
  }
  if (writes.length === 0) {
    return getMailboxBackupSettingsView(db);
  }
  // Wrap multi-row write in a transaction so a concurrent PATCH or
  // crash mid-write can't leave the two settings rows mutually
  // inconsistent. platform_settings is low-traffic so this txn is cheap.
  // Drizzle's `db.transaction` works against both node-postgres and the
  // PgliteDatabase used by tests (real DB integration test path).
  await (db as unknown as {
    transaction: (
      fn: (tx: typeof db) => Promise<void>,
    ) => Promise<void>;
  }).transaction(async (tx) => {
    for (const w of writes) {
      const [existing] = await tx
        .select({ key: platformSettings.key })
        .from(platformSettings)
        .where(eq(platformSettings.key, w.key))
        .limit(1);
      if (existing) {
        await tx.update(platformSettings)
          .set({ value: w.value })
          .where(eq(platformSettings.key, w.key));
      } else {
        await tx.insert(platformSettings).values({ key: w.key, value: w.value });
      }
    }
  });
  return getMailboxBackupSettingsView(db);
}
