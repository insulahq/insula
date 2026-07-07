/**
 * Pre-capture DB dump orchestration glue.
 *
 * Wraps `preCaptureDatabaseDumps` (database-predump.ts) with the
 * platform-specific bits the orchestrator needs:
 *   - Query the tenant's deployment rows JOINED with catalog_entries
 *     so we know which deployments are databases.
 *   - Build a DbManagerContext per deployment via the existing SQL
 *     Manager primitive `db-manager.buildDbContext`.
 *   - Hand off to `preCaptureDatabaseDumps`.
 *
 * Kept separate from the orchestrator file so it can be unit-tested
 * with a stubbed db + a stubbed kube tenant. The orchestrator
 * remains a thin coordinator that calls this once.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { deployments, catalogEntries } from '../../../db/schema.js';
import {
  buildDbContext,
  exportDatabaseToPvc,
  listDatabases,
  ENGINE_CONFIG,
  type Engine,
} from '../../deployments/db-manager.js';
import { execInPod } from '../../../shared/k8s-exec.js';
import {
  preCaptureDatabaseDumps,
  type PreDumpDeployment,
  type PreDumpDeploymentResult,
} from './database-predump.js';
import type { BackupDatabaseDumps } from '@insula/api-contracts';

export interface RunPreCaptureDumpsArgs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tenantId: string;
  readonly namespace: string;
  readonly backupId: string;
  readonly kubeconfigPath?: string;
  readonly onProgress?: (msg: string) => void;
}

/**
 * Resolve every database deployment for the tenant and run the pre-
 * capture dump hook. Returns per-deployment results for the
 * orchestrator to log; never throws (failures are recorded in the
 * result rows so a single broken deployment does not abort the bundle).
 */
export async function runPreCaptureDatabaseDumps(
  args: RunPreCaptureDumpsArgs,
): Promise<ReadonlyArray<PreDumpDeploymentResult>> {
  // SELECT the database deployments. JOIN against catalog_entries
  // so we know runtime + type without a second round-trip.
  const rows = await args.db
    .select({
      deploymentId: deployments.id,
      deploymentName: deployments.name,
      configuration: deployments.configuration,
      catalogCode: catalogEntries.code,
      catalogRuntime: catalogEntries.runtime,
      catalogType: catalogEntries.type,
    })
    .from(deployments)
    .innerJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .where(
      and(
        eq(deployments.tenantId, args.tenantId),
        eq(catalogEntries.type, 'database'),
      ),
    );

  if (rows.length === 0) {
    return [];
  }

  const dumpInputs: PreDumpDeployment[] = rows.map((r) => ({
    deploymentId: r.deploymentId,
    deploymentName: r.deploymentName,
    namespace: args.namespace,
    catalogCode: r.catalogCode,
    catalogRuntime: r.catalogRuntime,
    catalogType: r.catalogType,
    configuration: (r.configuration ?? {}) as Record<string, unknown>,
  }));

  return preCaptureDatabaseDumps(
    dumpInputs,
    {
      buildDbContext: async (dep) =>
        buildDbContext(
          args.k8s,
          args.kubeconfigPath,
          dep.namespace,
          dep.deploymentName,
          { runtime: dep.catalogRuntime, code: dep.catalogCode },
          (dep.configuration ?? {}) as Record<string, unknown>,
        ),
      // The DbManagerContext from buildDbContext carries k8s; the
      // hook adapter strips it back out per its narrower interface,
      // so the lambdas below cast to the shape preCaptureDatabaseDumps
      // expects.
      listDatabases: async (ctx) =>
        listDatabases(ctx as Parameters<typeof listDatabases>[0]),
      exportDatabaseToPvc: async (ctx, database, outputFileName, deploymentSubPath) =>
        exportDatabaseToPvc(
          ctx as Parameters<typeof exportDatabaseToPvc>[0],
          database,
          outputFileName,
          deploymentSubPath,
          // Predump: keep the dump IN PLACE (files snapshot captures it; restore
          // finds it there). Skips the file-manager-pod move that would else
          // fail the dump when the on-demand FM pod isn't up at capture time.
          { moveToExports: false },
        ),
      // Free-space probe on the DB pod's data volume. `df -P -k <dataRoot>`
      // prints one data row: "Filesystem 1K-blocks Used Available Capacity%
      // Mounted". We read Available (col 4) + Capacity% (col 5). Any parse or
      // exec failure returns null → the hook proceeds (fail-open: a probe
      // hiccup must not suppress a dump).
      checkFreeSpace: async (ctx) => {
        try {
          const dataRoot = ENGINE_CONFIG[ctx.engine].dataRoot;
          const res = await execInPod(ctx.kubeconfigPath, ctx.namespace, ctx.podName, ctx.containerName,
            ['sh', '-c', `df -P -k ${dataRoot} | tail -1`]);
          if (res.exitCode !== 0) return null;
          const parts = res.stdout.trim().split(/\s+/);
          const availKb = Number.parseInt(parts[3] ?? '', 10);
          const usedPercent = Number.parseInt((parts[4] ?? '').replace('%', ''), 10);
          if (!Number.isFinite(availKb) || !Number.isFinite(usedPercent)) return null;
          return { freeBytes: availKb * 1024, usedPercent };
        } catch {
          return null;
        }
      },
    },
    {
      backupId: args.backupId,
      onProgress: args.onProgress,
    },
  );
}

