import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

const CLUSTER_ID_KEY = 'cluster_id';

/**
 * Stable per-cluster identity (a UUID), generated ONCE and persisted in
 * `platform_settings`. Used to namespace the SYSTEM (postgres/etcd) + MAIL
 * backup paths so two clusters that share a single S3 backup target never
 * collide (every cluster's CNPG is named `system-db`, so without this their
 * barman backups would intermix under one path → restore corruption).
 *
 * Why a generated UUID and NOT the apex (`platform_domain`): a backup path must
 * be STABLE, but the apex can change (R16 rename). The cluster_id never changes.
 *
 * TENANT backups deliberately do NOT use this — they key by `bundleId` +
 * `meta.json.tenantId`, which keeps a tenant globally addressable across
 * clusters for future cross-cluster migration. See docs/operations/BACKUP_RCLONE_SHIM.md.
 */
export async function getClusterId(db: Database): Promise<string> {
  const read = async (): Promise<string | null> => {
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, CLUSTER_ID_KEY));
    const v = row?.value?.trim();
    return v && v.length > 0 ? v : null;
  };
  const existing = await read();
  if (existing) return existing;
  const id = randomUUID();
  await db
    .insert(platformSettings)
    .values({ key: CLUSTER_ID_KEY, value: id })
    .onConflictDoNothing({ target: platformSettings.key });
  // Re-read: a concurrent caller may have won the insert (onConflictDoNothing).
  return (await read()) ?? id;
}
