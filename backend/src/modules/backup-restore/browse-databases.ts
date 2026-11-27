/**
 * The cart's databases picker: what a bundle holds of the tenant's databases,
 * per instance, and whether each instance is still there to restore into.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BrowseDatabasesResponse } from '@insula/api-contracts';
import { backupJobs, deployments } from '../../db/schema.js';
import { loadDatabaseSnapshotRows } from './executors/databases-from-snapshots.js';

export async function browseBundleDatabases(app: FastifyInstance, bundleId: string, tenantId: string): Promise<BrowseDatabasesResponse> {
  const [job] = await app.db.select({ databaseDumps: backupJobs.databaseDumps }).from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
  const summary = job?.databaseDumps ?? null;
  const rows = await loadDatabaseSnapshotRows(app, bundleId);
  const perDatabase = rows.length > 0;

  // Per instance: its snapshots, or (older bundles) the dumps its summary lists.
  const byInstance = new Map<string, Array<{ name: string; sizeBytes: number; serverVersion: string | null }>>();
  const fromSummary = (deploymentId: string, name: string) =>
    summary?.deployments.find((d) => d.deploymentId === deploymentId)?.databases.find((d) => d.name === name);
  if (perDatabase) {
    for (const r of rows) {
      const entry = fromSummary(r.deploymentId, r.database);
      byInstance.set(r.deploymentId, [...(byInstance.get(r.deploymentId) ?? []), {
        name: r.database, sizeBytes: entry?.sizeBytes ?? 0, serverVersion: entry?.serverVersion ?? null,
      }]);
    }
  } else {
    for (const d of summary?.deployments ?? []) {
      if (!d.deploymentId || d.engine === 'sqlite') continue;
      const dumped = d.databases.filter((db) => db.status === 'dumped' && !db.name.startsWith('('));
      if (dumped.length > 0) byInstance.set(d.deploymentId, dumped.map((db) => ({ name: db.name, sizeBytes: db.sizeBytes, serverVersion: null })));
    }
  }
  const ids = [...byInstance.keys()];
  const live = ids.length === 0 ? [] : await app.db
    .select({ id: deployments.id, name: deployments.name, detached: deployments.dataDetachedPath })
    .from(deployments)
    .where(and(inArray(deployments.id, ids), eq(deployments.tenantId, tenantId), isNull(deployments.deletedAt)));
  const liveById = new Map(live.map((d) => [d.id, d]));

  const instances = ids.map((id) => {
    const fromBundle = summary?.deployments.find((d) => d.deploymentId === id);
    const now = liveById.get(id);
    const unavailableReason = !now
      ? 'this database instance no longer exists, so there is nothing to restore its databases into'
      : now.detached
        ? 'its data is detached: attach it first'
        : null;
    return {
      deploymentId: id,
      deploymentName: now?.name ?? fromBundle?.deploymentName ?? id,
      engine: fromBundle?.engine ?? null,
      available: unavailableReason === null,
      unavailableReason,
      databases: [...(byInstance.get(id) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }).sort((a, b) => a.deploymentName.localeCompare(b.deploymentName));
  return { bundleId, perDatabase, instances };
}
