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
import { eq } from 'drizzle-orm';

import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export type MailboxBackupEngine = 'jmap' | 'imap';

const SETTING_ENGINE = 'mailbox_backup_engine';
const SETTING_MAX_CONCURRENT = 'mailbox_backup_max_concurrent';

const DEFAULT_ENGINE: MailboxBackupEngine = 'jmap';
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
