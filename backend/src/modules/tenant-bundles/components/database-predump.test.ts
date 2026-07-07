/**
 * Pre-capture DB hook tests.
 *
 * The hook is a thin orchestration layer over the existing SQL Manager
 * primitives in `db-manager.ts` (exportDatabaseToPvc + listDatabases).
 * Tests focus on the orchestration shape — backup-tool image carries
 * NO DB tenants, so there is no shell or container surface to test
 * here.
 *
 * Tested behaviours:
 *   - Only deployments whose catalog entry is type='database' are
 *     selected for pre-dump.
 *   - One deployment failing does not abort the others.
 *   - Per-deployment time bound is respected (default 5 min).
 *   - Result records every deployment that was attempted, with
 *     dump count + size + timing + error if any.
 *   - Hook is a no-op (and returns an empty array) when the tenant
 *     has zero database deployments.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  preCaptureDatabaseDumps,
  type PreDumpDeployment,
  type PreDumpDeps,
} from './database-predump.js';

function makeDb(over: Partial<PreDumpDeployment> = {}): PreDumpDeployment {
  return {
    deploymentId: 'd1',
    deploymentName: 'maria-x',
    namespace: 'tenant-test',
    catalogCode: 'mariadb',
    catalogRuntime: 'mariadb',
    catalogType: 'database',
    configuration: { MARIADB_ROOT_PASSWORD: 'pw' },
    ...over,
  };
}

describe('preCaptureDatabaseDumps', () => {
  it('returns an empty array when no deployments are passed', async () => {
    const out = await preCaptureDatabaseDumps([], { ...stubDeps() });
    expect(out).toEqual([]);
  });

  it('skips non-database deployments without invoking SQL Manager', async () => {
    const deps = stubDeps();
    const out = await preCaptureDatabaseDumps(
      [makeDb({ catalogType: 'application' as 'database' })],
      deps,
    );
    expect(out).toEqual([]);
    expect(deps.buildDbContext).not.toHaveBeenCalled();
    expect(deps.listDatabases).not.toHaveBeenCalled();
    expect(deps.exportDatabaseToPvc).not.toHaveBeenCalled();
  });

  it('runs export for every database returned by listDatabases on every db deployment', async () => {
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [
        { name: 'shop' },
        { name: 'wp' },
      ]),
      exportDatabaseToPvc: vi.fn(async (_ctx, name) => ({
        pvcPath: `/exports/${name}-2026.sql`,
        sizeBytes: name === 'shop' ? 1234 : 5678,
      })),
    });
    const result = await preCaptureDatabaseDumps([makeDb()], deps);

    expect(deps.exportDatabaseToPvc).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]?.databaseDumps).toEqual([
      { database: 'shop', pvcPath: '/exports/shop-2026.sql', sizeBytes: 1234 },
      { database: 'wp', pvcPath: '/exports/wp-2026.sql', sizeBytes: 5678 },
    ]);
    expect(result[0]?.error).toBeUndefined();
  });

  it('does NOT abort the bundle when one deployment fails', async () => {
    const deps = stubDeps({
      listDatabases: vi.fn(async (ctx) => {
        if (ctx.namespace === 'broken') throw new Error('pod not running');
        return [{ name: 'ok' }];
      }),
      exportDatabaseToPvc: vi.fn(async (_ctx, name) => ({
        pvcPath: `/exports/${name}.sql`,
        sizeBytes: 100,
      })),
    });

    const result = await preCaptureDatabaseDumps(
      [
        makeDb({ deploymentId: 'd1', namespace: 'broken' }),
        makeDb({ deploymentId: 'd2', namespace: 'fine' }),
      ],
      deps,
    );

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.deploymentId === 'd1')?.error).toMatch(/pod not running/);
    expect(result.find((r) => r.deploymentId === 'd1')?.databaseDumps).toEqual([]);
    expect(result.find((r) => r.deploymentId === 'd2')?.databaseDumps).toHaveLength(1);
    expect(result.find((r) => r.deploymentId === 'd2')?.error).toBeUndefined();
  });

  it('records per-database export failures without aborting other DBs in the same deployment', async () => {
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [{ name: 'a' }, { name: 'b' }]),
      exportDatabaseToPvc: vi.fn(async (_ctx, name) => {
        if (name === 'a') throw new Error('locked table');
        return { pvcPath: `/exports/${name}.sql`, sizeBytes: 99 };
      }),
    });

    const result = await preCaptureDatabaseDumps([makeDb()], deps);
    expect(result[0]?.databaseDumps).toEqual([
      { database: 'b', pvcPath: '/exports/b.sql', sizeBytes: 99 },
    ]);
    // A generic dump error is a HARD failure (benign=false) → the orchestrator
    // records it as `failed`, not `degraded`.
    expect(result[0]?.databaseFailures).toEqual([
      { database: 'a', error: expect.stringMatching(/locked table/), benign: false },
    ]);
  });

  it('respects perDeploymentTimeoutMs and records a timeout', async () => {
    const deps = stubDeps({
      listDatabases: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return [{ name: 'slow' }];
      }),
    });

    const result = await preCaptureDatabaseDumps([makeDb()], deps, {
      perDeploymentTimeoutMs: 10,
    });
    expect(result[0]?.error).toMatch(/timed out/i);
  });

  it('classifies a benign export error (tool missing / unsupported) as benign=true', async () => {
    const notAvail = Object.assign(new Error('mongodump is not available in this image'), { code: 'EXPORT_NOT_AVAILABLE' });
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [{ name: 'a' }]),
      exportDatabaseToPvc: vi.fn(async () => { throw notAvail; }),
    });
    const result = await preCaptureDatabaseDumps([makeDb()], deps);
    expect(result[0]?.databaseFailures).toEqual([
      { database: 'a', error: expect.stringMatching(/not available/), benign: true },
    ]);
  });

  it('names MongoDB dumps with a .archive.gz extension (SQL engines use .sql)', async () => {
    const seen: string[] = [];
    const deps = stubDeps({
      buildDbContext: vi.fn(async (dep) => ({
        kubeconfigPath: undefined, namespace: dep.namespace, podName: 'p', containerName: 'c',
        engine: 'mongodb' as const, rootPassword: 'pw', rootUsername: 'root',
      })),
      listDatabases: vi.fn(async () => [{ name: 'appdb' }]),
      exportDatabaseToPvc: vi.fn(async (_ctx, _name, outputFileName) => {
        seen.push(outputFileName);
        return { pvcPath: `/exports/${outputFileName}`, sizeBytes: 10 };
      }),
    });
    await preCaptureDatabaseDumps([makeDb({ catalogRuntime: 'mongodb', catalogCode: 'mongodb' })], deps, { backupId: 'bkp-1' });
    expect(seen).toEqual(['predump-appdb-bkp-1.archive.gz']);
  });

  it('degrades (benign) every database and skips dumps when the PVC is nearly full', async () => {
    const exportSpy = vi.fn(async () => ({ pvcPath: '/x.sql', sizeBytes: 1 }));
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [{ name: 'a' }, { name: 'b' }]),
      exportDatabaseToPvc: exportSpy,
      checkFreeSpace: vi.fn(async () => ({ freeBytes: 5 * 1024 * 1024, usedPercent: 97 })),
    });
    const result = await preCaptureDatabaseDumps([makeDb()], deps);
    // No dump attempted — the guard fired before writing to a full volume.
    expect(exportSpy).not.toHaveBeenCalled();
    expect(result[0]?.databaseDumps).toEqual([]);
    expect(result[0]?.databaseFailures.map((f) => f.database)).toEqual(['a', 'b']);
    expect(result[0]?.databaseFailures.every((f) => f.benign)).toBe(true);
    expect(result[0]?.databaseFailures[0]?.error).toMatch(/full/i);
  });

  it('proceeds normally when free space is healthy', async () => {
    const exportSpy = vi.fn(async () => ({ pvcPath: '/x.sql', sizeBytes: 1 }));
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [{ name: 'a' }]),
      exportDatabaseToPvc: exportSpy,
      checkFreeSpace: vi.fn(async () => ({ freeBytes: 20 * 1024 * 1024 * 1024, usedPercent: 40 })),
    });
    const result = await preCaptureDatabaseDumps([makeDb()], deps);
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(result[0]?.databaseDumps).toHaveLength(1);
  });

  it('returns deployments in input order so the orchestrator can match', async () => {
    const deps = stubDeps({
      listDatabases: vi.fn(async () => [{ name: 'x' }]),
      exportDatabaseToPvc: vi.fn(async () => ({ pvcPath: '/exports/x.sql', sizeBytes: 1 })),
    });
    const result = await preCaptureDatabaseDumps(
      [
        makeDb({ deploymentId: 'A' }),
        makeDb({ deploymentId: 'B' }),
        makeDb({ deploymentId: 'C' }),
      ],
      deps,
    );
    expect(result.map((r) => r.deploymentId)).toEqual(['A', 'B', 'C']);
  });
});

// Stub for the db-manager surface so we don't drag k8s tenants into the test.
function stubDeps(over: Partial<PreDumpDeps> = {}): PreDumpDeps {
  return {
    buildDbContext: vi.fn(async (dep) => ({
      kubeconfigPath: undefined,
      namespace: dep.namespace,
      podName: 'p',
      containerName: 'c',
      engine: 'mariadb',
      rootPassword: 'pw',
      rootUsername: 'root',
    })),
    listDatabases: vi.fn(async () => []),
    exportDatabaseToPvc: vi.fn(async () => ({ pvcPath: '/x.sql', sizeBytes: 0 })),
    ...over,
  };
}
