/**
 * The one retention rule every backup class follows.
 *
 * A copy is REMOVED when it is older than `days`, or when it is not among the
 * newest `count` — whichever removes it first. Raising either number lets the
 * set grow again from the next copy on; lowering it removes what no longer
 * fits within minutes, not at the next nightly run.
 *
 * Why one module: retention used to mean something different per class. Tenant
 * bundles stamped their expiry when they were made, so lowering the days left
 * every existing bundle on the old number. Mail handed both numbers to restic
 * as `--keep-daily N --keep-last M`, which keeps a snapshot when EITHER rule
 * wants it — the opposite of "whichever comes first". The DR artefacts honoured
 * a count and offered no days at all. An operator setting "14 days" got three
 * different outcomes depending on the card.
 *
 * Stored values: a positive number limits that dimension; NULL or 0 does not.
 * A row that limits neither predates this rule (the API refuses to save one),
 * and keeps the behaviour its class had then — see {@link effectiveRetention}.
 */
import type { Database } from '../../db/index.js';
import { backupSchedules } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export interface RetentionPolicy {
  /** Remove copies older than this many days. Null = no age limit. */
  readonly days: number | null;
  /** Keep at most this many of the newest copies. Null = no count limit. */
  readonly count: number | null;
}

export interface StoredRetention {
  readonly retentionDays: number | null;
  readonly retentionCount: number | null;
}

/** Nothing is ever removed. */
export const KEEP_EVERYTHING: RetentionPolicy = { days: null, count: null };

/** The subsystems whose retention this rule governs (`backup_schedules.subsystem`). */
export const RETENTION_SUBSYSTEMS = ['tenant_bundle', 'mail', 'etcd_snapshot', 'secrets_bundle', 'cluster_state'] as const;
export type RetentionSubsystem = typeof RETENTION_SUBSYSTEMS[number];

/**
 * What each class did when its row limited nothing, kept so an upgrade never
 * changes what such a row deletes. These are the defaults compiled into the
 * jobs' own scripts (`k8s/base/backup/*.yaml`, `snapshot-upload.sh`) and the
 * scheduler's old `retentionDays ?? 30`.
 */
const UNSET_FALLBACK: Record<RetentionSubsystem, RetentionPolicy> = {
  tenant_bundle: { days: 30, count: null },
  mail: { days: null, count: 48 },
  etcd_snapshot: { days: null, count: 24 },
  secrets_bundle: { days: null, count: 30 },
  cluster_state: { days: null, count: 14 },
};

function limit(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** True when the stored values limit neither dimension. */
export function limitsNothing(row: StoredRetention): boolean {
  return limit(row.retentionDays) === null && limit(row.retentionCount) === null;
}

/**
 * The policy a class enforces for its stored row.
 *
 * A row that limits neither dimension falls back to {@link UNSET_FALLBACK},
 * with one exception: a tenant-bundle row whose days were set to 0 on purpose
 * meant "never expire" before this rule existed, and still does. Every other
 * fallback is the number the class's job already used when nothing was set,
 * so the fallback can only keep as much as before, never less.
 */
export function effectiveRetention(subsystem: RetentionSubsystem, row: StoredRetention | undefined): RetentionPolicy {
  if (!row) return UNSET_FALLBACK[subsystem];
  const days = limit(row.retentionDays);
  const count = limit(row.retentionCount);
  if (days !== null || count !== null) return { days, count };
  if (subsystem === 'tenant_bundle' && row.retentionDays === 0) return KEEP_EVERYTHING;
  return UNSET_FALLBACK[subsystem];
}

/**
 * The count a DR Job is told when the policy sets no count limit (days only).
 *
 * A count it can never reach rather than 0. The scripts do read 0 as "delete
 * nothing" (`keep+0 >= 1 && …`), but a writer that relies on the reader to
 * ignore a destructive number is one script edit away from being destructive.
 * The days limit itself is enforced from platform-api (dr-artefact-retention.ts).
 */
export const JOB_UNLIMITED_COUNT = 1_000_000;

/** The count a DR Job's own prune should apply for this policy. */
export function jobCount(policy: RetentionPolicy): number {
  return policy.count ?? JOB_UNLIMITED_COUNT;
}

/** Read and resolve one subsystem's policy. */
export async function loadRetention(db: Database, subsystem: RetentionSubsystem): Promise<RetentionPolicy> {
  const [row] = await db
    .select({ retentionDays: backupSchedules.retentionDays, retentionCount: backupSchedules.retentionCount })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, subsystem))
    .limit(1);
  return effectiveRetention(subsystem, row);
}

export interface RetainedCopy {
  /** When the copy was made. */
  readonly createdAt: Date;
  /** Breaks ties between copies made in the same instant, so the order is total. */
  readonly key: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The copies the policy removes, newest first.
 *
 * "Newest" is (createdAt DESC, key DESC) — the order every listing shows, so
 * "the newest 14" means the same set here as on screen.
 *
 * The newest copy is NEVER removed. If a class's backups stop — a broken
 * target, a failing job — the days limit would otherwise age out its last
 * restore point while nothing replaces it. Tenant bundles hold theirs the same
 * way (bundle-hold.ts), and restic's `--keep-within` measures from the newest
 * snapshot for the same reason.
 */
export function selectForRemoval<T extends RetainedCopy>(
  copies: readonly T[],
  policy: RetentionPolicy,
  now: Date,
): T[] {
  const cutoff = policy.days === null ? null : now.getTime() - policy.days * DAY_MS;
  const ordered = [...copies].sort((a, b) => {
    const t = b.createdAt.getTime() - a.createdAt.getTime();
    if (t !== 0) return t;
    return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
  });
  return ordered.filter((c, rank) => rank > 0 && (
    (cutoff !== null && c.createdAt.getTime() < cutoff)
    || (policy.count !== null && rank >= policy.count)));
}

/** One line for logs and operator-facing text: "14 days or the newest 48, whichever comes first". */
export function describeRetention(policy: RetentionPolicy): string {
  const parts = [
    policy.days !== null ? `${policy.days} day${policy.days === 1 ? '' : 's'}` : null,
    policy.count !== null ? `the newest ${policy.count}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return 'everything (no limit)';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} or ${parts[1]}, whichever comes first`;
}
