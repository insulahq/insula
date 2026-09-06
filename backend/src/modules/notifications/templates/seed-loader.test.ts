import { describe, it, expect, vi } from 'vitest';
import { seedTemplatesIfMissing } from './seed-loader.js';
import { ALL_SEED_TEMPLATES } from './seed-data.js';

type Db = Parameters<typeof seedTemplatesIfMissing>[0];

/** A stored row that matches the shipped seed exactly. */
function pristineRowFor(i = 0) {
  const t = ALL_SEED_TEMPLATES[i];
  return {
    id: `row-${i}`,
    subjectTemplate: t.subjectTemplate,
    bodyTemplate: t.bodyTemplate,
    bodyFormat: t.bodyFormat,
    variablesSchema: t.variablesSchema,
    isSeed: true,
    editedByUserId: null,
    version: 1,
  };
}

function makeDb(row: unknown | null) {
  const select = vi.fn().mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
  });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values: insertValues });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });
  return {
    db: { select, insert, update } as unknown as Db,
    insertValues,
    update,
    updateSet,
  };
}

describe('seedTemplatesIfMissing', () => {
  it('inserts every seed template when no active rows exist', async () => {
    const { db, insertValues } = makeDb(null);
    const r = await seedTemplatesIfMissing(db);
    expect(r.inserted).toBe(ALL_SEED_TEMPLATES.length);
    expect(r.refreshed).toBe(0);
    expect(insertValues).toHaveBeenCalledTimes(ALL_SEED_TEMPLATES.length);
  });

  it('does nothing when the stored row already matches the shipped seed', async () => {
    // Every lookup returns row 0's content; only the first template matches it,
    // so this asserts the no-op path specifically rather than in aggregate.
    const { db, insertValues, update } = makeDb(pristineRowFor(0));
    const r = await seedTemplatesIfMissing(db);
    expect(insertValues).not.toHaveBeenCalled();
    expect(r.inserted).toBe(0);
    // Row 0 matches → not refreshed. The rest differ → refreshed.
    expect(r.refreshed).toBe(ALL_SEED_TEMPLATES.length - 1);
    expect(update).toHaveBeenCalledTimes(ALL_SEED_TEMPLATES.length - 1);
  });

  it('REFRESHES a pristine stock row whose shipped text has changed', async () => {
    // The DEV 2026-09-06 case: the build shipped `{{subject}}` in the SLO
    // templates and the database still held the old subject line, because the
    // loader was insert-only. The code changed and the behaviour did not.
    const stale = { ...pristineRowFor(0), subjectTemplate: '[OLD] {{ruleName}}', bodyTemplate: 'old body' };
    const { db, updateSet } = makeDb(stale);
    const r = await seedTemplatesIfMissing(db);
    expect(r.refreshed).toBe(ALL_SEED_TEMPLATES.length);
    expect(r.operatorOwned).toBe(0);
    const applied = updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(applied.subjectTemplate).toBe(ALL_SEED_TEMPLATES[0].subjectTemplate);
    expect(applied.bodyTemplate).toBe(ALL_SEED_TEMPLATES[0].bodyTemplate);
    // Bumped so the renderer's `${id}::${version}` LRU cannot serve the old body.
    expect(applied.version).toBe(2);
  });

  it('NEVER touches a row an operator has edited', async () => {
    const owned = { ...pristineRowFor(0), subjectTemplate: 'operator wording', editedByUserId: 'user-1' };
    const { db, update, insertValues } = makeDb(owned);
    const r = await seedTemplatesIfMissing(db);
    expect(update).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(0);
    expect(r.operatorOwned).toBe(ALL_SEED_TEMPLATES.length);
  });

  it('NEVER touches a row that is not a seed row', async () => {
    const custom = { ...pristineRowFor(0), bodyTemplate: 'hand-written', isSeed: false };
    const { db, update } = makeDb(custom);
    const r = await seedTemplatesIfMissing(db);
    expect(update).not.toHaveBeenCalled();
    expect(r.operatorOwned).toBe(ALL_SEED_TEMPLATES.length);
  });

  it('treats a reordered variablesSchema as unchanged', async () => {
    // Otherwise every boot would rewrite every row and bump versions forever.
    const t = ALL_SEED_TEMPLATES[0];
    const reordered = {
      ...pristineRowFor(0),
      variablesSchema: [...(t.variablesSchema ?? [])].reverse(),
    };
    const { db, update } = makeDb(reordered);
    const r = await seedTemplatesIfMissing(db);
    // Row 0 must NOT be refreshed on ordering alone.
    expect(r.refreshed).toBe(ALL_SEED_TEMPLATES.length - 1);
    expect(update).toHaveBeenCalledTimes(ALL_SEED_TEMPLATES.length - 1);
  });
});
