/**
 * `adoptChildByRef` — folding a row some OTHER route enrolled under the
 * orchestration that drove it. The guard rails are the WHERE clause: only an
 * orphan is adopted (an existing parent is never replaced) and a row never
 * becomes its own parent. Rendered to SQL so the assertion is on what
 * Postgres would run.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { adoptChildByRef, failStaleActive, hasActiveTask } from './service.js';
import type { Database } from '../../db/index.js';

const dialect = new PgDialect();

function recordingDb(returned: unknown[]) {
  const seen: { set?: Record<string, unknown>; where?: SQL } = {};
  const chain = {
    set: (v: Record<string, unknown>) => { seen.set = v; return chain; },
    where: (w: SQL) => { seen.where = w; return chain; },
    returning: async () => returned,
    from: () => chain,
    limit: async () => returned,
  };
  const db = { update: () => chain, select: () => chain } as unknown as Database;
  return { db, seen };
}

describe('adoptChildByRef', () => {
  it('sets the parent on the orphan (kind, refId) row only', async () => {
    const { db, seen } = recordingDb([{ id: 'child-1' }]);
    expect(await adoptChildByRef(db, 'restore.cart', 'cart-1', 'parent-1')).toBe(true);
    expect(seen.set?.parentTaskId).toBe('parent-1');
    const q = dialect.sqlToQuery(seen.where!);
    expect(q.sql).toContain('"tasks"."kind" = $1');
    expect(q.sql).toContain('"tasks"."ref_id" = $2');
    expect(q.sql).toContain('"tasks"."parent_task_id" IS NULL');
    expect(q.sql).toContain('"tasks"."id" <> $3');
    expect(q.params).toEqual(['restore.cart', 'cart-1', 'parent-1']);
  });

  it('reports false when the row does not exist yet (the caller retries)', async () => {
    const { db } = recordingDb([]);
    expect(await adoptChildByRef(db, 'tenant.provision', 'p-1', 'parent-1')).toBe(false);
  });
});

describe('hasActiveTask', () => {
  it('looks for a queued/running row of the kind, scoped to the tenant when given', async () => {
    const { db, seen } = recordingDb([{ id: 'x' }]);
    expect(await hasActiveTask(db, 'dr.recover', { tenantId: 't-1' })).toBe(true);
    const q = dialect.sqlToQuery(seen.where!);
    expect(q.sql).toContain("IN ('queued','running')");
    expect(q.sql).toContain('"tasks"."tenant_id" = $2');
    expect(q.params).toEqual(['dr.recover', 't-1']);
  });

  it('without a tenant, any active row of the kind counts', async () => {
    const { db, seen } = recordingDb([]);
    expect(await hasActiveTask(db, 'dr.recover-all', {})).toBe(false);
    expect(dialect.sqlToQuery(seen.where!).params).toEqual(['dr.recover-all']);
  });
});

describe('failStaleActive', () => {
  it('fails only active rows of the kind that stopped reporting before the cutoff', async () => {
    const { db, seen } = recordingDb([{ id: 'dead-1' }]);
    const before = Date.now();
    expect(await failStaleActive(db, 'dr.recover', { tenantId: 't-1', staleAfterMs: 180_000, error: 'abandoned' })).toBe(1);
    expect(seen.set).toMatchObject({ status: 'failed', errorMessage: 'abandoned' });
    const q = dialect.sqlToQuery(seen.where!);
    expect(q.sql).toContain("IN ('queued','running')");
    expect(q.sql).toContain('"tasks"."updated_at" < $2');
    expect(q.sql).toContain('"tasks"."tenant_id" = $3');
    const cutoff = new Date(q.params[1] as string).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - 180_000 - 1000);
    expect(cutoff).toBeLessThanOrEqual(Date.now() - 180_000 + 1000);
  });
});
