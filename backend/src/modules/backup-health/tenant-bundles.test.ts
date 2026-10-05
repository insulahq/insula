/**
 * Tenant bundles in the backup-health roll-up.
 *
 * The bug this pins: the roll-up was built ONLY from Kubernetes Jobs labelled
 * `insula.host/backup-health-watch=true`, and nothing that backs up a tenant
 * carries that label — tenant backups are bundles recorded in `backup_jobs`.
 * So no row was ever `category: 'tenant'`, and the Backups dashboard's Tenants
 * card read "0 · no jobs registered" beside hundreds of bundles.
 */
import { describe, it, expect } from 'vitest';
import { summariseTenantBundles, type TenantBundleLedger } from './tenant-bundles.js';
import { sortSummaries } from './service.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const at = (iso: string) => new Date(iso);

function ledger(overrides: Partial<TenantBundleLedger> = {}): TenantBundleLedger {
  return {
    tenantId: T1,
    tenantName: 'Acme',
    namespace: 'tenant-example-0a1b2c3d',
    runs: 0,
    lastSuccessStartedAt: null,
    lastSuccessAt: null,
    lastFailedStartedAt: null,
    lastFailedAt: null,
    lastFailedReason: null,
    ...overrides,
  };
}

describe('summariseTenantBundles', () => {
  it('one tenant-category row per tenant, keyed so it cannot collide with a CronJob group', () => {
    const [row] = summariseTenantBundles([ledger({
      runs: 3,
      lastSuccessStartedAt: at('2026-10-04T02:00:00Z'),
      lastSuccessAt: at('2026-10-04T02:07:00Z'),
    })]);
    expect(row).toEqual({
      groupKey: `tenant-bundles/${T1}`,
      displayName: 'Acme',
      namespace: 'tenant-example-0a1b2c3d',
      category: 'tenant',
      severity: 'warning',
      tenantId: T1,
      state: 'healthy',
      lastSuccessAt: at('2026-10-04T02:07:00Z'),
      lastFailedAt: null,
      lastFailedReason: null,
      recentRuns: 3,
    });
  });

  it('newest bundle partial or failed → failing, with that bundle\'s time and error', () => {
    const [row] = summariseTenantBundles([ledger({
      runs: 2,
      lastSuccessStartedAt: at('2026-10-03T02:00:00Z'),
      lastSuccessAt: at('2026-10-03T02:05:00Z'),
      lastFailedStartedAt: at('2026-10-04T02:00:00Z'),
      lastFailedAt: at('2026-10-04T02:03:00Z'),
      lastFailedReason: 'mailboxes: restic exited 1',
    })]);
    expect(row.state).toBe('failing');
    expect(row.lastSuccessAt).toEqual(at('2026-10-03T02:05:00Z'));
    expect(row.lastFailedAt).toEqual(at('2026-10-04T02:03:00Z'));
    expect(row.lastFailedReason).toBe('mailboxes: restic exited 1');
  });

  it('a newer completed bundle heals an older failure', () => {
    const [row] = summariseTenantBundles([ledger({
      runs: 2,
      lastSuccessStartedAt: at('2026-10-04T02:00:00Z'),
      lastSuccessAt: at('2026-10-04T02:05:00Z'),
      lastFailedStartedAt: at('2026-10-03T02:00:00Z'),
      lastFailedAt: at('2026-10-03T02:03:00Z'),
      lastFailedReason: 'old failure',
    })]);
    expect(row.state).toBe('healthy');
    // The older failure stays visible, like a Job group's lastFailedAt.
    expect(row.lastFailedAt).toEqual(at('2026-10-03T02:03:00Z'));
  });

  it('newer is judged by when each bundle STARTED, not when it finished', () => {
    // A long bundle that started first and failed last is still the older run.
    const [row] = summariseTenantBundles([ledger({
      runs: 2,
      lastFailedStartedAt: at('2026-10-04T01:00:00Z'),
      lastFailedAt: at('2026-10-04T05:00:00Z'),
      lastSuccessStartedAt: at('2026-10-04T02:00:00Z'),
      lastSuccessAt: at('2026-10-04T02:10:00Z'),
    })]);
    expect(row.state).toBe('healthy');
  });

  it('failed and never succeeded → failing with no last success', () => {
    const [row] = summariseTenantBundles([ledger({
      runs: 1,
      lastFailedStartedAt: at('2026-10-04T02:00:00Z'),
      lastFailedAt: at('2026-10-04T02:01:00Z'),
    })]);
    expect(row.state).toBe('failing');
    expect(row.lastSuccessAt).toBeNull();
  });

  it('no bundle at all → never_run', () => {
    const [row] = summariseTenantBundles([ledger()]);
    expect(row.state).toBe('never_run');
    expect(row.recentRuns).toBe(0);
  });

  it('caps a long error so one tenant cannot bloat the response', () => {
    const [row] = summariseTenantBundles([ledger({
      runs: 1,
      lastFailedStartedAt: at('2026-10-04T02:00:00Z'),
      lastFailedAt: at('2026-10-04T02:01:00Z'),
      lastFailedReason: 'x'.repeat(5000),
    })]);
    expect(row.lastFailedReason).toHaveLength(500);
  });

  it('sorts with the Job rows: failing first, then never run, then healthy by name', () => {
    const rows = sortSummaries(summariseTenantBundles([
      ledger({ tenantId: T1, tenantName: 'Zeta', runs: 1, lastSuccessStartedAt: at('2026-10-04T02:00:00Z'), lastSuccessAt: at('2026-10-04T02:01:00Z') }),
      ledger({ tenantId: T2, tenantName: 'Alpha' }),
      ledger({ tenantId: '33333333-3333-4333-8333-333333333333', tenantName: 'Mid', runs: 1, lastFailedStartedAt: at('2026-10-04T02:00:00Z'), lastFailedAt: at('2026-10-04T02:01:00Z') }),
    ]));
    expect(rows.map((r) => `${r.displayName}:${r.state}`)).toEqual(['Mid:failing', 'Alpha:never_run', 'Zeta:healthy']);
  });
});
