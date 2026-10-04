import { describe, expect, it } from 'vitest';
import { slugFromNamespace, toRecoverable, type RecoverableRow } from './recoverable.js';

const row = (over: Partial<RecoverableRow> = {}): RecoverableRow => ({
  tenant_id: '11111111-2222-4333-8444-555555555555',
  bundle_count: '14',
  newest_at: '2026-10-03T01:36:57.662Z',
  newest_completed_id: 'bkp-79a722d1',
  kept_until: '2026-11-02T17:00:00.000Z',
  keep_forever: false,
  live_name: null,
  deleted_at: '2026-10-03T17:00:17.498Z',
  deleted_name: null,
  deleted_ns: 'tenant-example-0a1b2c3d',
  ...over,
});

describe('slugFromNamespace', () => {
  it('takes the slug out of a tenant namespace', () => {
    expect(slugFromNamespace('tenant-example-0a1b2c3d')).toBe('example');
    expect(slugFromNamespace('tenant-system')).toBe('tenant-system');
    expect(slugFromNamespace(null)).toBeNull();
  });
});

describe('toRecoverable', () => {
  it('names a deleted tenant by the name its delete recorded', () => {
    const r = toRecoverable(row({ deleted_name: 'ACME LEARNING' }));
    expect(r).toEqual({
      tenantId: '11111111-2222-4333-8444-555555555555',
      name: 'ACME LEARNING',
      deleted: true,
      deletedAt: '2026-10-03T17:00:17.498Z',
      bundleCount: 14,
      newestBundleAt: '2026-10-03T01:36:57.662Z',
      newestCompletedBundleId: 'bkp-79a722d1',
      keptUntil: '2026-11-02T17:00:00.000Z',
    });
  });

  it('falls back to the namespace slug for a tenant deleted before the name was recorded', () => {
    expect(toRecoverable(row()).name).toBe('example');
  });

  it('a live tenant is not deleted, and a bundle kept forever has no end date', () => {
    const r = toRecoverable(row({ live_name: 'Acme', deleted_at: null, keep_forever: true }));
    expect(r).toMatchObject({ name: 'Acme', deleted: false, deletedAt: null, keptUntil: null });
  });
});
