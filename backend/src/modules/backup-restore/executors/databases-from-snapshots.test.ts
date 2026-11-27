import { describe, expect, it } from 'vitest';
import { databasesSelectorSchema, type BackupDatabaseDumps } from '@insula/api-contracts';
import { requestsFor, type DatabaseSnapshotRow } from './databases-from-snapshots.js';

const D1 = '0b7e4c1e-0000-4000-8000-000000000001';
const D2 = '0b7e4c1e-0000-4000-8000-000000000002';
const dep = { deploymentId: D1, deploymentName: 'maria', catalogCode: 'mariadb', catalogRuntime: 'mariadb', configuration: null, storagePath: null };
const rows: DatabaseSnapshotRow[] = [
  { deploymentId: D1, database: 'shop', snapshotId: 'aaaaaaaa' },
  { deploymentId: D1, database: 'blog', snapshotId: 'bbbbbbbb' },
  { deploymentId: D2, database: 'shop', snapshotId: 'cccccccc' },
];
const summary: BackupDatabaseDumps = {
  status: 'ok',
  deployments: [{ deploymentId: D1, deploymentName: 'maria', engine: 'mariadb', databases: [{ name: 'shop', status: 'dumped', sizeBytes: 1, snapshotId: 'aaaaaaaa', serverVersion: '10.11.9' }] }],
};

describe('requestsFor', () => {
  it('a whole instance: its own snapshots, never a sibling instance\'s', () => {
    const { requests, missing } = requestsFor({ kind: 'ids', deploymentIds: [D1] }, dep, rows, summary);
    expect(requests).toEqual([
      { source: 'shop', snapshotId: 'aaaaaaaa', serverVersion: '10.11.9' },
      { source: 'blog', snapshotId: 'bbbbbbbb', serverVersion: null },
    ]);
    expect(missing).toEqual([]);
  });

  it('chosen databases, with a copy\'s new name; one without a snapshot is reported', () => {
    const { requests, missing } = requestsFor(
      { kind: 'databases', deploymentId: D1, databases: [{ name: 'shop', targetName: 'shop_old' }, { name: 'gone' }], mode: 'copy' },
      dep, rows, null,
    );
    expect(requests).toEqual([{ source: 'shop', snapshotId: 'aaaaaaaa', serverVersion: null, targetName: 'shop_old' }]);
    expect(missing).toEqual(['gone']);
  });
});

describe('databasesSelectorSchema', () => {
  it('takes the modes; in place by default', () => {
    expect(databasesSelectorSchema.parse({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(databasesSelectorSchema.safeParse({ kind: 'ids', deploymentIds: [D1], mode: 'test' }).success).toBe(true);
    expect(databasesSelectorSchema.safeParse({ kind: 'all', mode: 'wipe' }).success).toBe(false);
  });

  it('a new name only for a copy, and a valid one', () => {
    const sel = (databases: unknown, mode?: string) => databasesSelectorSchema.safeParse({ kind: 'databases', deploymentId: D1, databases, mode }).success;
    expect(sel([{ name: 'shop', targetName: 'shop_copy' }], 'copy')).toBe(true);
    expect(sel([{ name: 'shop', targetName: 'shop_copy' }], 'replace')).toBe(false);
    expect(sel([{ name: 'shop', targetName: 'shop-copy' }], 'copy')).toBe(false);
    expect(sel([{ name: 'shop', targetName: '1shop' }], 'copy')).toBe(false);
  });

  it('no database twice, no two to one name', () => {
    const sel = (databases: unknown) => databasesSelectorSchema.safeParse({ kind: 'databases', deploymentId: D1, databases, mode: 'copy' }).success;
    expect(sel([{ name: 'shop' }, { name: 'shop' }])).toBe(false);
    expect(sel([{ name: 'a', targetName: 'X' }, { name: 'b', targetName: 'x' }])).toBe(false);
    expect(sel([{ name: 'we;ird db' }])).toBe(true);
  });
});
