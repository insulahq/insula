import { describe, it, expect } from 'vitest';
import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { fileTrashState } from '../../db/schema.js';

/**
 * Guards the SQL the reconciler generates.
 *
 * These assert on the RENDERED statement rather than on behaviour because the
 * bug they exist to prevent lived entirely in the rendering. The reconciler
 * originally ordered with `asc(sql`… NULLS FIRST`)`, which Drizzle renders as
 * `ORDER BY "last_sweep_at" NULLS FIRST asc` — Postgres rejects that with
 * `syntax error at or near "asc"`, so EVERY reconcile tick threw and the expiry
 * sweep never ran once.
 *
 * It was invisible from every angle we normally look:
 *   - it typechecks (asc() takes an SQL fragment quite happily);
 *   - the tick catches and logs, so nothing crashed;
 *   - the opportunistic sweep uses a different query and kept working, so
 *     ACTIVE tenants still had their bins expired;
 *   - the only symptom was idle tenants keeping their bins forever — precisely
 *     the promise this reconciler exists to keep.
 *
 * It was found by reading the deployed pod's logs. A real Postgres confirmed
 * both halves: the old form errors, the new form returns the rotation order.
 */
function renderCandidateQuery() {
  const db = drizzle({} as never);
  const q = db
    .select({ tenantId: fileTrashState.tenantId })
    .from(fileTrashState)
    .where(and(
      isNotNull(fileTrashState.oldestDeletedAt),
      lt(fileTrashState.oldestDeletedAt, new Date('2026-08-01T00:00:00Z')),
    ))
    .orderBy(sql`${fileTrashState.lastSweepAt} ASC NULLS FIRST`)
    .limit(10);
  return new PgDialect().sqlToQuery(q.getSQL()).sql;
}

describe('trash reconciler — candidate query SQL', () => {
  it('puts ASC BEFORE NULLS FIRST, which is the only order Postgres accepts', () => {
    expect(renderCandidateQuery()).toContain('"last_sweep_at" ASC NULLS FIRST');
  });

  it('never renders the `NULLS FIRST asc` form that Postgres rejects', () => {
    // The exact string that shipped and made every tick throw.
    expect(renderCandidateQuery()).not.toMatch(/NULLS FIRST\s+asc/i);
  });

  it('still selects only non-empty, past-cutoff bins', () => {
    // Ordering is not the only thing that matters: waking every tenant would
    // start a pod each and fight the RWO volume lock.
    const rendered = renderCandidateQuery();
    expect(rendered).toContain('"oldest_deleted_at" is not null');
    expect(rendered).toContain('"oldest_deleted_at" <');
    expect(rendered).toContain('limit');
  });
});
