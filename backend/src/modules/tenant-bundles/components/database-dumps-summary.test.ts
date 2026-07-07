/**
 * Unit tests for buildDatabaseDumpsSummary — the fold from per-deployment
 * pre-dump results into the operator-facing BackupDatabaseDumps summary.
 *
 * Invariant under test: the summary is a SEPARATE dimension from bundle
 * status. A degraded/failed logical dump never blocks restore (the raw-files
 * floor covers it), so the summary just makes the gap visible.
 */

import { describe, expect, it } from 'vitest';
import { buildDatabaseDumpsSummary } from './database-predump-orchestration.js';
import type { PreDumpDeploymentResult } from './database-predump.js';

function res(over: Partial<PreDumpDeploymentResult>): PreDumpDeploymentResult {
  return {
    deploymentId: 'd1',
    deploymentName: 'maria-x',
    namespace: 'tenant-test',
    engine: 'mariadb',
    databaseDumps: [],
    databaseFailures: [],
    durationMs: 1,
    ...over,
  };
}

describe('buildDatabaseDumpsSummary', () => {
  it('reports status=none when there are no database deployments', () => {
    expect(buildDatabaseDumpsSummary([])).toEqual({ status: 'none', deployments: [], remediation: null });
  });

  it('reports status=none when deployments exist but expose no databases', () => {
    const s = buildDatabaseDumpsSummary([res({ databaseDumps: [], databaseFailures: [] })]);
    expect(s.status).toBe('none');
  });

  it('reports status=ok when every database dumped', () => {
    const s = buildDatabaseDumpsSummary([
      res({ databaseDumps: [{ database: 'shop', pvcPath: '/x', sizeBytes: 10 }] }),
    ]);
    expect(s.status).toBe('ok');
    expect(s.remediation).toBeNull();
    expect(s.deployments[0]?.databases).toEqual([{ name: 'shop', status: 'dumped', sizeBytes: 10 }]);
  });

  it('marks a benign failure as degraded and sets status=degraded + remediation', () => {
    const s = buildDatabaseDumpsSummary([
      res({
        engine: 'mongodb',
        databaseFailures: [{ database: 'appdb', error: 'mongodump not available', benign: true }],
      }),
    ]);
    expect(s.status).toBe('degraded');
    expect(s.remediation).toMatch(/raw-files snapshot/i);
    expect(s.deployments[0]?.databases[0]).toMatchObject({ name: 'appdb', status: 'degraded' });
  });

  it('marks a hard failure as failed (still degraded at bundle level, never blocks restore)', () => {
    const s = buildDatabaseDumpsSummary([
      res({ databaseFailures: [{ database: 'a', error: 'mysqldump crashed', benign: false }] }),
    ]);
    expect(s.status).toBe('degraded');
    expect(s.deployments[0]?.databases[0]).toMatchObject({ name: 'a', status: 'failed' });
  });

  it('surfaces a deployment-level error as a synthetic failed entry', () => {
    const s = buildDatabaseDumpsSummary([res({ error: 'pod not running' })]);
    expect(s.status).toBe('degraded');
    expect(s.deployments[0]?.databases[0]).toMatchObject({ name: '(deployment)', status: 'failed' });
  });

  it('mixes dumped + degraded across deployments → degraded overall', () => {
    const s = buildDatabaseDumpsSummary([
      res({ deploymentId: 'ok', databaseDumps: [{ database: 'good', pvcPath: '/x', sizeBytes: 1 }] }),
      res({ deploymentId: 'bad', databaseFailures: [{ database: 'b', error: 'PVC 97% full', benign: true }] }),
    ]);
    expect(s.status).toBe('degraded');
    expect(s.deployments).toHaveLength(2);
  });
});
