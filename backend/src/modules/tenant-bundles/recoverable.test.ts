import { describe, expect, it } from 'vitest';
import { slugFromNamespace, toRecoverable, type RecoverableRow } from './recoverable.js';

const row = (over: Partial<RecoverableRow> = {}): RecoverableRow => ({
  tenant_id: '1c25c626-5a77-4009-929e-682bc37244c8',
  bundle_count: '14',
  newest_at: '2026-10-03T01:36:57.662Z',
  newest_completed_id: 'bkp-79a722d1',
  kept_until: '2026-11-02T17:00:00.000Z',
  keep_forever: false,
  live_name: null,
  deleted_at: '2026-10-03T17:00:17.498Z',
  deleted_name: null,
  deleted_ns: 'tenant-moodle-elearning-362f3d17',
  ...over,
});

describe('slugFromNamespace', () => {
  it('takes the slug out of a tenant namespace', () => {
    expect(slugFromNamespace('tenant-moodle-elearning-362f3d17')).toBe('moodle-elearning');
    expect(slugFromNamespace('tenant-system')).toBe('tenant-system');
    expect(slugFromNamespace(null)).toBeNull();
  });
});

describe('toRecoverable', () => {
  it('names a deleted tenant by the name its delete recorded', () => {
    const r = toRecoverable(row({ deleted_name: 'MOODLE ELEARNING' }));
    expect(r).toEqual({
      tenantId: '1c25c626-5a77-4009-929e-682bc37244c8',
      name: 'MOODLE ELEARNING',
      deleted: true,
      deletedAt: '2026-10-03T17:00:17.498Z',
      bundleCount: 14,
      newestBundleAt: '2026-10-03T01:36:57.662Z',
      newestCompletedBundleId: 'bkp-79a722d1',
      keptUntil: '2026-11-02T17:00:00.000Z',
    });
  });

  it('falls back to the namespace slug for a tenant deleted before the name was recorded', () => {
    expect(toRecoverable(row()).name).toBe('moodle-elearning');
  });

  it('a live tenant is not deleted, and a bundle kept forever has no end date', () => {
    const r = toRecoverable(row({ live_name: 'Acme', deleted_at: null, keep_forever: true }));
    expect(r).toMatchObject({ name: 'Acme', deleted: false, deletedAt: null, keptUntil: null });
  });
});
