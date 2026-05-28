import { describe, it, expect, vi } from 'vitest';
import {
  seedCategoriesIfMissing,
  listCategories,
  getCategory,
  updateCategory,
} from './service.js';
import { ALL_CATEGORIES, legacyCategoryIdForType } from './seed.js';
import { ApiError } from '../../../shared/errors.js';

type Db = Parameters<typeof seedCategoriesIfMissing>[0];

function mockSelect(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockResolvedValue(rows);
  const whereTerm = { orderBy, limit };
  const where = vi.fn().mockReturnValue(whereTerm);
  const from = vi.fn().mockReturnValue({ where, orderBy });
  return vi.fn().mockReturnValue({ from });
}

function mockReturning(returnRows: unknown[]) {
  return vi.fn().mockResolvedValue(returnRows);
}

describe('legacyCategoryIdForType', () => {
  it('maps each legacy type to its legacy category id', () => {
    expect(legacyCategoryIdForType('info')).toBe('legacy.info');
    expect(legacyCategoryIdForType('warning')).toBe('legacy.warning');
    expect(legacyCategoryIdForType('error')).toBe('legacy.error');
    expect(legacyCategoryIdForType('success')).toBe('legacy.success');
  });
});

describe('ALL_CATEGORIES integrity', () => {
  it('contains tenant + admin + legacy categories', () => {
    const ids = new Set(ALL_CATEGORIES.map((c) => c.id));
    expect(ids.has('security.password_reset')).toBe(true);
    expect(ids.has('admin.cert_expiring')).toBe(true);
    expect(ids.has('legacy.info')).toBe(true);
  });
  it('every category has at least one default channel', () => {
    for (const c of ALL_CATEGORIES) {
      expect(c.defaultChannels.length).toBeGreaterThan(0);
    }
  });
  it('no duplicate ids', () => {
    const ids = new Set<string>();
    for (const c of ALL_CATEGORIES) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
  });
  it('mandatory categories use a contractual or legitimate-interest basis', () => {
    for (const c of ALL_CATEGORIES) {
      if (c.isMandatory) expect(c.gdprBasis).not.toBe('consent');
    }
  });
  it('rate-limited categories have both window + max', () => {
    for (const c of ALL_CATEGORIES) {
      const hasW = c.rateLimitWindowS !== undefined;
      const hasM = c.rateLimitMax !== undefined;
      expect(hasW).toBe(hasM);
    }
  });
});

describe('seedCategoriesIfMissing', () => {
  it('inserts every category and counts the new rows', async () => {
    const returning = mockReturning([{ id: 'x' }]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const count = await seedCategoriesIfMissing(db);
    expect(count).toBe(ALL_CATEGORIES.length);
    expect(insert).toHaveBeenCalledTimes(ALL_CATEGORIES.length);
  });
  it('returns 0 when every row already existed (no returning rows)', async () => {
    const returning = mockReturning([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as unknown as Db;

    const count = await seedCategoriesIfMissing(db);
    expect(count).toBe(0);
  });
});

const sampleRow = {
  id: 'security.password_reset',
  displayName: 'Password reset requested',
  description: 'desc',
  audience: 'tenant',
  defaultSeverity: 'warning' as const,
  defaultChannels: ['in_app', 'email'],
  isMandatory: true,
  gdprBasis: 'contract' as const,
  rateLimitWindowS: null,
  rateLimitMax: null,
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
};

describe('listCategories', () => {
  it('returns all categories sorted', async () => {
    const select = mockSelect([sampleRow]);
    const db = { select } as unknown as Db;
    const result = await listCategories(db);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('security.password_reset');
  });
  it('filters by audience when requested', async () => {
    const select = mockSelect([sampleRow, { ...sampleRow, id: 'admin.x', audience: 'admin' }]);
    const db = { select } as unknown as Db;
    const result = await listCategories(db, { audience: 'admin' });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('admin.x');
  });
  it('hides inactive by default', async () => {
    const select = mockSelect([{ ...sampleRow, isActive: false }]);
    const db = { select } as unknown as Db;
    const result = await listCategories(db);
    expect(result.length).toBe(0);
  });
  it('includes inactive when asked', async () => {
    const select = mockSelect([{ ...sampleRow, isActive: false }]);
    const db = { select } as unknown as Db;
    const result = await listCategories(db, { includeInactive: true });
    expect(result.length).toBe(1);
  });
});

describe('getCategory', () => {
  it('returns the category when present', async () => {
    const select = mockSelect([sampleRow]);
    const db = { select } as unknown as Db;
    const c = await getCategory(db, 'security.password_reset');
    expect(c.id).toBe('security.password_reset');
    expect(c.isMandatory).toBe(true);
  });
  it('throws CATEGORY_NOT_FOUND when missing', async () => {
    const select = mockSelect([]);
    const db = { select } as unknown as Db;
    await expect(getCategory(db, 'missing')).rejects.toThrow(ApiError);
    await expect(getCategory(db, 'missing')).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateCategory', () => {
  it('updates the whitelisted fields and writes an audit row', async () => {
    const select = mockSelect([sampleRow]);
    const updateReturning = vi.fn().mockResolvedValue([{ ...sampleRow, defaultSeverity: 'error' }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const db = { select, update, insert } as unknown as Db;

    const result = await updateCategory(
      db,
      'security.password_reset',
      { defaultSeverity: 'error' },
      { actorId: 'actor-1' },
    );

    expect(result.defaultSeverity).toBe('error');
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ defaultSeverity: 'error' }));
    expect(insert).toHaveBeenCalled();
  });

  it('no-ops when patch is empty', async () => {
    const select = mockSelect([sampleRow]);
    const update = vi.fn();
    const db = { select, update } as unknown as Db;
    const r = await updateCategory(db, 'security.password_reset', {}, { actorId: 'a' });
    expect(r.id).toBe('security.password_reset');
    expect(update).not.toHaveBeenCalled();
  });

  it('throws when category missing', async () => {
    const select = mockSelect([]);
    const db = { select } as unknown as Db;
    await expect(
      updateCategory(db, 'missing', { isActive: false }, { actorId: 'a' }),
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_FOUND' });
  });

  it('still returns updated row when audit insert throws', async () => {
    const select = mockSelect([sampleRow]);
    const updateReturning = vi.fn().mockResolvedValue([{ ...sampleRow, isActive: false }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insertValues = vi.fn().mockRejectedValue(new Error('audit table down'));
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const db = { select, update, insert } as unknown as Db;

    const r = await updateCategory(
      db,
      'security.password_reset',
      { isActive: false },
      { actorId: 'a' },
    );
    expect(r.isActive).toBe(false);
  });
});
