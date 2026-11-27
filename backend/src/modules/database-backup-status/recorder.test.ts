import { describe, expect, it } from 'vitest';
import type { BackupDatabaseDumps } from '@insula/api-contracts';
import {
  DEPLOYMENT_ENTRY,
  DUMPS_DID_NOT_RUN_PREFIX,
  ERROR_MAX_CHARS,
  MAX_ROWS_PER_SUBJECT,
  MAX_ROWS_PER_TENANT,
  MORE_DATABASES_ENTRY,
  NAME_MAX_CHARS,
  SNAPSHOT_NOT_KEPT_ERROR,
  SQLITE_DISCOVERY_ENTRY,
  SQLITE_SUBJECT,
  planDatabaseBackupRecord,
  type BundleDatabaseOutcome,
  type DatabaseBackupRow,
} from './recorder.js';

const T = 'tenant-1';
const DEP = 'dep-maria';
const NIGHT1 = new Date('2026-11-20T01:50:00Z');
const NIGHT2 = new Date('2026-11-21T01:50:00Z');

type Db = BackupDatabaseDumps['deployments'][number]['databases'][number];

function summary(dbs: Db[], extra: BackupDatabaseDumps['deployments'] = []): BackupDatabaseDumps {
  return {
    status: 'ok',
    deployments: [{ deploymentId: DEP, deploymentName: 'my-mariadb', engine: 'mariadb', databases: dbs }, ...extra],
  };
}

function outcome(s: BackupDatabaseDumps, over: Partial<BundleDatabaseOutcome> = {}): BundleDatabaseOutcome {
  return { tenantId: T, bundleId: 'bkp-2', at: NIGHT2, summary: s, snapshotKept: true, sqliteCaptureComplete: true, ...over };
}

function row(databaseName: string, over: Partial<DatabaseBackupRow> = {}): DatabaseBackupRow {
  return {
    tenantId: T, subjectKey: DEP, databaseName, deploymentId: DEP, deploymentName: 'my-mariadb', engine: 'mariadb',
    lastAttemptAt: NIGHT1, lastAttemptBundleId: 'bkp-1', lastStatus: 'dumped', lastError: null,
    lastSuccessAt: NIGHT1, lastSuccessBundleId: 'bkp-1', lastSuccessSizeBytes: 100,
    staleSince: null, alertedAt: null, lastAlertedAt: null, createdAt: new Date('2026-11-01T00:00:00Z'), ...over,
  };
}

const live = new Set([DEP]);

