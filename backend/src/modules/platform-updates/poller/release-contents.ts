/**
 * ADR-064 §6 — read a verified manifest's release contents entry by entry. One
 * malformed entry (a name a future authoring rule allows and this schema does
 * not yet) drops that entry, never the whole list: otherwise the review would say
 * "this release does not list its changes" about a release that does.
 */
import type { ReleaseContents } from '@insula/api-contracts';
import {
  releaseHostMigrationSchema, releasePlatformMigrationSchema, releaseSqlMigrationSchema,
} from '@insula/api-contracts';

const MAX_HOST = 1000;
const MAX_SQL = 5000;
const MAX_PLATFORM = 1000;

function keep<T>(items: unknown, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, max: number) {
  const list = Array.isArray(items) ? items.slice(0, max) : [];
  const kept: T[] = [];
  for (const item of list) {
    const r = schema.safeParse(item);
    if (r.success) kept.push(r.data);
  }
  return { kept, dropped: (Array.isArray(items) ? items.length : 0) - kept.length };
}

/** null = the manifest carries no contents at all (a release cut before they existed). */
export function releaseContentsFrom(manifest: { readonly hostMigrations?: unknown; readonly migrations?: unknown }):
  { readonly contents: ReleaseContents; readonly dropped: number } | null {
  const migrations = (manifest.migrations ?? null) as { sql?: unknown; platform?: unknown } | null;
  if (!Array.isArray(manifest.hostMigrations) && (migrations === null || typeof migrations !== 'object')) return null;
  const host = keep(manifest.hostMigrations, releaseHostMigrationSchema, MAX_HOST);
  const sql = keep(migrations?.sql, releaseSqlMigrationSchema, MAX_SQL);
  const platform = keep(migrations?.platform, releasePlatformMigrationSchema, MAX_PLATFORM);
  return {
    contents: { hostMigrations: host.kept, migrations: { sql: sql.kept, platform: platform.kept } },
    dropped: host.dropped + sql.dropped + platform.dropped,
  };
}
