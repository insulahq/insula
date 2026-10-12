/**
 * The four settings of the automatic archive/delete sweep, and the record of
 * its last run. All of it lives in `platform_settings`.
 */
import { inArray } from 'drizzle-orm';
import {
  TENANT_AUTOMATION_DEFAULTS,
  TENANT_AUTOMATION_MAX_DAYS,
  TENANT_AUTOMATION_MIN_DAYS,
  tenantAutomationRunSchema,
  tenantAutomationSettingsUpdateSchema,
  type TenantAutomationRun,
  type TenantAutomationSettings,
  type TenantAutomationSettingsUpdate,
} from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { platformSettings } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';

const KEYS = {
  autoArchiveEnabled: 'tenant_lifecycle.auto_archive_enabled',
  autoArchiveAfterDays: 'tenant_lifecycle.auto_archive_after_days',
  autoDeleteEnabled: 'tenant_lifecycle.auto_delete_enabled',
  autoDeleteAfterDays: 'tenant_lifecycle.auto_delete_after_days',
} as const satisfies Record<keyof TenantAutomationSettings, string>;

const LAST_RUN_KEY = 'tenant_lifecycle.automation_last_run';
const LAST_SCHEDULED_KEY = 'tenant_lifecycle.automation_last_scheduled_at';

/**
 * A stored day count, or the default when the row is missing or unusable. A
 * hand-edited `0` or `abc` must not become "archive everything suspended
 * before now" or an invalid date in the sweep's query.
 */
function daysOr(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= TENANT_AUTOMATION_MIN_DAYS && n <= TENANT_AUTOMATION_MAX_DAYS) return n;
  console.warn(`[tenant-automation] ignoring unusable value for ${key}: ${JSON.stringify(raw)} (using ${fallback})`);
  return fallback;
}

async function readRows(db: Database, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, [...keys]));
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Anything rows can be written through: the database, or a transaction of it. */
type Writer = Pick<Database, 'insert'>;

async function writeRow(db: Writer, key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

export async function loadTenantAutomationSettings(db: Database): Promise<TenantAutomationSettings> {
  const rows = await readRows(db, Object.values(KEYS));
  return {
    // Only the exact string turns a step on: an unreadable row leaves it off.
    autoArchiveEnabled: rows.get(KEYS.autoArchiveEnabled) === 'true',
    autoArchiveAfterDays: daysOr(rows.get(KEYS.autoArchiveAfterDays), TENANT_AUTOMATION_DEFAULTS.autoArchiveAfterDays, KEYS.autoArchiveAfterDays),
    autoDeleteEnabled: rows.get(KEYS.autoDeleteEnabled) === 'true',
    autoDeleteAfterDays: daysOr(rows.get(KEYS.autoDeleteAfterDays), TENANT_AUTOMATION_DEFAULTS.autoDeleteAfterDays, KEYS.autoDeleteAfterDays),
  };
}

/** Write the given settings; the others stay as they are. Returns what is stored afterwards. */
export async function saveTenantAutomationSettings(
  db: Database,
  input: TenantAutomationSettingsUpdate,
): Promise<TenantAutomationSettings> {
  const parsed = tenantAutomationSettingsUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError('VALIDATION_ERROR', issue.message, 400, { field: issue.path.join('.') });
  }
  // One transaction: a sweep on another replica reads the four rows in one
  // statement, and must see a switch and its limit change together — never
  // "delete on" with the limit the admin was just replacing.
  await db.transaction(async (tx) => {
    for (const [field, value] of Object.entries(parsed.data) as Array<[keyof TenantAutomationSettings, boolean | number | undefined]>) {
      if (value === undefined) continue;
      await writeRow(tx, KEYS[field], String(value));
    }
  });
  return loadTenantAutomationSettings(db);
}

export interface AutomationRunRecord {
  readonly lastRun: TenantAutomationRun | null;
  /** When the schedule's own sweep last started — a manual run does not move it. */
  readonly lastScheduledAt: string | null;
}

export async function loadAutomationRunRecord(db: Database): Promise<AutomationRunRecord> {
  const rows = await readRows(db, [LAST_RUN_KEY, LAST_SCHEDULED_KEY]);
  let lastRun: TenantAutomationRun | null = null;
  const raw = rows.get(LAST_RUN_KEY);
  if (raw) {
    try {
      const parsed = tenantAutomationRunSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lastRun = parsed.data;
    } catch { /* an unreadable record reads as "no run yet" */ }
  }
  const scheduled = rows.get(LAST_SCHEDULED_KEY);
  return { lastRun, lastScheduledAt: scheduled && !Number.isNaN(Date.parse(scheduled)) ? scheduled : null };
}

export async function saveAutomationRun(db: Database, run: TenantAutomationRun): Promise<void> {
  await writeRow(db, LAST_RUN_KEY, JSON.stringify(run));
  if (run.trigger === 'schedule') await writeRow(db, LAST_SCHEDULED_KEY, run.startedAt);
}
