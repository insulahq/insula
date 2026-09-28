/**
 * Which CPU model a NEW tenant is created on (ADR-062 R3).
 *
 * ★ The whole difficulty is that the answer differs by cluster, and the
 * platform cannot ask.
 *
 * A fresh install should be tiered: there is nothing to migrate, no tenant
 * has a reservation anyone is attached to, and the alternative is shipping
 * every new operator onto a model the ADR exists to replace and then asking
 * them to migrate off it. An EXISTING cluster must not move: its tenants are
 * legacy, its plans are sized as reservations, and a release that silently
 * started creating tiered tenants alongside legacy ones would hand the
 * operator a namespace-by-namespace split nobody chose.
 *
 * So it is decided ONCE and recorded: a cluster with tenants at that moment
 * is an upgrade, a cluster without is a fresh install. Thereafter the stored
 * value is what counts — nothing overwrites it, and an operator can change
 * it.
 *
 * ★ Decided LAZILY, when a tenant is about to be created — not at boot.
 *
 * Boot is the wrong moment because it is not the same moment on every
 * cluster. A disaster-recovery rebuild starts the API against a
 * freshly-migrated, EMPTY database and restores the backup afterwards; a
 * boot-time decision would look at zero tenants, conclude "fresh install",
 * and permanently record `tiered` for a cluster with thirty legacy tenants
 * about to reappear — silently, with no self-heal. Asking the question when
 * someone actually creates a tenant cannot race a restore, because a
 * restore is what puts the tenants there.
 */

import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { platformSettings } from '../../db/schema.js';

export const CPU_SCHEDULING_DEFAULT_KEY = 'cpu_scheduling_default';
export type CpuSchedulingDefault = 'legacy' | 'tiered';

/**
 * Decide and store the default, if it has never been decided.
 *
 * Idempotent and race-safe: the insert is ON CONFLICT DO NOTHING against the
 * primary key, so two replicas asking at once cannot produce two answers.
 */
export async function ensureCpuSchedulingDefault(
  db: Database,
  log?: { info?: (o: object, m?: string) => void },
): Promise<CpuSchedulingDefault> {
  const existing = await readCpuSchedulingDefault(db);
  if (existing !== null) return existing;

  // ★ Tenants, not migrations or versions. "Does this platform serve
  // anyone" is the question that distinguishes an upgrade from a fresh
  // install, and — asked at tenant-creation time rather than at boot — it
  // stays true regardless of how the operator got here: bootstrap, a
  // restore, or a rebuilt control plane.
  //
  // The SYSTEM tenant (ADR-040) is excluded: bootstrap creates it on a
  // genuinely fresh install, so counting it would classify every new
  // cluster as an upgrade.
  const counted = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM tenants WHERE COALESCE(is_system, FALSE) = FALSE
  `);
  const tenantCount = Number(counted.rows?.[0]?.n ?? '0');
  const decided: CpuSchedulingDefault = tenantCount === 0 ? 'tiered' : 'legacy';

  await db.insert(platformSettings)
    .values({ key: CPU_SCHEDULING_DEFAULT_KEY, value: decided })
    .onConflictDoNothing();

  // Re-read: a concurrent replica may have won the insert, and its answer is
  // the one that counts.
  const stored = await readCpuSchedulingDefault(db);
  log?.info?.(
    { decided, stored, tenantCount },
    'cpu-scheduling: recorded the default CPU model for new tenants',
  );
  return stored ?? decided;
}

export async function readCpuSchedulingDefault(db: Database): Promise<CpuSchedulingDefault | null> {
  const [row] = await db.select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, CPU_SCHEDULING_DEFAULT_KEY));
  return row?.value === 'tiered' || row?.value === 'legacy' ? row.value : null;
}

/**
 * The mode a tenant created RIGHT NOW should get, deciding it if nobody has.
 *
 * Falls back to `legacy` on any failure, which is the only safe direction: a
 * tenant wrongly created legacy can be migrated with one click, and a tenant
 * wrongly created tiered has had its namespace built around a model the rest
 * of its cluster does not use.
 */
export async function cpuModeForNewTenant(
  db: Database,
  log?: { info?: (o: object, m?: string) => void },
): Promise<CpuSchedulingDefault> {
  return (await ensureCpuSchedulingDefault(db, log).catch(() => null)) ?? 'legacy';
}