/**
 * Fold per-deployment pre-dump results into the operator-facing
 * {@link BackupDatabaseDumps} summary persisted on the bundle.
 *
 * The summary is a SEPARATE dimension from the bundle's `status`: a bundle can
 * be `completed` while its database dumps are `degraded`. The raw-files
 * component always captures each database's crash-consistent on-disk directory,
 * so a degraded/failed logical dump never blocks restore — it only means the
 * portable, cross-version logical layer is absent for those databases, which
 * the operator surfaces from this summary.
 */
export function buildDatabaseDumpsSummary(
  results: ReadonlyArray<PreDumpDeploymentResult>,
  extraDeployments: ReadonlyArray<BackupDatabaseDumps['deployments'][number]> = [],
): BackupDatabaseDumps {
  const fromResults = results.map((r) => {
    const databases: BackupDatabaseDumps['deployments'][number]['databases'] = [];
    for (const d of r.databaseDumps) {
      databases.push({ name: d.database, status: 'dumped', sizeBytes: d.sizeBytes });
    }
    for (const f of r.databaseFailures) {
      databases.push({
        name: f.database,
        status: f.benign ? 'degraded' : 'failed',
        sizeBytes: 0,
        error: f.error,
      });
    }
    // A deployment-level error (e.g. listDatabases failed, pod not running)
    // means we could not even enumerate its databases — surface it as a
    // synthetic failed entry so the gap is visible.
    if (r.error) {
      databases.push({ name: '(deployment)', status: 'failed', sizeBytes: 0, error: r.error });
    }
    return {
      deploymentId: r.deploymentId,
      deploymentName: r.deploymentName,
      engine: r.engine as string | null,
      databases,
    };
  });

  // extraDeployments carries non-catalog logical dumps (e.g. SQLite files
  // discovered on the PVC). They fold into the same summary + status.
  const deployments = [...fromResults, ...extraDeployments];

  // Status is derived from the FINAL per-database statuses so extras count too.
  const allDbs = deployments.flatMap((d) => d.databases);
  const status: BackupDatabaseDumps['status'] = allDbs.length === 0
    ? 'none'
    : allDbs.some((db) => db.status !== 'dumped')
      ? 'degraded'
      : 'ok';

  const remediation = status === 'degraded'
    ? 'One or more databases have no fresh logical dump in this bundle. The crash-consistent raw-files snapshot still captures them, so the bundle remains restorable; to also get a portable/cross-version logical dump, resolve the per-database reason shown (install the dump tool in a bring-your-own image, grow a full PVC, or use a supported engine) and re-run the bundle.'
    : null;

  return { status, deployments, remediation };
}

// Re-export for orchestrator imports + ergonomic typing.
export type { PreDumpDeploymentResult, Engine };
