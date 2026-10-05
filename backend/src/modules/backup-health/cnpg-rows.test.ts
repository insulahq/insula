import { describe, it, expect, vi } from 'vitest';
import type { ClusterBackupHealth } from '../cnpg-backup-health/service.js';

const readBackupHealth = vi.fn();
vi.mock('../cnpg-backup-health/service.js', () => ({ readBackupHealth: (...a: unknown[]) => readBackupHealth(...a) }));

const { cnpgHealthRows, loadCnpgHealthRows } = await import('./cnpg-rows.js');

const rec = (at: string, error: string | null = null) => ({
  name: 'b', namespace: 'platform', clusterName: 'system-db', method: 'plugin', phase: error ? 'failed' : 'completed',
  startedAt: at, stoppedAt: at, error,
}) as ClusterBackupHealth['lastSuccessfulBackup'];

const cluster = (over: Partial<ClusterBackupHealth>): ClusterBackupHealth => ({
  clusterName: 'system-db', namespace: 'platform', state: 'healthy',
  lastSuccessfulBackup: rec('2026-01-02T03:00:00Z'), mostRecentFailure: null,
  lastSuccessSecondsAgo: 3600, scheduledBackups: ['daily'], clusterHasBackupSpec: true,
  ...over,
} as ClusterBackupHealth);

describe('cnpgHealthRows — the platform database on the System card', () => {
  it('a healthy cluster is a healthy System (dr) row with its last success', () => {
    const [r] = cnpgHealthRows([cluster({})]);
    expect(r).toMatchObject({ category: 'dr', state: 'healthy', displayName: 'Platform database (system-db)', groupKey: 'cnpg:platform/system-db' });
    expect(r.lastSuccessAt?.toISOString()).toBe('2026-01-02T03:00:00.000Z');
  });

  it.each([
    ['failing', { mostRecentFailure: rec('2026-01-03T03:00:00Z', 'barman: upload refused') }, 'failing', 'critical', /upload refused/],
    ['stale', { lastSuccessSecondsAgo: 3 * 86400 }, 'failing', 'warning', /72 h/],
    ['cnpg_operator_blind', {}, 'failing', 'warning', /plugin is not working/],
    ['no_backup_config', { lastSuccessfulBackup: null }, 'never_run', 'warning', /no backup target/],
    ['never_run', { lastSuccessfulBackup: null }, 'never_run', 'warning', null],
  ] as const)('%s → %s / %s', (state, over, expState, sev, reason) => {
    const [r] = cnpgHealthRows([cluster({ state, ...over } as Partial<ClusterBackupHealth>)]);
    expect(r.state).toBe(expState);
    expect(r.severity).toBe(sev);
    if (reason) expect(r.lastFailedReason).toMatch(reason); else expect(r.lastFailedReason).toBeNull();
  });

  it('an unreadable CNPG status shows as a failing System row, never as nothing', async () => {
    readBackupHealth.mockRejectedValueOnce(new Error('cnpg CRD missing'));
    const rows = await loadCnpgHealthRows({ custom: {} as never });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'dr', state: 'failing' });
    expect(rows[0].lastFailedReason).toMatch(/cnpg CRD missing/);
  });
});
