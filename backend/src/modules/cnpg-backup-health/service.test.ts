/**
 * Unit tests for cnpg-backup-health service.
 *
 * Tests the pure helpers (phase parsing, record extraction, sort order)
 * + the readBackupHealth aggregator using a fake CustomObjectsApi that
 * returns canned CR lists. No real K8s connection required.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  __test,
  readBackupHealth,
  type BackupRecord,
  type CnpgBackupHealthTenants,
} from './service.js';

describe('cnpg-backup-health: parsePhase', () => {
  it('returns lowercase known phase', () => {
    expect(__test.parsePhase('completed')).toBe('completed');
    expect(__test.parsePhase('failed')).toBe('failed');
    expect(__test.parsePhase('running')).toBe('running');
    expect(__test.parsePhase('started')).toBe('started');
    expect(__test.parsePhase('pending')).toBe('pending');
  });

  it('case-insensitive', () => {
    expect(__test.parsePhase('Completed')).toBe('completed');
    expect(__test.parsePhase('FAILED')).toBe('failed');
  });

  it('returns unknown for empty / unrecognised', () => {
    expect(__test.parsePhase(undefined)).toBe('unknown');
    expect(__test.parsePhase('')).toBe('unknown');
    expect(__test.parsePhase('weird-phase')).toBe('unknown');
  });
});

describe('cnpg-backup-health: compareRecordsDesc', () => {
  it('most recent first by startedAt', () => {
    const a: BackupRecord = {
      name: 'a', namespace: 'platform', clusterName: 'system-db',
      method: 'barmanObjectStore', phase: 'completed',
      startedAt: '2026-05-06T10:00:00Z', stoppedAt: null, error: null,
    };
    const b: BackupRecord = { ...a, name: 'b', startedAt: '2026-05-06T11:00:00Z' };
    const c: BackupRecord = { ...a, name: 'c', startedAt: '2026-05-06T09:00:00Z' };
    const sorted = [a, b, c].sort(__test.compareRecordsDesc);
    expect(sorted.map((r) => r.name)).toEqual(['b', 'a', 'c']);
  });

  it('falls back to stoppedAt when startedAt missing', () => {
    const a: BackupRecord = {
      name: 'a', namespace: 'platform', clusterName: 'system-db',
      method: 'barmanObjectStore', phase: 'completed',
      startedAt: null, stoppedAt: '2026-05-06T10:00:00Z', error: null,
    };
    const b: BackupRecord = { ...a, name: 'b', stoppedAt: '2026-05-06T11:00:00Z' };
    const sorted = [a, b].sort(__test.compareRecordsDesc);
    expect(sorted.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('cnpg-backup-health: readBackupHealth', () => {
  const NOW_MS = new Date('2026-05-06T16:00:00Z').getTime();

  function fakeTenant(payloadByPlural: Record<string, unknown[]>): CnpgBackupHealthTenants {
    return {
      custom: {
        listNamespacedCustomObject: async ({ plural, namespace }: { plural: string; namespace: string }) => {
          // Filter the canned items by namespace too so tests can fixture
          // both namespaces in one map and the loop only sees its own.
          const all = payloadByPlural[plural] ?? [];
          const filtered = all.filter((item: unknown) => {
            const obj = item as { metadata?: { namespace?: string } };
            return obj.metadata?.namespace === namespace;
          });
          return { items: filtered };
        },
      } as unknown as CnpgBackupHealthTenants['custom'],
    };
  }

  it('healthy state — completed backup < 24h ago', async () => {
    const tenants = fakeTenant({
      clusters: [
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'system-db-daily-1', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
      ],
      scheduledbackups: [
        { metadata: { name: 'system-db-daily', namespace: 'platform' }, spec: { cluster: { name: 'system-db' } } },
      ],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('healthy');
    expect(cluster?.lastSuccessfulBackup?.name).toBe('system-db-daily-1');
    expect(cluster?.lastSuccessSecondsAgo).toBe(60 * 60); // 1 hour
    expect(cluster?.scheduledBackups).toEqual(['system-db-daily']);
    expect(cluster?.clusterHasBackupSpec).toBe(true);
  });

  it('failing state — last attempt is failed (newer than last success)', async () => {
    const tenants = fakeTenant({
      clusters: [
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        // Last success 1h ago
        {
          metadata: { name: 'old-success', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
        // But latest attempt 5min ago FAILED
        {
          metadata: { name: 'fresh-failure', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'barmanObjectStore' },
          status: { phase: 'failed', startedAt: '2026-05-06T15:55:00Z', error: 'S3 auth failed' },
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('failing');
    expect(cluster?.mostRecentFailure?.name).toBe('fresh-failure');
    expect(cluster?.mostRecentFailure?.error).toBe('S3 auth failed');
    // last success still recorded so operators can see what's recoverable
    expect(cluster?.lastSuccessfulBackup?.name).toBe('old-success');
  });

  it('stale state — completed backup older than 24h', async () => {
    const tenants = fakeTenant({
      clusters: [
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'old-success', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-04T15:00:00Z' }, // 49h ago
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('stale');
    expect(cluster?.lastSuccessSecondsAgo).toBeGreaterThan(24 * 3600);
  });

  it('never_run state — no backups at all', async () => {
    const tenants = fakeTenant({
      clusters: [
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('never_run');
    expect(cluster?.lastSuccessfulBackup).toBeNull();
  });

  it('no_backup_config state — cluster has no backup spec', async () => {
    const tenants = fakeTenant({
      clusters: [
        // No spec.backup — happens transiently during recovery
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: {} },
      ],
      backups: [],
      scheduledbackups: [
        // But ScheduledBackup CRs exist! This is the historical staging
        // mistake from 2026-05-06 — Backup CR fired against a Cluster
        // without backup config and failed: "cannot proceed with the
        // backup as the cluster has no backup section".
        { metadata: { name: 'system-db-daily', namespace: 'platform' }, spec: { cluster: { name: 'system-db' } } },
      ],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('no_backup_config');
    expect(cluster?.clusterHasBackupSpec).toBe(false);
    expect(cluster?.scheduledBackups).toEqual(['system-db-daily']);
  });

  // B7 fix (2026-05-22): CNPG 1.21+ moved barman-cloud out of
  // spec.backup into the plugin model. A cluster running the plugin
  // path has spec.backup == null but spec.plugins[barman-cloud]
  // enabled — and DOES back up successfully. The health card was
  // marking such clusters `no_backup_config` and dragging the
  // dashboard into the red. The new detection treats either field
  // shape as "has backup config".
  it('plugin-model — spec.plugins[barman-cloud] enabled counts as backup configured', async () => {
    const NOW_MS_LOCAL = Date.UTC(2026, 4, 22, 6, 0, 0);
    const lastSuccessIso = new Date(NOW_MS_LOCAL - 3 * 3_600_000).toISOString();
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'system-db', namespace: 'platform' },
          // No legacy spec.backup …
          spec: {
            plugins: [
              {
                name: 'barman-cloud.cloudnative-pg.io',
                enabled: true,
                parameters: { barmanObjectName: 'system-postgres-objectstore' },
              },
            ],
          },
        },
      ],
      backups: [
        {
          metadata: { name: 'system-db-daily', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'plugin' },
          status: { phase: 'completed', startedAt: lastSuccessIso, stoppedAt: lastSuccessIso },
        },
      ],
      scheduledbackups: [
        { metadata: { name: 'sb', namespace: 'platform' }, spec: { cluster: { name: 'system-db' } } },
      ],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS_LOCAL });
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.clusterHasBackupSpec).toBe(true);
    expect(cluster?.state).toBe('healthy');
  });

  it('plugin-model — disabled barman-cloud plugin does NOT count as backup configured', async () => {
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'cluster-x', namespace: 'platform' },
          spec: {
            plugins: [
              { name: 'barman-cloud.cloudnative-pg.io', enabled: false, parameters: {} },
            ],
          },
        },
      ],
      backups: [],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    expect(result.find((r) => r.clusterName === 'cluster-x')?.clusterHasBackupSpec).toBe(false);
  });

  // ─── Phase 2 (2026-05-22): cnpg_operator_blind enrichment ──────────────
  //
  // When the cluster is on the plugin model AND the CNPG operator returns
  // zero Backup CRs BUT the object store catalogue reports N>0 backups,
  // the state upgrades from `never_run` to `cnpg_operator_blind`. The
  // catalogue call is mocked here; live behaviour is covered by the
  // catalogue's own service.test.ts.
  it('cnpg_operator_blind — never_run upgrades when catalogue sees real backups', async () => {
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'system-db', namespace: 'platform' },
          spec: {
            plugins: [
              {
                name: 'barman-cloud.cloudnative-pg.io',
                enabled: true,
                parameters: { barmanObjectName: 'system-postgres-objectstore' },
              },
            ],
          },
        },
      ],
      backups: [], // CNPG reports nothing
      scheduledbackups: [],
    });

    // Spy on the catalogue module and force it to return non-empty backups.
    const catalogueModule = await import('../cnpg-backup-catalogue/service.js');
    const { listBackupsFromObjectStore } = catalogueModule;
    const spy = vi.spyOn(catalogueModule, 'listBackupsFromObjectStore').mockResolvedValue({
      source: 'object-store',
      objectStoreName: 'system-postgres-objectstore',
      namespace: 'platform',
      backups: [
        { backupId: '20260522T030001', startedAt: null, endedAt: null, status: 'DONE',
          beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: null,
          uploadedAt: null, parseError: null },
      ],
      unavailableReason: null,
      queryDurationMs: 50,
    });

    // Supply core so the catalogue branch is reachable.
    const tenantsWithCore = { ...tenants, core: {} as never };
    const result = await readBackupHealth(tenantsWithCore, { nowMs: NOW_MS });
    spy.mockRestore();
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('cnpg_operator_blind');
    expect(cluster?.objectStoreBackupCount).toBe(1);
    // The catalogue is also exported by name — ensure we didn't import a stale binding.
    expect(typeof listBackupsFromObjectStore).toBe('function');
  });

  it('cnpg_operator_blind — failing state also upgrades when catalogue has real backups', async () => {
    // CNPG operator producing failed Backup CRs but the archive itself is fine.
    const failedAt = new Date(NOW_MS - 60_000).toISOString();
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'system-db', namespace: 'platform' },
          spec: {
            plugins: [
              { name: 'barman-cloud.cloudnative-pg.io', enabled: true, parameters: { barmanObjectName: 'os' } },
            ],
          },
        },
      ],
      backups: [
        {
          metadata: { name: 'rt-bk-failed', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'plugin' },
          status: { phase: 'failed', startedAt: failedAt, stoppedAt: failedAt, error: 'rpc error: code = Unknown desc = exit status 4' },
        },
      ],
      scheduledbackups: [],
    });
    const catalogueModule4 = await import('../cnpg-backup-catalogue/service.js');
    const spy = vi.spyOn(catalogueModule4, 'listBackupsFromObjectStore').mockResolvedValue({
      source: 'object-store', objectStoreName: 'os', namespace: 'platform',
      backups: [
        { backupId: '20260522T030001', startedAt: null, endedAt: null, status: 'DONE',
          beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: null, uploadedAt: null, parseError: null },
        { backupId: '20260521T030001', startedAt: null, endedAt: null, status: 'DONE',
          beginWal: null, endWal: null, clusterSizeBytes: null, dataSizeBytes: null, uploadedAt: null, parseError: null },
      ],
      unavailableReason: null,
      queryDurationMs: 75,
    });
    const result = await readBackupHealth({ ...tenants, core: {} as never }, { nowMs: NOW_MS });
    spy.mockRestore();
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('cnpg_operator_blind');
    expect(cluster?.objectStoreBackupCount).toBe(2);
    expect(cluster?.mostRecentFailure?.name).toBe('rt-bk-failed'); // failure context still preserved
  });

  it('cnpg_operator_blind — does NOT trigger when catalogue is empty (stays never_run)', async () => {
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'system-db', namespace: 'platform' },
          spec: {
            plugins: [
              { name: 'barman-cloud.cloudnative-pg.io', enabled: true, parameters: { barmanObjectName: 'os' } },
            ],
          },
        },
      ],
      backups: [],
      scheduledbackups: [],
    });
    const catalogueModule2 = await import('../cnpg-backup-catalogue/service.js');
    const spy = vi.spyOn(catalogueModule2, 'listBackupsFromObjectStore').mockResolvedValue({
      source: 'object-store', objectStoreName: 'os', namespace: 'platform',
      backups: [], unavailableReason: null, queryDurationMs: 10,
    });
    const result = await readBackupHealth({ ...tenants, core: {} as never }, { nowMs: NOW_MS });
    spy.mockRestore();
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('never_run');
    expect(cluster?.objectStoreBackupCount).toBe(0);
  });

  it('catalogue failures must NOT break the primary health response', async () => {
    const tenants = fakeTenant({
      clusters: [
        {
          metadata: { name: 'system-db', namespace: 'platform' },
          spec: {
            plugins: [
              { name: 'barman-cloud.cloudnative-pg.io', enabled: true, parameters: { barmanObjectName: 'os' } },
            ],
          },
        },
      ],
      backups: [],
      scheduledbackups: [],
    });
    const catalogueModule3 = await import('../cnpg-backup-catalogue/service.js');
    const spy = vi.spyOn(catalogueModule3, 'listBackupsFromObjectStore').mockRejectedValue(new Error('catalogue exploded'));
    const result = await readBackupHealth({ ...tenants, core: {} as never }, { nowMs: NOW_MS });
    spy.mockRestore();
    const cluster = result.find((r) => r.clusterName === 'system-db');
    expect(cluster?.state).toBe('never_run'); // fell through to base state, did not crash
    expect(cluster?.objectStoreBackupCount).toBeUndefined();
  });

  it('aggregates multiple clusters within the watched namespace', async () => {
    // Today only platform/system-db is in WATCHED_NAMESPACES. This test
    // pretends a future per-tenant CNPG cluster (system-db-tenant) lands
    // in the same namespace and verifies the aggregator returns BOTH.
    const tenants = fakeTenant({
      clusters: [
        { metadata: { name: 'system-db', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
        { metadata: { name: 'postgres-aux', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'system-db-1', namespace: 'platform' },
          spec: { cluster: { name: 'system-db' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
        {
          metadata: { name: 'postgres-aux-1', namespace: 'platform' },
          spec: { cluster: { name: 'postgres-aux' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:30:00Z' },
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(tenants, { nowMs: NOW_MS });
    expect(result.map((r) => `${r.namespace}/${r.clusterName}`).sort()).toEqual([
      'platform/postgres-aux',
      'platform/system-db',
    ]);
    expect(result.every((r) => r.state === 'healthy')).toBe(true);
  });
});
