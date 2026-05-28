import { describe, it, expect, vi } from 'vitest';
import { seedTemplatesIfMissing } from './seed-loader.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';

type Db = Parameters<typeof seedTemplatesIfMissing>[0];

describe('seedTemplatesIfMissing', () => {
  it('inserts every seed template when no active rows exist', async () => {
    // Always return [] for existence check → every template is "missing"
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const db = { select, insert } as unknown as Db;

    const n = await seedTemplatesIfMissing(db);
    expect(n).toBe(ALL_SEED_TEMPLATES.length);
  });

  it('skips seeds for which an active row already exists', async () => {
    // Mark every existence check as "row exists" → insert never runs.
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'existing' }]) }) }),
    });
    const insertValues = vi.fn();
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const db = { select, insert } as unknown as Db;

    const n = await seedTemplatesIfMissing(db);
    expect(n).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
