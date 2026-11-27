/**
 * The `databases-by-id` restore for bundles with per-database snapshots
 * (`databases` component rows). Older bundles keep the pre-dump path in
 * databases-by-id.ts.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { BackupDatabaseDumps, DatabaseRestoreMode, DatabasesSelector } from '@insula/api-contracts';
import { backupComponents, backupJobs } from '../../../db/schema.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { buildDbContext } from '../../deployments/db-manager.js';
import { parseDatabaseArtifactName } from '../../tenant-bundles/components/database-snapshots.js';
import { restoreInstanceFromSnapshots, type SnapshotRestoreRequest } from './database-snapshot-restore.js';
import type { DatabasesRestoreSummary, DeploymentOutcome, TargetDeployment } from './databases-by-id.js';

export interface DatabaseSnapshotRow {
  readonly deploymentId: string;
  readonly database: string;
  readonly snapshotId: string;
}

/** The bundle's per-database snapshots; empty for a bundle taken before them. */
export async function loadDatabaseSnapshotRows(app: FastifyInstance, bundleId: string): Promise<DatabaseSnapshotRow[]> {
  const rows = await app.db
    .select({ artifactName: backupComponents.artifactName, sha256: backupComponents.sha256 })
    .from(backupComponents)
    .where(and(
      eq(backupComponents.backupJobId, bundleId),
      eq(backupComponents.component, 'databases'),
      eq(backupComponents.status, 'completed'),
    ));
  const out: DatabaseSnapshotRow[] = [];
  for (const r of rows) {
    const parsed = parseDatabaseArtifactName(r.artifactName);
    if (!parsed || !r.sha256 || !/^[0-9a-f]{8,64}$/.test(r.sha256)) continue;
    out.push({ ...parsed, snapshotId: r.sha256 });
  }
  return out;
}

/** Which of an instance's snapshots a selector asks for. Pure. */
export function requestsFor(
  selector: DatabasesSelector,
  dep: TargetDeployment,
  rows: readonly DatabaseSnapshotRow[],
  summary: BackupDatabaseDumps | null,
): { readonly requests: SnapshotRestoreRequest[]; readonly missing: string[] } {
  const mine = rows.filter((r) => r.deploymentId === dep.deploymentId);
  const versionOf = (database: string): string | null =>
    summary?.deployments.find((d) => d.deploymentId === dep.deploymentId)?.databases.find((d) => d.name === database)?.serverVersion ?? null;
  const toRequest = (r: DatabaseSnapshotRow, targetName?: string): SnapshotRestoreRequest => ({
    source: r.database, snapshotId: r.snapshotId, serverVersion: versionOf(r.database), ...(targetName ? { targetName } : {}),
  });
  if (selector.kind !== 'databases') return { requests: mine.map((r) => toRequest(r)), missing: [] };
  const requests: SnapshotRestoreRequest[] = [];
  const missing: string[] = [];
  for (const want of selector.databases) {
    const row = mine.find((r) => r.database === want.name);
    if (row) requests.push(toRequest(row, want.targetName));
    else missing.push(want.name);
  }
  return { requests, missing };
}

function describe(mode: DatabaseRestoreMode, r: { source: string; target: string; objects: number | null; skipped?: number }): string {
  const left = r.skipped ? ` — ${r.skipped} object(s) only the server's superuser can manage (event triggers${mode === 'replace' ? ', extensions, what it owns' : ''}) left as they are` : '';
  if (mode === 'replace') return `${r.source}${left}`;
  if (mode === 'copy') return `${r.source} → ${r.target}${left}`;
  return `${r.source} (test restore: ${r.objects ?? 'unknown'} tables/collections, scratch copy dropped)${left}`;
}

export interface FromSnapshotsArgs {
  readonly app: FastifyInstance;
  readonly k8s: K8sClients;
  readonly kubeconfigPath?: string;
  readonly namespace: string;
  readonly tenantId: string;
  readonly bundleId: string;
  readonly restoreId: string;
  readonly selector: DatabasesSelector;
  readonly targets: readonly TargetDeployment[];
  readonly rows: readonly DatabaseSnapshotRow[];
  readonly secretsKeyHex: string;
  /** The tenant's administrator on an instance; null when it has none, 'not-ready' while it is set up. */
  readonly loginFor: (deploymentId: string) => Promise<{ username: string; password: string } | null | 'not-ready'>;
  readonly onProgress: (msg: string) => Promise<void>;
}

