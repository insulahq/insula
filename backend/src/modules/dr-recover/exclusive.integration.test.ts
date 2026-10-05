/**
 * One recovery per tenant — proven against real Postgres, because the
 * guarantee IS Postgres: an advisory lock held across reap + check + INSERT,
 * and a staleness cutoff on the database's own clock.
 *
 * A mock cannot show either: concurrency needs real connections racing, and
 * "DB time, not replica time" needs a replica clock that disagrees with it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { restoreItems, restoreJobs, tasks } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import { enrollBatchExclusive, enrollRecoveryExclusive } from './exclusive.js';

const dbAvailable = await isDbAvailable();
const ADMIN = '00000000-0000-4000-8000-0000000000ad';

describe.skipIf(!dbAvailable)('recovery mutual exclusion (integration)', () => {
  const db = () => getTestDb() as unknown as Database;
  let tenantId: string;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE tasks, restore_jobs, restore_items CASCADE'));
    const regionId = (await seedRegion(getTestDb())).id;
    const planId = (await seedPlan(getTestDb())).id;
    tenantId = (await seedTenant(getTestDb(), regionId, planId)).id;
  });
  afterEach(() => vi.useRealTimers());

  const enroll = () => enrollRecoveryExclusive(db(), { tenantId, tenantName: 'Acme', userId: ADMIN });
  const activeRecoveries = async (): Promise<number> => {
    const r = await db().execute(sql`SELECT count(*)::int AS n FROM tasks WHERE kind = 'dr.recover' AND status = 'running'`);
    return (r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
  };

  /** A running dr.recover row whose last report was `ageSeconds` ago, by the DATABASE clock. */
  async function runningRecoverySince(ageSeconds: number, details: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db().execute(sql`
      INSERT INTO tasks (id, kind, scope, user_id, tenant_id, label, status, target, details, started_at, updated_at)
      VALUES (${id}, 'dr.recover', 'admin', ${ADMIN}, ${tenantId}, 'Recover tenant Acme', 'running',
              '{"type":"modal","modal":"dr-recover","modalProps":{}}'::jsonb, ${JSON.stringify(details)}::jsonb,
              NOW() - (${ageSeconds}::int * INTERVAL '1 second'), NOW() - (${ageSeconds}::int * INTERVAL '1 second'))
    `);
    return id;
  }

  async function statusOf(id: string): Promise<string> {
    const r = await db().execute(sql`SELECT status FROM tasks WHERE id = ${id}`);
    return (r as unknown as { rows: Array<{ status: string }> }).rows[0]!.status;
  }

  it('concurrent starts for one tenant: exactly one wins, every other gets 409', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => enroll()));
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(5);
    for (const l of lost) {
      expect(l.reason).toBeInstanceOf(ApiError);
      expect((l.reason as ApiError).status).toBe(409);
      expect((l.reason as ApiError).code).toBe('DR_RECOVER_IN_PROGRESS');
    }
    expect(await activeRecoveries()).toBe(1);
  });

  it('concurrent batch starts: exactly one batch', async () => {
    const start = () => enrollBatchExclusive(db(), {
      scope: 'admin', userId: ADMIN, label: 'Recover 1 tenant' as never,
      target: { type: 'modal', modal: 'dr-recover-all', modalProps: {} },
    });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => start()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost.map((l) => (l.reason as ApiError).code)).toEqual(Array(3).fill('DR_RECOVER_ALL_IN_PROGRESS'));
  });

  it('staleness is judged on the database clock, not this replica\'s', async () => {
    const alive = await runningRecoverySince(60); // reported a minute ago
    // This replica's clock runs an hour FAST. A cutoff computed here would
    // call the live run abandoned and let a second recovery start beside it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await expect(enroll()).rejects.toMatchObject({ code: 'DR_RECOVER_IN_PROGRESS' });
    expect(await statusOf(alive)).toBe('running');
  });

  it('a run silent past the cutoff is failed and the start goes through — even with a slow replica clock', async () => {
    const dead = await runningRecoverySince(10 * 60);
    // An hour SLOW: a cutoff computed here would never see the dead run as stale.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 60 * 60_000);
    const taskId = await enroll();
    expect(taskId).toBeTruthy();
    expect(await statusOf(dead)).toBe('failed');
    const r = await db().execute(sql`SELECT error_message, details->'error'->>'code' AS code FROM tasks WHERE id = ${dead}`);
    const row = (r as unknown as { rows: Array<{ error_message: string; code: string }> }).rows[0]!;
    expect(row.error_message).toMatch(/restarted/);
    expect(row.code).toBe('DR_RECOVER_ABANDONED');
  });

  async function executingCart(): Promise<string> {
    const cartId = `rstr-${randomUUID().slice(0, 8)}`;
    await db().insert(restoreJobs).values({ id: cartId, tenantId, status: 'executing', startedAt: new Date() });
    for (const [seq, status] of [[0, 'done'], [1, 'applying'], [2, 'pending']] as const) {
      await db().insert(restoreItems).values({
        id: randomUUID(), restoreJobId: cartId, bundleId: 'bkp-1', type: 'config-tables',
        selector: { kind: 'all' }, seq, status,
      } as typeof restoreItems.$inferInsert);
    }
    return cartId;
  }

  it('refuses while a restore of the tenant is executing that no ended recovery owns', async () => {
    const cartId = await executingCart();
    await expect(enroll()).rejects.toMatchObject({ code: 'DR_RESTORE_IN_PROGRESS', status: 409 });
    const [cart] = await db().select({ status: restoreJobs.status }).from(restoreJobs).where(sql`${restoreJobs.id} = ${cartId}`);
    expect(cart!.status).toBe('executing');
    expect(await activeRecoveries()).toBe(0);
  });

  it('a restore left executing by a recovery that died is failed; the start is refused once, then goes through', async () => {
    const cartId = await executingCart();
    // Its recovery stopped heartbeating 10 minutes ago, mid-restore.
    const dead = await runningRecoverySince(10 * 60, { cartId });

    await expect(enroll()).rejects.toMatchObject({ code: 'DR_PREVIOUS_RECOVERY_INCOMPLETE', status: 409 });
    expect(await statusOf(dead)).toBe('failed');
    const [cart] = await db().select({ status: restoreJobs.status, lastError: restoreJobs.lastError })
      .from(restoreJobs).where(sql`${restoreJobs.id} = ${cartId}`);
    expect(cart!.status).toBe('failed');
    expect(cart!.lastError).toMatch(/^ABANDONED/);
    const items = await db().select({ status: restoreItems.status }).from(restoreItems)
      .where(sql`${restoreItems.restoreJobId} = ${cartId}`).orderBy(restoreItems.seq);
    expect(items.map((i) => i.status)).toEqual(['done', 'failed', 'pending']);

    // The operator has been told; starting again is a deliberate re-apply.
    expect(await enroll()).toBeTruthy();
    const [mine] = await db().select({ n: sql<number>`count(*)::int` }).from(tasks)
      .where(sql`${tasks.kind} = 'dr.recover' AND ${tasks.status} = 'running'`);
    expect(mine!.n).toBe(1);
  });
});
