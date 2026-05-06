/**
 * Unit tests for cnpg-backup-health service.
 *
 * Tests the pure helpers (phase parsing, record extraction, sort order)
 * + the readBackupHealth aggregator using a fake CustomObjectsApi that
 * returns canned CR lists. No real K8s connection required.
 */
import { describe, it, expect } from 'vitest';

import {
  __test,
  readBackupHealth,
  type BackupRecord,
  type CnpgBackupHealthClients,
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
      name: 'a', namespace: 'mail', clusterName: 'mail-pg',
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
      name: 'a', namespace: 'mail', clusterName: 'mail-pg',
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

  function fakeClient(payloadByPlural: Record<string, unknown[]>): CnpgBackupHealthClients {
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
      } as unknown as CnpgBackupHealthClients['custom'],
    };
  }

  it('healthy state — completed backup < 24h ago', async () => {
    const clients = fakeClient({
      clusters: [
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'mail-pg-daily-1', namespace: 'mail' },
          spec: { cluster: { name: 'mail-pg' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
      ],
      scheduledbackups: [
        { metadata: { name: 'mail-pg-daily', namespace: 'mail' }, spec: { cluster: { name: 'mail-pg' } } },
      ],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    const mail = result.find((r) => r.clusterName === 'mail-pg');
    expect(mail?.state).toBe('healthy');
    expect(mail?.lastSuccessfulBackup?.name).toBe('mail-pg-daily-1');
    expect(mail?.lastSuccessSecondsAgo).toBe(60 * 60); // 1 hour
    expect(mail?.scheduledBackups).toEqual(['mail-pg-daily']);
    expect(mail?.clusterHasBackupSpec).toBe(true);
  });

  it('failing state — last attempt is failed (newer than last success)', async () => {
    const clients = fakeClient({
      clusters: [
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        // Last success 1h ago
        {
          metadata: { name: 'old-success', namespace: 'mail' },
          spec: { cluster: { name: 'mail-pg' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
        // But latest attempt 5min ago FAILED
        {
          metadata: { name: 'fresh-failure', namespace: 'mail' },
          spec: { cluster: { name: 'mail-pg' }, method: 'barmanObjectStore' },
          status: { phase: 'failed', startedAt: '2026-05-06T15:55:00Z', error: 'S3 auth failed' },
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    const mail = result.find((r) => r.clusterName === 'mail-pg');
    expect(mail?.state).toBe('failing');
    expect(mail?.mostRecentFailure?.name).toBe('fresh-failure');
    expect(mail?.mostRecentFailure?.error).toBe('S3 auth failed');
    // last success still recorded so operators can see what's recoverable
    expect(mail?.lastSuccessfulBackup?.name).toBe('old-success');
  });

  it('stale state — completed backup older than 24h', async () => {
    const clients = fakeClient({
      clusters: [
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'old-success', namespace: 'mail' },
          spec: { cluster: { name: 'mail-pg' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-04T15:00:00Z' }, // 49h ago
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    const mail = result.find((r) => r.clusterName === 'mail-pg');
    expect(mail?.state).toBe('stale');
    expect(mail?.lastSuccessSecondsAgo).toBeGreaterThan(24 * 3600);
  });

  it('never_run state — no backups at all', async () => {
    const clients = fakeClient({
      clusters: [
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    const mail = result.find((r) => r.clusterName === 'mail-pg');
    expect(mail?.state).toBe('never_run');
    expect(mail?.lastSuccessfulBackup).toBeNull();
  });

  it('no_backup_config state — cluster has no backup spec', async () => {
    const clients = fakeClient({
      clusters: [
        // No spec.backup — happens transiently during recovery
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: {} },
      ],
      backups: [],
      scheduledbackups: [
        // But ScheduledBackup CRs exist! This is the staging mistake from
        // 2026-05-06 — Backup CR fired against a Cluster without backup
        // config and failed: "cannot proceed with the backup as the
        // cluster has no backup section".
        { metadata: { name: 'mail-pg-daily', namespace: 'mail' }, spec: { cluster: { name: 'mail-pg' } } },
      ],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    const mail = result.find((r) => r.clusterName === 'mail-pg');
    expect(mail?.state).toBe('no_backup_config');
    expect(mail?.clusterHasBackupSpec).toBe(false);
    expect(mail?.scheduledBackups).toEqual(['mail-pg-daily']);
  });

  it('aggregates across both watched namespaces', async () => {
    const clients = fakeClient({
      clusters: [
        { metadata: { name: 'mail-pg', namespace: 'mail' }, spec: { backup: { barmanObjectStore: {} } } },
        { metadata: { name: 'postgres', namespace: 'platform' }, spec: { backup: { barmanObjectStore: {} } } },
      ],
      backups: [
        {
          metadata: { name: 'mail-pg-1', namespace: 'mail' },
          spec: { cluster: { name: 'mail-pg' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:00:00Z' },
        },
        {
          metadata: { name: 'postgres-1', namespace: 'platform' },
          spec: { cluster: { name: 'postgres' }, method: 'barmanObjectStore' },
          status: { phase: 'completed', startedAt: '2026-05-06T15:30:00Z' },
        },
      ],
      scheduledbackups: [],
    });
    const result = await readBackupHealth(clients, { nowMs: NOW_MS });
    expect(result.map((r) => `${r.namespace}/${r.clusterName}`).sort()).toEqual([
      'mail/mail-pg',
      'platform/postgres',
    ]);
    expect(result.every((r) => r.state === 'healthy')).toBe(true);
  });
});