describe('planDatabaseBackupRecord — what a bundle records', () => {
  it('a first good dump creates the row with its success', () => {
    const plan = planDatabaseBackupRecord([], outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 42 }])), live);
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts).toEqual([expect.objectContaining({
      subjectKey: DEP, databaseName: 'shop', lastStatus: 'dumped', lastError: null,
      lastSuccessAt: NIGHT2, lastSuccessBundleId: 'bkp-2', lastSuccessSizeBytes: 42, createdAt: NIGHT2,
    })]);
  });

  it('a failed dump records the error and keeps the last good backup it had', () => {
    const plan = planDatabaseBackupRecord(
      [row('shop')],
      outcome(summary([{ name: 'shop', status: 'failed', sizeBytes: 0, error: 'Column count of mysql.proc is wrong' }])),
      live,
    );
    expect(plan.upserts[0]).toMatchObject({
      lastStatus: 'failed', lastError: 'Column count of mysql.proc is wrong', lastAttemptAt: NIGHT2,
      lastSuccessAt: NIGHT1, lastSuccessBundleId: 'bkp-1', lastSuccessSizeBytes: 100,
    });
  });

  it('a dump with a snapshot of its own is kept by it, whatever became of the files snapshot', () => {
    const plan = planDatabaseBackupRecord([row('shop')], outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 9, snapshotId: 'abcdef12' }]), { snapshotKept: false }), live);
    expect(plan.upserts[0]).toMatchObject({ lastStatus: 'dumped', lastError: null, lastSuccessAt: NIGHT2, lastSuccessSizeBytes: 9 });
  });

  it('a dump whose files snapshot failed is not a backup', () => {
    const plan = planDatabaseBackupRecord([row('shop')], outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 9 }]), { snapshotKept: false }), live);
    expect(plan.upserts[0]).toMatchObject({ lastStatus: 'failed', lastError: SNAPSHOT_NOT_KEPT_ERROR, lastSuccessAt: NIGHT1 });
  });

  it('keeps the episode state the sweep owns', () => {
    const stale = new Date('2026-11-22T04:00:00Z');
    const plan = planDatabaseBackupRecord([row('shop', { staleSince: stale, alertedAt: stale, lastAlertedAt: stale })],
      outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 1 }])), live);
    expect(plan.upserts[0]).toMatchObject({ staleSince: stale, alertedAt: stale, lastAlertedAt: stale, lastSuccessAt: NIGHT2 });
  });

  it('never stores a password an error echoed from the dump command', () => {
    const plan = planDatabaseBackupRecord([], outcome(summary([{ name: 'shop', status: 'failed', sizeBytes: 0,
      error: "command terminated: [sh -c mongodump --db=shop -u 'root' -p 'S3cret' --archive=/x] exit 1" }])), live);
    expect(plan.upserts[0]!.lastError).not.toContain('S3cret');
    expect(plan.upserts[0]!.lastError).toContain('-p ***');
  });

  it('caps the stored error', () => {
    const plan = planDatabaseBackupRecord([], outcome(summary([{ name: 'shop', status: 'failed', sizeBytes: 0, error: 'x'.repeat(2000) }])), live);
    expect(plan.upserts[0]!.lastError!.length).toBe(ERROR_MAX_CHARS);
  });
});