const NOT_READY = 'the database administrator account is still being set up — run the restore again in a few minutes';

export async function restoreDatabasesFromSnapshots(args: FromSnapshotsArgs): Promise<DatabasesRestoreSummary> {
  const mode: DatabaseRestoreMode = args.selector.mode ?? 'replace';
  const { resolveShimBackupTarget } = await import('../../tenant-bundles/resolve-backup-target.js');
  const { deriveResticPassword, buildResticRepoUri, buildResticEnv } = await import('../../tenant-bundles/restic-driver.js');
  const { resolveBundleRepoLayout } = await import('../../tenant-bundles/repo-layout.js');
  const { buildResticCredsStringData } = await import('../../tenant-bundles/components/files.js');
  const { resolvePlatformImage } = await import('../../../shared/platform-images.js');
  const { databaseJobPlacement } = await import('../../tenant-bundles/components/database-job.js');

  const target = await resolveShimBackupTarget(args.k8s.core, 'tenant');
  const passwordHex = deriveResticPassword(args.secretsKeyHex, args.tenantId);
  const repoUri = buildResticRepoUri(target, args.tenantId, 'databases', await resolveBundleRepoLayout(args.app.db, args.bundleId));
  const resticCreds = buildResticCredsStringData({ passwordHex, repoUri, env: buildResticEnv(target) });
  const [job] = await args.app.db.select({ databaseDumps: backupJobs.databaseDumps }).from(backupJobs).where(eq(backupJobs.id, args.bundleId)).limit(1);
  const summary = job?.databaseDumps ?? null;
  const placement = await databaseJobPlacement(args.app.db, args.tenantId, args.k8s);

  const outcomes: DeploymentOutcome[] = [];
  for (const dep of args.targets) {
    const base = { deploymentId: dep.deploymentId, deploymentName: dep.deploymentName };
    const { requests, missing } = requestsFor(args.selector, dep, args.rows, summary);
    const skipped = missing.map((m) => `database '${m}' has no backup of its own in this bundle`);
    if (requests.length === 0) {
      outcomes.push({ ...base, status: 'skipped', imported: [], failed: [], skipped: skipped.length ? skipped : [`skipped ${dep.deploymentName}: this bundle has no backup of its databases`] });
      continue;
    }
    const login = await args.loginFor(dep.deploymentId);
    if (login === null || login === 'not-ready') {
      const error = login === null ? 'this database has no tenant administrator to restore as' : NOT_READY;
      outcomes.push({ ...base, status: 'failed', imported: [], skipped, failed: requests.map((r) => ({ database: r.source, error })) });
      continue;
    }
    let ctx: Awaited<ReturnType<typeof buildDbContext>>;
    try {
      ctx = await buildDbContext(args.k8s, args.kubeconfigPath, args.namespace, dep.deploymentName,
        { runtime: dep.catalogRuntime, code: dep.catalogCode }, dep.configuration ?? {});
    } catch (err) {
      outcomes.push({ ...base, status: 'skipped', imported: [], failed: [], skipped: [...skipped, `skipped ${dep.deploymentName}: database workload not running (start it, then run this restore again) — ${(err as Error).message.slice(0, 160)}`] });
      continue;
    }
    const result = await restoreInstanceFromSnapshots({
      k8s: args.k8s, ctx, namespace: args.namespace, tenantId: args.tenantId, restoreId: args.restoreId,
      deploymentId: dep.deploymentId, mode, requests, login,
      toolsImage: resolvePlatformImage('tenant-backup-tools'), resticCreds, placement, onProgress: args.onProgress,
    });
    const imported = result.restored.map((r) => describe(mode, r));
    const allSkipped = [...skipped, ...result.skipped];
    outcomes.push({
      ...base,
      status: result.failed.length > 0 ? 'failed' : imported.length > 0 ? 'imported' : 'skipped',
      imported,
      skipped: allSkipped,
      failed: result.failed,
    });
  }
  let totalImported = 0; let totalSkipped = 0; let totalFailed = 0;
  for (const o of outcomes) { totalImported += o.imported.length; totalSkipped += o.skipped.length; totalFailed += o.failed.length; }
  return { deployments: outcomes, totalImported, totalSkipped, totalFailed };
}
