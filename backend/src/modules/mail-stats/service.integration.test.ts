import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { getMailStats } from './service.js';

/**
 * Why this one has to reach a real Postgres.
 *
 * The mailbox summary is built from a raw sql`` fragment comparing an ENUM
 * column against a string literal. TypeScript cannot see inside the template
 * and a mocked database agrees with whatever the fragment says — so the query
 * counted `status = 'suspended'`, a label `mailbox_status` has never had
 * (it has been ('active','disabled') since migration 0000), and
 * GET /admin/mail/stats answered 400 for its entire life.
 *
 * The existing unit test covered `parsePrometheusText` — the pure string
 * parser, the half that could not fail. Only a real server rejects the
 * literal, so only a real server can hold this endpoint honest.
 */

const db = getTestDb();
const dbAvailable = await isDbAvailable();

// A silent skip is how this whole class of bug survives. Vitest exits 0 when
// every test is skipped, so a `describe.skip` on an unreachable database
// reports a GREEN check that executed nothing — the same false confidence
// that let the endpoint stay broken. CI provisions Postgres for this job, so
// there an unreachable DB is a CI fault to fix, never a reason to pass.
if (!dbAvailable && process.env.CI) {
  throw new Error(
    'DATABASE_URL is unreachable and CI is set. This suite exists to run ' +
      'against a real Postgres; skipping it here would report success ' +
      'without executing the query it guards.',
  );
}
const d = dbAvailable ? describe : describe.skip;

const TENANT = 'msx11111-2222-3333-4444-555555555555';
const EDOM = 'msx22222-3333-4444-5555-666666666666';

d('getMailStats against a real Postgres', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it('runs the mailbox summary without the server rejecting a status literal', async () => {
    // The defect surfaced exactly here, as:
    //   invalid input value for enum mailbox_status: "suspended"
    const stats = await getMailStats(db);
    expect(stats.mailboxSummary).toBeDefined();
    expect(typeof stats.mailboxSummary.total).toBe('number');
    expect(typeof stats.mailboxSummary.active).toBe('number');
    expect(typeof stats.mailboxSummary.disabled).toBe('number');
  });

  it('counts each status into its own bucket', async () => {
    // Asserting only that the query RUNS would also pass against a filter
    // that matches nothing, so seed one mailbox per status and watch both
    // buckets move.
    await db.execute(sql`
      INSERT INTO regions (id, code, name, provider, status, created_at)
      VALUES ('region-msx', 'msx', 'MSX', 'hetzner', 'active', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO hosting_plans (id, code, name, cpu_limit, memory_limit, storage_limit,
                                 monthly_price_usd, max_sub_users, status, created_at)
      VALUES ('plan-msx', 'msx', 'MSX', 1, 1, 1, 0, 1, 'active', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO tenants (id, region_id, name, primary_email, status,
                           kubernetes_namespace, plan_id, created_at, updated_at)
      VALUES (${TENANT}, 'region-msx', 'Mail Stats', 'msx@example.test', 'active',
              'ns-msx', 'plan-msx', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO domains (id, tenant_id, domain_name, status, created_at, updated_at)
      VALUES ('msx-domain-0001', ${TENANT}, 'mailstats.example.test', 'active', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO email_domains (id, tenant_id, domain_id, created_at, updated_at)
      VALUES (${EDOM}, ${TENANT}, 'msx-domain-0001', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`DELETE FROM mailboxes WHERE id IN ('msx-a', 'msx-d')`);

    const before = await getMailStats(db);

    for (const [id, status] of [['msx-a', 'active'], ['msx-d', 'disabled']] as const) {
      await db.execute(sql`
        INSERT INTO mailboxes (id, tenant_id, email_domain_id, local_part, full_address,
                               password_hash, quota_mb, used_mb, status, created_at, updated_at)
        VALUES (${id}, ${TENANT}, ${EDOM}, ${id}, ${`${id}@mailstats.example.test`},
                'x', 100, 1, ${status}::mailbox_status, NOW(), NOW())
      `);
    }

    const after = await getMailStats(db);
    expect(after.mailboxSummary.active).toBe(before.mailboxSummary.active + 1);
    expect(after.mailboxSummary.disabled).toBe(before.mailboxSummary.disabled + 1);
    expect(after.mailboxSummary.total).toBe(before.mailboxSummary.total + 2);

    await db.execute(sql`DELETE FROM mailboxes WHERE id IN ('msx-a', 'msx-d')`);
  });
});