describe('planDatabaseBackupRecord — pruning only on positive evidence', () => {
  it('a clean listing that no longer names a database removes it', () => {
    const plan = planDatabaseBackupRecord([row('shop'), row('old')], outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 1 }])), live);
    expect(plan.deletes).toEqual([{ subjectKey: DEP, databaseName: 'old' }]);
  });

  it('a deployment whose databases could not be listed prunes nothing and is recorded as failed', () => {
    const plan = planDatabaseBackupRecord(
      [row('shop'), row('old')],
      outcome(summary([{ name: DEPLOYMENT_ENTRY, status: 'failed', sizeBytes: 0, error: 'pod not running' }])),
      live,
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts).toEqual([expect.objectContaining({ databaseName: DEPLOYMENT_ENTRY, lastStatus: 'failed', lastSuccessAt: null })]);
  });

  it('the synthetic failure row goes once the deployment lists its databases again', () => {
    const plan = planDatabaseBackupRecord(
      [row('shop'), row(DEPLOYMENT_ENTRY, { lastStatus: 'failed', lastSuccessAt: null })],
      outcome(summary([{ name: 'shop', status: 'dumped', sizeBytes: 1 }])),
      live,
    );
    expect(plan.deletes).toEqual([{ subjectKey: DEP, databaseName: DEPLOYMENT_ENTRY }]);
  });

  it('a deleted deployment loses its rows; a live one the bundle did not mention keeps them', () => {
    const other = row('crm', { subjectKey: 'dep-pg', deploymentId: 'dep-pg', engine: 'postgresql' });
    const gone = row('wiki', { subjectKey: 'dep-gone', deploymentId: 'dep-gone' });
    const plan = planDatabaseBackupRecord([other, gone], outcome({ status: 'none', deployments: [] }), new Set(['dep-pg']));
    expect(plan.deletes).toEqual([{ subjectKey: 'dep-gone', databaseName: 'wiki' }]);
  });

  describe('SQLite', () => {
    const sqliteRow = (name: string) => row(name, { subjectKey: SQLITE_SUBJECT, deploymentId: null, deploymentName: '(sqlite files)', engine: 'sqlite' });
    const sqlite = (dbs: Db[]): BackupDatabaseDumps['deployments'] =>
      [{ deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases: dbs }];

    it('records files under one subject, without a deployment id', () => {
      const plan = planDatabaseBackupRecord([], outcome({ status: 'ok', deployments: sqlite([{ name: '/data/app/site.db', status: 'dumped', sizeBytes: 5 }]) }), live);
      expect(plan.upserts[0]).toMatchObject({ subjectKey: SQLITE_SUBJECT, deploymentId: null, databaseName: '/data/app/site.db' });
    });

    it('a complete capture that no longer finds a file removes it; no SQLite files at all removes them all', () => {
      const kept = planDatabaseBackupRecord([sqliteRow('/data/a.db'), sqliteRow('/data/b.db')],
        outcome({ status: 'ok', deployments: sqlite([{ name: '/data/a.db', status: 'dumped', sizeBytes: 1 }]) }), live);
      expect(kept.deletes).toEqual([{ subjectKey: SQLITE_SUBJECT, databaseName: '/data/b.db' }]);
      const none = planDatabaseBackupRecord([sqliteRow('/data/a.db')], outcome({ status: 'none', deployments: [] }), live);
      expect(none.deletes).toEqual([{ subjectKey: SQLITE_SUBJECT, databaseName: '/data/a.db' }]);
    });

    it('an incomplete capture (cut short, or no file manager) prunes nothing', () => {
      const cut = planDatabaseBackupRecord([sqliteRow('/data/a.db'), sqliteRow('/data/b.db')],
        outcome({ status: 'ok', deployments: sqlite([{ name: '/data/a.db', status: 'dumped', sizeBytes: 1 }]) }, { sqliteCaptureComplete: false }), live);
      expect(cut.deletes).toEqual([]);
      const absent = planDatabaseBackupRecord([sqliteRow('/data/a.db')], outcome({ status: 'none', deployments: [] }, { sqliteCaptureComplete: false }), live);
      expect(absent.deletes).toEqual([]);
    });

    it('a failed discovery prunes nothing and is recorded', () => {
      const plan = planDatabaseBackupRecord([sqliteRow('/data/a.db')],
        outcome({ status: 'degraded', deployments: sqlite([{ name: SQLITE_DISCOVERY_ENTRY, status: 'failed', sizeBytes: 0, error: 'could not run' }]) }), live);
      expect(plan.deletes).toEqual([]);
      expect(plan.upserts).toEqual([expect.objectContaining({ databaseName: SQLITE_DISCOVERY_ENTRY, lastStatus: 'failed' })]);
    });
  });
});

describe('planDatabaseBackupRecord — dumps that did not run', () => {
  it('stamps the live databases it did not reach as failed, keeping their last good backup', () => {
    const plan = planDatabaseBackupRecord(
      [row('shop'), row('crm')],
      outcome({ status: 'none', deployments: [] }, { databaseDumpsDidNotRun: 'the pre-dump step failed: boom' }),
      live,
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts.map((u) => [u.databaseName, u.lastStatus, u.lastAttemptAt, u.lastSuccessAt])).toEqual([
      ['shop', 'failed', NIGHT2, NIGHT1], ['crm', 'failed', NIGHT2, NIGHT1],
    ]);
    expect(plan.upserts[0]!.lastError).toBe(`${DUMPS_DID_NOT_RUN_PREFIX}: the pre-dump step failed: boom`);
  });

  it('stamps SQLite rows when the SQLite capture did not run, without pruning them', () => {
    const sqlite = row('/data/a.db', { subjectKey: SQLITE_SUBJECT, deploymentId: null, engine: 'sqlite' });
    const plan = planDatabaseBackupRecord([sqlite], outcome({ status: 'none', deployments: [] },
      { sqliteCaptureComplete: false, sqliteDidNotRun: 'the file manager could not be started' }), live);
    expect(plan.deletes).toEqual([]);
    expect(plan.upserts[0]).toMatchObject({ databaseName: '/data/a.db', lastStatus: 'failed' });
  });

  it('a deleted deployment is still pruned, not stamped', () => {
    const plan = planDatabaseBackupRecord([row('wiki', { subjectKey: 'dep-gone' })],
      outcome({ status: 'none', deployments: [] }, { databaseDumpsDidNotRun: 'x' }), new Set());
    expect(plan.deletes).toEqual([{ subjectKey: 'dep-gone', databaseName: 'wiki' }]);
    expect(plan.upserts).toEqual([]);
  });
});

