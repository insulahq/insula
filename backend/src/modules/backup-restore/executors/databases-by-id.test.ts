/**
 * Unit tests for the `databases-by-id` restore executor.
 *
 * The executor's k8s / DB-pod side effects are injected (mirrors
 * `database-predump.ts`), so these tests drive the PURE resolution +
 * import orchestration without a live cluster. The end-to-end import is
 * covered by the tenant backup/restore integration harness (E2E).
 */

import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '../../../shared/errors.js';
import {
  selectTargetDeployments,
  restoreDatabasesForDeployments,
  sanitizeDumpName,
  isPodNotRunning,
  formatSummary,
  type TargetDeployment,
  type RequestedDeploymentRow,
  type DatabasesRestoreDeps,
} from './databases-by-id.js';

const BUNDLE_ID = 'bkp-abc123';
const SUFFIX = `-${BUNDLE_ID}.sql`;

function dep(id: string, name: string, runtime = 'mariadb'): TargetDeployment {
  return {
    deploymentId: id,
    deploymentName: name,
    catalogCode: runtime,
    catalogRuntime: runtime,
    configuration: { MARIADB_ROOT_PASSWORD: 'secret' },
  };
}

function requested(
  id: string,
  tenantId: string,
  catalogType: string | null,
  name = `dep-${id}`,
): RequestedDeploymentRow {
  return { tenantId, catalogType, deployment: dep(id, name) };
}

/** Ctx is opaque; a marker object is enough for the injected deps. */
type Ctx = { readonly pod: string };

interface DepsOverrides {
  buildDbContext?: DatabasesRestoreDeps<Ctx>['buildDbContext'];
  listDumpFiles?: DatabasesRestoreDeps<Ctx>['listDumpFiles'];
  listDatabaseNames?: DatabasesRestoreDeps<Ctx>['listDatabaseNames'];
  importSql?: DatabasesRestoreDeps<Ctx>['importSql'];
}

function makeDeps(o: DepsOverrides = {}): DatabasesRestoreDeps<Ctx> {
  return {
    buildDbContext: o.buildDbContext ?? (async () => ({ pod: 'db-0' })),
    listDumpFiles: o.listDumpFiles ?? (async () => []),
    listDatabaseNames: o.listDatabaseNames ?? (async () => []),
    importSql: o.importSql ?? (async () => ({ success: true })),
  };
}

describe('selectTargetDeployments', () => {
  it('kind:all returns every tenant database deployment', () => {
    const all = [dep('d1', 'maria-a'), dep('d2', 'maria-b')];
    const out = selectTargetDeployments({ kind: 'all' }, 't1', all, new Map());
    expect(out.map((d) => d.deploymentId)).toEqual(['d1', 'd2']);
  });

  it('kind:ids returns the requested tenant database deployments', () => {
    const map = new Map<string, RequestedDeploymentRow>([
      ['d1', requested('d1', 't1', 'database')],
      ['d2', requested('d2', 't1', 'database')],
    ]);
    const out = selectTargetDeployments({ kind: 'ids', deploymentIds: ['d2'] }, 't1', [], map);
    expect(out.map((d) => d.deploymentId)).toEqual(['d2']);
  });

  it('kind:ids rejects a foreign-tenant deployment with 404 (no cross-tenant leak)', () => {
    const map = new Map<string, RequestedDeploymentRow>([
      ['d9', requested('d9', 'other-tenant', 'database')],
    ]);
    try {
      selectTargetDeployments({ kind: 'ids', deploymentIds: ['d9'] }, 't1', [], map);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe('DEPLOYMENT_NOT_FOUND');
    }
  });

  it('kind:ids rejects a missing deployment with 404', () => {
    try {
      selectTargetDeployments({ kind: 'ids', deploymentIds: ['ghost'] }, 't1', [], new Map());
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).code).toBe('DEPLOYMENT_NOT_FOUND');
    }
  });

  it('kind:ids rejects a non-database deployment with 400', () => {
    const map = new Map<string, RequestedDeploymentRow>([
      ['w1', requested('w1', 't1', 'runtime')],
    ]);
    try {
      selectTargetDeployments({ kind: 'ids', deploymentIds: ['w1'] }, 't1', [], map);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('kind:ids treats a custom deployment (null catalog type) as non-database (400)', () => {
    const map = new Map<string, RequestedDeploymentRow>([
      ['c1', requested('c1', 't1', null)],
    ]);
    expect(() => selectTargetDeployments({ kind: 'ids', deploymentIds: ['c1'] }, 't1', [], map))
      .toThrow(/not a database deployment/);
  });
});

describe('sanitizeDumpName', () => {
  it('replaces filename-unsafe chars, preserving the allowlist', () => {
    expect(sanitizeDumpName('app_db')).toBe('app_db');
    expect(sanitizeDumpName('my db!')).toBe('my_db_');
    expect(sanitizeDumpName('a/b:c')).toBe('a_b_c');
  });
});

describe('isPodNotRunning', () => {
  it('matches the POD_NOT_FOUND ApiError code', () => {
    expect(isPodNotRunning(new ApiError('POD_NOT_FOUND', 'No running pod found', 503))).toBe(true);
  });
  it('matches by message as a fallback', () => {
    expect(isPodNotRunning(new Error('No running pod for this deployment'))).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isPodNotRunning(new Error('connection refused'))).toBe(false);
  });
});

