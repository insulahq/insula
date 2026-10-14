/**
 * ADR-064 §6 — read a verified manifest's release contents entry by entry. One
 * malformed entry (a name a future authoring rule allows and this schema does
 * not yet) drops that entry, never the whole list: otherwise the review would say
 * "this release does not list its changes" about a release that does.
 */
import type { ReleaseContents, ReleaseWorkloadChange } from '@insula/api-contracts';
import {
  K3S_VERSION_RE, RELEASE_VERSION_RE, releaseHostMigrationSchema, releasePlatformMigrationSchema, releaseSqlMigrationSchema,
  releaseWorkloadChangeSchema,
} from '@insula/api-contracts';

const MAX_HOST = 1000;
const MAX_SQL = 5000;
const MAX_PLATFORM = 1000;
/** Earlier versions the restart table may name (release.yml lists 40), and entries per version. */
const MAX_WORKLOAD_VERSIONS = 100;
const MAX_WORKLOADS = 500;

function keep<T>(items: unknown, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, max: number) {
  const list = Array.isArray(items) ? items.slice(0, max) : [];
  const kept: T[] = [];
  for (const item of list) {
    const r = schema.safeParse(item);
    if (r.success) kept.push(r.data);
  }
  return { kept, dropped: (Array.isArray(items) ? items.length : 0) - kept.length };
}

/**
 * The restart table, version by version and entry by entry: a version key that is not a
 * release version is dropped with its entries; a malformed entry drops alone. undefined =
 * the manifest has no table (a release cut before it existed).
 */
function workloadTable(raw: unknown): { readonly table?: Record<string, ReleaseWorkloadChange[]>; readonly dropped: number } {
  if (raw === undefined || raw === null) return { dropped: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { dropped: 1 };
  const table: Record<string, ReleaseWorkloadChange[]> = {};
  let dropped = 0;
  for (const [version, items] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_WORKLOAD_VERSIONS)) {
    if (version.length > 40 || !RELEASE_VERSION_RE.test(version) || !Array.isArray(items)) { dropped += 1; continue; }
    const kept = keep<ReleaseWorkloadChange>(items, releaseWorkloadChangeSchema, MAX_WORKLOADS);
    table[version] = kept.kept;
    dropped += kept.dropped;
  }
  return { table, dropped };
}

/** null = the manifest carries no contents at all (a release cut before they existed). */
export function releaseContentsFrom(manifest: {
  readonly hostMigrations?: unknown; readonly migrations?: unknown; readonly kubernetes?: unknown; readonly workloadChanges?: unknown;
}): { readonly contents: ReleaseContents; readonly dropped: number } | null {
  const migrations = (manifest.migrations ?? null) as { sql?: unknown; platform?: unknown } | null;
  if (!Array.isArray(manifest.hostMigrations) && (migrations === null || typeof migrations !== 'object')) return null;
  const host = keep(manifest.hostMigrations, releaseHostMigrationSchema, MAX_HOST);
  const sql = keep(migrations?.sql, releaseSqlMigrationSchema, MAX_SQL);
  const platform = keep(migrations?.platform, releasePlatformMigrationSchema, MAX_PLATFORM);
  const k3s = (manifest.kubernetes as { k3s?: unknown } | null | undefined)?.k3s;
  const k3sVersion = typeof k3s === 'string' && k3s.length <= 40 && K3S_VERSION_RE.test(k3s) ? k3s : null;
  const workloads = workloadTable(manifest.workloadChanges);
  return {
    contents: {
      hostMigrations: host.kept, migrations: { sql: sql.kept, platform: platform.kept }, k3sVersion,
      ...(workloads.table ? { workloadChanges: workloads.table } : {}),
    },
    dropped: host.dropped + sql.dropped + platform.dropped + workloads.dropped,
  };
}