describe('planDatabaseBackupRecord — bounded by what a tenant controls', () => {
  it('cuts a long name, keeping a hash of the whole so two long names stay apart', () => {
    const a = `/data/${'x'.repeat(400)}/a.db`;
    const b = `/data/${'x'.repeat(400)}/b.db`;
    const sqlite = (names: string[]): BackupDatabaseDumps => ({ status: 'ok', deployments: [
      { deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases: names.map((n) => ({ name: n, status: 'dumped' as const, sizeBytes: 1 })) },
    ] });
    const plan = planDatabaseBackupRecord([], outcome(sqlite([a, b])), live);
    const names = plan.upserts.map((u) => u.databaseName);
    expect(names.every((n) => n.length <= NAME_MAX_CHARS)).toBe(true);
    expect(new Set(names).size).toBe(2);
    // the same name always maps to the same key
    expect(planDatabaseBackupRecord([], outcome(sqlite([a])), live).upserts[0]!.databaseName).toBe(names[0]);
  });

  it('folds a subject\'s databases past the cap into one counted row, worst status first', () => {
    const many = Array.from({ length: MAX_ROWS_PER_SUBJECT + 40 }, (_, i) => ({
      name: `db${String(i).padStart(4, '0')}`, status: (i === 120 ? 'failed' : 'dumped') as 'failed' | 'dumped', sizeBytes: 10,
    }));
    const plan = planDatabaseBackupRecord([], outcome(summary(many)), live);
    expect(plan.upserts).toHaveLength(MAX_ROWS_PER_SUBJECT);
    const more = plan.upserts.find((u) => u.databaseName === MORE_DATABASES_ENTRY)!;
    expect(more).toMatchObject({ lastStatus: 'failed', lastError: '1 of 41 further databases were not backed up' });
  });

  it('the folded row is kept by its databases\' own snapshots when the files snapshot failed', () => {
    const many = Array.from({ length: MAX_ROWS_PER_SUBJECT + 3 }, (_, i) => ({
      name: `db${String(i).padStart(4, '0')}`, status: 'dumped' as const, sizeBytes: 10, snapshotId: `abcdef${String(i).padStart(4, '0')}`,
    }));
    const plan = planDatabaseBackupRecord([], outcome(summary(many), { snapshotKept: false }), live);
    expect(plan.upserts.every((u) => u.lastStatus === 'dumped')).toBe(true);
    const mixed = many.map((d, i) => (i === many.length - 1 ? { name: d.name, status: d.status, sizeBytes: d.sizeBytes } : d));
    const plan2 = planDatabaseBackupRecord([], outcome(summary(mixed), { snapshotKept: false }), live);
    expect(plan2.upserts.find((u) => u.databaseName === MORE_DATABASES_ENTRY)).toMatchObject({ lastStatus: 'failed', lastError: SNAPSHOT_NOT_KEPT_ERROR });
  });

  it('a tenant with many subjects keeps under its overall cap', () => {
    const deps = Array.from({ length: 20 }, (_, d) => ({
      deploymentId: `dep-${d}`, deploymentName: `db-${d}`, engine: 'mariadb',
      databases: Array.from({ length: 60 }, (_, i) => ({ name: `d${i}`, status: 'dumped' as const, sizeBytes: 1 })),
    }));
    const plan = planDatabaseBackupRecord([], outcome({ status: 'ok', deployments: deps }), new Set(deps.map((d) => d.deploymentId)));
    expect(plan.upserts.length).toBeLessThanOrEqual(MAX_ROWS_PER_TENANT);
  });
});
