import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listTemplates,
  getTemplate,
  getActiveTemplate,
  updateTemplate,
  restoreSeedTemplate,
  previewTemplate,
} from './service.js';
import { _resetRendererCacheForTests } from './renderer.js';
import { ApiError } from '../../../shared/errors.js';

type Db = Parameters<typeof getTemplate>[0];

const sampleRow = {
  id: 'tpl-1',
  categoryId: 'security.password_changed',
  channel: 'in_app' as const,
  locale: 'en',
  subjectTemplate: 'Hi',
  bodyTemplate: 'Hello {{userName}}',
  bodyFormat: 'plaintext',
  variablesSchema: [{ name: 'userName', type: 'string', required: true }],
  isActive: true,
  isSeed: true,
  version: 1,
  editedByUserId: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

function selectMock(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const orderByThen = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockImplementation(() => ({
    orderBy,
    limit,
    then: (resolve: (v: unknown) => void) => resolve(rows),
  }));
  const from = vi.fn().mockReturnValue({
    where,
    orderBy: orderByThen,
  });
  return { select: vi.fn().mockReturnValue({ from }), where };
}

beforeEach(() => _resetRendererCacheForTests());

describe('getTemplate', () => {
  it('returns the template when present', async () => {
    const { select } = selectMock([sampleRow]);
    const db = { select } as unknown as Db;
    const t = await getTemplate(db, 'tpl-1');
    expect(t.id).toBe('tpl-1');
  });

  it('throws TEMPLATE_NOT_FOUND when missing', async () => {
    const { select } = selectMock([]);
    const db = { select } as unknown as Db;
    await expect(getTemplate(db, 'missing')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      status: 404,
    });
  });
});

describe('listTemplates', () => {
  it('returns templates (active only by default)', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([sampleRow]),
        }),
      }),
    });
    const db = { select } as unknown as Db;
    const list = await listTemplates(db, { categoryId: 'x' });
    expect(list.length).toBe(1);
  });
});

describe('getActiveTemplate', () => {
  it('returns exact-locale match', async () => {
    const { select } = selectMock([sampleRow]);
    const db = { select } as unknown as Db;
    const t = await getActiveTemplate(db, 'security.password_changed', 'in_app', 'en');
    expect(t).not.toBeNull();
  });

  it('falls back to en when requested locale missing', async () => {
    let call = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(call++ === 0 ? [] : [sampleRow]),
          }),
        }),
      }),
    }));
    const db = { select } as unknown as Db;
    const t = await getActiveTemplate(db, 'security.password_changed', 'in_app', 'de');
    expect(t).not.toBeNull();
  });

  it('returns null when neither exact nor en exists', async () => {
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }));
    const db = { select } as unknown as Db;
    const t = await getActiveTemplate(db, 'x', 'in_app', 'fr');
    expect(t).toBeNull();
  });
});

describe('updateTemplate', () => {
  it('archives current row then writes the patch', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([sampleRow]) }),
      }),
    });
    const updateReturning = vi.fn().mockResolvedValue([{
      ...sampleRow,
      bodyTemplate: 'New body {{userName}}',
      version: 2,
      isSeed: false,
    }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const db = { select, update, insert } as unknown as Db;

    const r = await updateTemplate(db, 'tpl-1', { bodyTemplate: 'New body {{userName}}' }, { actorId: 'a-1' });
    expect(r.version).toBe(2);
    expect(r.isSeed).toBe(false);
    expect(insert).toHaveBeenCalledTimes(2); // archive + audit
  });

  it('still succeeds when archive insert fails', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([sampleRow]) }) }),
    });
    const updateReturning = vi.fn().mockResolvedValue([{
      ...sampleRow,
      bodyTemplate: 'New body {{userName}}',
      version: 2,
    }]);
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockRejectedValue(new Error('versions write failed')) });
    const db = { select, update, insert } as unknown as Db;

    const r = await updateTemplate(db, 'tpl-1', { bodyTemplate: 'New body {{userName}}' }, { actorId: 'a-1' });
    expect(r.version).toBe(2);
  });
});

describe('restoreSeedTemplate', () => {
  it('rewrites the live row from seed data when one exists', async () => {
    const liveRow = {
      ...sampleRow,
      categoryId: 'tenant.suspended',
      channel: 'in_app' as const,
      bodyTemplate: 'OPERATOR EDITED',
      isSeed: false,
      version: 4,
    };
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([liveRow]) }) }),
    });
    const updateReturning = vi.fn().mockImplementation(() => Promise.resolve([{
      ...liveRow,
      bodyTemplate: 'restored',
      isSeed: true,
      version: 5,
    }]));
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    const db = { select, update, insert } as unknown as Db;

    const r = await restoreSeedTemplate(db, 'tpl-1', { actorId: 'a-1' });
    expect(r.isSeed).toBe(true);
  });

  it('throws SEED_TEMPLATE_NOT_FOUND when no matching seed exists', async () => {
    const orphan = { ...sampleRow, categoryId: 'unknown.cat' };
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([orphan]) }) }),
    });
    const db = { select } as unknown as Db;
    await expect(restoreSeedTemplate(db, 'tpl-1', { actorId: 'a' })).rejects.toMatchObject({
      code: 'SEED_TEMPLATE_NOT_FOUND',
    });
  });
});

describe('previewTemplate', () => {
  it('renders the template with provided sample variables', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([sampleRow]) }) }),
    });
    const db = { select } as unknown as Db;
    const r = await previewTemplate(db, 'tpl-1', { variables: { userName: 'Alice' } });
    expect(r.body).toBe('Hello Alice');
  });

  it('propagates TEMPLATE_RENDER_ERROR when required var missing', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([sampleRow]) }) }),
    });
    const db = { select } as unknown as Db;
    await expect(previewTemplate(db, 'tpl-1', { variables: {} })).rejects.toThrow(ApiError);
  });
});