describe('restoreDatabasesForDeployments', () => {
  it('imports each captured dump into its target database with the right PVC path', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-app${SUFFIX}`, `database/mariadb/maria-a/predump-shop${SUFFIX}`, 'unrelated.txt'],
      listDatabaseNames: async () => ['app', 'shop'],
      importSql,
    });

    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);

    expect(summary.totalImported).toBe(2);
    expect(summary.totalFailed).toBe(0);
    expect(importSql).toHaveBeenCalledTimes(2);
    // (ctx, database, filePath, deploymentSubPath)
    expect(importSql).toHaveBeenNthCalledWith(
      1, { pod: 'db-0' }, 'app', `database/mariadb/maria-a/predump-app${SUFFIX}`, 'database/mariadb/maria-a',
    );
    expect(importSql).toHaveBeenNthCalledWith(
      2, { pod: 'db-0' }, 'shop', `database/mariadb/maria-a/predump-shop${SUFFIX}`, 'database/mariadb/maria-a',
    );
    expect(summary.deployments[0]!.status).toBe('imported');
  });

  it('only matches dumps for THIS bundle (ignores other-bundle predumps on the PVC)', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      listDumpFiles: async () => [
        `database/mariadb/maria-a/predump-app${SUFFIX}`,
        'database/mariadb/maria-a/predump-app-bkp-OTHER.sql', // stale predump from a different bundle
      ],
      listDatabaseNames: async () => ['app'],
      importSql,
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(importSql).toHaveBeenCalledTimes(1);
    expect(importSql).toHaveBeenCalledWith(
      { pod: 'db-0' }, 'app', `database/mariadb/maria-a/predump-app${SUFFIX}`, 'database/mariadb/maria-a',
    );
    expect(summary.totalImported).toBe(1);
  });

  it('SKIPS an ambiguous dump when two live db names sanitise to the same token (never imports into the wrong db)', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      // one captured dump for the sanitised token "my_db"
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-my_db${SUFFIX}`],
      // two live databases BOTH sanitise to "my_db" ("my db" → "my_db")
      listDatabaseNames: async () => ['my_db', 'my db'],
      importSql,
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(importSql).not.toHaveBeenCalled();
    expect(summary.totalImported).toBe(0);
    expect(summary.deployments[0]!.skipped.join(' ')).toMatch(/maps to 2 live databases/);
  });

  it('SKIPS (does not fail) a deployment whose DB pod is not running', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      buildDbContext: async () => { throw new ApiError('POD_NOT_FOUND', 'No running pod found', 503); },
      importSql,
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(importSql).not.toHaveBeenCalled();
    expect(summary.totalFailed).toBe(0);
    expect(summary.totalImported).toBe(0);
    expect(summary.deployments[0]!.status).toBe('skipped');
    expect(summary.deployments[0]!.skipped[0]).toMatch(/not running/);
  });

  it('SKIPS a deployment with no dump on the PVC for this bundle', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      listDumpFiles: async () => ['database/mariadb/maria-a/predump-app-bkp-OTHER.sql'], // none for BUNDLE_ID
      listDatabaseNames: async () => ['app'],
      importSql,
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(importSql).not.toHaveBeenCalled();
    expect(summary.totalFailed).toBe(0);
    expect(summary.deployments[0]!.status).toBe('skipped');
    expect(summary.deployments[0]!.skipped[0]).toMatch(/no database dump found/);
  });

  it('SKIPS a dump whose target database is not currently present (recreate-then-retry)', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-gone${SUFFIX}`],
      listDatabaseNames: async () => ['app'], // 'gone' not present
      importSql,
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(importSql).not.toHaveBeenCalled();
    expect(summary.totalSkipped).toBeGreaterThan(0);
    expect(summary.deployments[0]!.status).toBe('skipped');
    expect(summary.deployments[0]!.skipped[0]).toMatch(/not present/);
  });

  it('FAILS the deployment when an import command errors', async () => {
    const deps = makeDeps({
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-app${SUFFIX}`],
      listDatabaseNames: async () => ['app'],
      importSql: async () => ({ success: false, error: 'syntax error near line 3' }),
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(summary.totalFailed).toBe(1);
    expect(summary.deployments[0]!.status).toBe('failed');
    expect(summary.deployments[0]!.failed[0]!.database).toBe('app');
    expect(summary.deployments[0]!.failed[0]!.error).toMatch(/syntax error/);
  });

  it('PROPAGATES a non-pod-not-running buildDbContext error (genuine failure)', async () => {
    const deps = makeDeps({
      buildDbContext: async () => { throw new Error('kube apiserver unreachable'); },
    });
    await expect(restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps))
      .rejects.toThrow(/kube apiserver unreachable/);
  });

  it('maps a sanitised dump name back to the real database name for import', async () => {
    const importSql = vi.fn(async () => ({ success: true }));
    const deps = makeDeps({
      // real db name 'my db' → predump wrote sanitised 'my_db'
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-my_db${SUFFIX}`],
      listDatabaseNames: async () => ['my db'],
      importSql,
    });
    await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    // Import must target the REAL name, from the SANITISED file.
    expect(importSql).toHaveBeenCalledWith(
      { pod: 'db-0' }, 'my db', `database/mariadb/maria-a/predump-my_db${SUFFIX}`, 'database/mariadb/maria-a',
    );
  });

  it('aggregates a mixed run (imported + skipped) and marks it imported', async () => {
    const deps = makeDeps({
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-app${SUFFIX}`, `database/mariadb/maria-a/predump-gone${SUFFIX}`],
      listDatabaseNames: async () => ['app'],
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    expect(summary.totalImported).toBe(1);
    expect(summary.totalSkipped).toBe(1);
    expect(summary.deployments[0]!.status).toBe('imported');
  });

  it('returns an empty summary for zero targets', async () => {
    const summary = await restoreDatabasesForDeployments([], BUNDLE_ID, makeDeps());
    expect(summary).toEqual({ deployments: [], totalImported: 0, totalSkipped: 0, totalFailed: 0 });
  });
});

describe('formatSummary', () => {
  it('produces a ≤500-char honest one-liner', async () => {
    const deps = makeDeps({
      listDumpFiles: async () => [`database/mariadb/maria-a/predump-app${SUFFIX}`],
      listDatabaseNames: async () => ['app'],
    });
    const summary = await restoreDatabasesForDeployments([dep('d1', 'maria-a')], BUNDLE_ID, deps);
    const msg = formatSummary(summary);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toContain('imported 1');
    expect(msg).toContain('maria-a: imported 1 db(s)');
  });
});
