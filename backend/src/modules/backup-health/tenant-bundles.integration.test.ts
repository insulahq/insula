/**
 * Tenant rows of the backup-health roll-up, read from the bundle ledger on a
 * real Postgres — the facts are `backup_jobs` rows written by the bundle
 * orchestrator, and the never-run set is the nightly wave's own predicate.
 *
 * The bug this pins: the roll-up only listed health-labelled Kubernetes Jobs,
 * none of which is a tenant backup, so the Backups dashboard's Tenants card
 * read "0 · no jobs registered" beside hundreds of bundles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { loadTenantBundleHealth } from './tenant-bundles.js';

const dbAvailable = await isDbAvailable();
const NOW = new Date('2026-10-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe.skipIf(!dbAvailable)('backup-health tenant bundle rows (integration)', () => {
  const db = () => getTestDb();
  let regionId = '';
  let planId = '';
  let bundleSeq = 0;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
  });

  const tenant = async (overrides: Record<string, unknown> = {}) =>
    (await seedTenant(db(), regionId, planId, overrides)).id;

  const bundle = async (
    tenantId: string,
    status: 'completed' | 'partial' | 'failed' | 'expired' | 'running',
    startedHoursAgo: number,
    lastError: string | null = null,
  ) => {
    bundleSeq += 1;
    const finished = status === 'running' ? null : hoursAgo(startedHoursAgo - 0.5);
    await db().execute(sql`
      INSERT INTO backup_jobs (id, tenant_id, initiator, status, target_kind, target_uri, retention_days, created_at, finished_at, last_error)
      VALUES (${`bkp-${bundleSeq}`}, ${tenantId}, 'system', ${status}, 's3', 's3://example.test/b', 7,
              ${hoursAgo(startedHoursAgo)}, ${finished}, ${lastError})`);
  };

  const byTenant = async () => new Map((await loadTenantBundleHealth(db())).map((r) => [r.tenantId, r]));

  it('a tenant whose newest bundle completed is a healthy tenant-category row', async () => {
    const t = await tenant({ name: 'Acme' });
    await bundle(t, 'partial', 30, 'old failure');
    await bundle(t, 'completed', 6);

    const row = (await byTenant()).get(t)!;
    expect(row).toMatchObject({
      category: 'tenant', state: 'healthy', displayName: 'Acme', recentRuns: 2, lastFailedReason: 'old failure',
    });
    expect(row.lastSuccessAt?.toISOString()).toBe(hoursAgo(5.5).toISOString());
    expect(row.lastFailedAt?.toISOString()).toBe(hoursAgo(29.5).toISOString());
  });

  it('a newest partial or failed bundle makes the tenant failing, with that bundle\'s error', async () => {
    const partial = await tenant();
    await bundle(partial, 'completed', 30);
    await bundle(partial, 'partial', 6, 'mailboxes: restic exited 1');
    const failed = await tenant();
    await bundle(failed, 'failed', 6, 'target unreachable');

    const rows = await byTenant();
    expect(rows.get(partial)).toMatchObject({ state: 'failing', lastFailedReason: 'mailboxes: restic exited 1' });
    expect(rows.get(failed)).toMatchObject({ state: 'failing', lastSuccessAt: null, lastFailedReason: 'target unreachable' });
  });

  it('in-flight and expired bundles neither count as runs nor decide the state', async () => {
    const t = await tenant();
    await bundle(t, 'completed', 30);
    await bundle(t, 'expired', 200);
    await bundle(t, 'running', 1);
    expect((await byTenant()).get(t)).toMatchObject({ state: 'healthy', recentRuns: 1 });
  });

  it('a tenant the nightly wave covers with no bundle yet is never_run; one it skips is left out', async () => {
    const covered = await tenant();
    const optedOut = await tenant({ includeInScheduledBundlesOverride: false });
    const suspended = await tenant({ status: 'suspended' });

    const rows = await byTenant();
    expect(rows.get(covered)).toMatchObject({ state: 'never_run', recentRuns: 0, lastSuccessAt: null });
    expect(rows.has(optedOut)).toBe(false);
    expect(rows.has(suspended)).toBe(false);
  });

  it('a tenant with bundles is listed even when the wave skips it — its backups still happened', async () => {
    const optedOut = await tenant({ includeInScheduledBundlesOverride: false });
    await bundle(optedOut, 'completed', 3);
    const suspended = await tenant({ status: 'suspended' });
    await bundle(suspended, 'failed', 3);

    const rows = await byTenant();
    expect(rows.get(optedOut)?.state).toBe('healthy');
    expect(rows.get(suspended)?.state).toBe('failing');
  });

  it('archived tenants are gone and are left out, bundles or not', async () => {
    const archived = await tenant({ status: 'archived' });
    await bundle(archived, 'failed', 3);
    expect((await byTenant()).has(archived)).toBe(false);
  });
});
