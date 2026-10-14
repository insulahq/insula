/**
 * Where the reclaim sweep looks for a tenant's snapshots, and which bundles it
 * may declare reclaimed — against a REAL Postgres: both are SQL over the
 * bundle tables, and the tenant's repository-state row is deleted by a
 * cascade no in-memory stand-in performs.
 *
 * The case this exists for: a tenant that has been DELETED. Its bundles
 * outlive it (they are its only way back), then expire — and from then on the
 * sweep has to find their snapshots to forget them. The row that used to say
 * which repository they are in went with the tenant.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupComponents, backupJobs, resticRepoReclaimState, tenantResticRepoState, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { layoutsHoldingSnapshots } from './repo-layout.js';
import { dropSpentReclaimState, stampReclaimedComponents } from './restic-retention.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('which repositories a tenant\'s snapshots are in (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let tenantId = '';
  let seq = 0;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw('TRUNCATE TABLE restic_repo_reclaim_state'));
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id)).id;
  });

  const sha = (n: number): string => String(n).repeat(64).slice(0, 64);
  /** A bundle with one restic component; returns the component's row id and snapshot id. */
  const bundle = async (over: {
    status?: 'completed' | 'partial' | 'failed' | 'expired';
    layout?: 'per-tenant' | 'per-component' | null;
    component?: 'files' | 'mailboxes';
    reclaimed?: boolean;
    snapshot?: string | null;
  } = {}) => {
    seq += 1;
    const id = `bkp-layout-${String(seq).padStart(4, '0')}`;
    const snapshot = over.snapshot === undefined ? sha(seq) : over.snapshot;
    await db().insert(backupJobs).values({
      id, tenantId, initiator: 'system', status: over.status ?? 'completed', targetKind: 's3', targetUri: 's3://example.test/b',
      retentionDays: 7, repoLayout: over.layout === undefined ? 'per-tenant' : over.layout,
      expiresAt: new Date(Date.now() + (over.status === 'expired' ? -1 : 1) * 86_400_000),
    } as typeof backupJobs.$inferInsert);
    const componentId = `bc-layout-${String(seq).padStart(4, '0')}`;
    await db().insert(backupComponents).values({
      id: componentId, backupJobId: id, component: over.component ?? 'files', artifactName: 'files', status: 'completed',
      sha256: snapshot, snapshotReclaimedAt: over.reclaimed ? new Date() : null,
    } as typeof backupComponents.$inferInsert);
    return { id, componentId, snapshot };
  };
  const stateRow = (repoUri: string, component = 'files') => db().insert(tenantResticRepoState)
    .values({ tenantId, component, repoUri } as typeof tenantResticRepoState.$inferInsert);
  /** Delete the tenant the way the platform does: the row goes, and what cascades from it. */
  const deleteTenant = () => db().delete(tenants).where(eq(tenants.id, tenantId));
  const layouts = (component = 'files') => layoutsHoldingSnapshots(db(), tenantId, component);
  const reclaimedIds = async (): Promise<string[]> => (await db().select({ id: backupComponents.id, at: backupComponents.snapshotReclaimedAt }).from(backupComponents))
    .filter((r) => r.at !== null).map((r) => r.id).sort();

  describe('the layouts to sweep', () => {
    it('a live bundle names its layout', async () => {
      await bundle({ layout: 'per-tenant' });
      expect(await layouts()).toEqual(['per-tenant']);
    });

    it('bundles in both layouts: both are swept', async () => {
      await bundle({ layout: 'per-tenant' });
      await bundle({ layout: 'per-component' });
      expect((await layouts()).sort()).toEqual(['per-component', 'per-tenant']);
    });

    it('a bundle written before the layout was recorded is in the historical one', async () => {
      await bundle({ layout: null });
      expect(await layouts()).toEqual(['per-component']);
    });

    it('a DELETED tenant\'s expired bundle still names its layout: its snapshot is yet to be reclaimed, and nothing else says where it is', async () => {
      await bundle({ status: 'expired', layout: 'per-tenant' });
      await stateRow(`s3:http://shim.example.test/tenant/restic/${tenantId}`);
      await deleteTenant();
      // The row that named the repository went with the tenant…
      expect(await db().select().from(tenantResticRepoState).where(eq(tenantResticRepoState.tenantId, tenantId))).toEqual([]);
      // …and the bundle outlived it.
      expect(await layouts()).toEqual(['per-tenant']);
    });

    it.each(['expired', 'failed'] as const)('a live tenant\'s %s bundle counts the same, while its snapshot is unreclaimed', async (status) => {
      await bundle({ status, layout: 'per-tenant' });
      await stateRow(`s3:http://shim.example.test/tenant/restic-files/${tenantId}`);   // names the OTHER layout
      expect(await layouts()).toEqual(['per-tenant']);
    });

    const BOTH = ['per-component', 'per-tenant'];

    it('once its snapshot is reclaimed an expired bundle names nothing any more: its layout no longer counts', async () => {
      await bundle({ status: 'expired', layout: 'per-tenant', reclaimed: true });
      await stateRow(`s3:http://shim.example.test/tenant/restic-files/${tenantId}`);
      expect(await layouts()).toEqual(['per-component']);              // only the state row speaks now
    });

    it('a bundle that recorded no snapshot names nothing', async () => {
      await bundle({ status: 'expired', layout: 'per-tenant', snapshot: null });
      await stateRow(`s3:http://shim.example.test/tenant/restic-files/${tenantId}`);
      expect(await layouts()).toEqual(['per-component']);
    });

    it('another component\'s bundle does not speak for this one', async () => {
      await bundle({ status: 'expired', layout: 'per-tenant', component: 'mailboxes' });
      await stateRow(`s3:http://shim.example.test/tenant/restic-files/${tenantId}`);
      expect(await layouts('files')).toEqual(['per-component']);
      expect(await layouts('mailboxes')).toEqual(['per-tenant']);
    });

    it('with no bundle at all, a live tenant\'s state row is asked', async () => {
      await stateRow(`s3:http://shim.example.test/tenant/restic/${tenantId}`);
      expect(await layouts()).toEqual(['per-tenant']);
    });

    it('…and another component\'s state row is not', async () => {
      await stateRow(`s3:http://shim.example.test/tenant/restic/${tenantId}`, 'mailboxes');
      expect((await layouts('files')).sort()).toEqual(BOTH);
    });

    it('a DELETED tenant whose bundle rows are purged: nothing says where to look, so both layouts are looked into', async () => {
      await bundle({ status: 'expired', layout: 'per-tenant', reclaimed: true });
      await stateRow(`s3:http://shim.example.test/tenant/restic/${tenantId}`);
      await deleteTenant();
      expect((await layouts()).sort()).toEqual(BOTH);
    });
  });

  describe('taking a spent repository out of the sweep', () => {
    const rotation = (over: { component?: string; prunePending?: boolean } = {}) => db().insert(resticRepoReclaimState).values({
      tenantId, component: over.component ?? 'files', prunePending: over.prunePending ?? false, lastSweepAt: new Date(), lastSweepOutcome: 'repo-missing',
    } as typeof resticRepoReclaimState.$inferInsert);
    const inRotation = async (): Promise<string[]> => (await db().select({ c: resticRepoReclaimState.component }).from(resticRepoReclaimState)
      .where(eq(resticRepoReclaimState.tenantId, tenantId))).map((r) => r.c).sort();
    const drop = (component = 'files') => dropSpentReclaimState(db(), tenantId, component);

    it('a tenant that is gone, with no bundle left that names a snapshot: out', async () => {
      await rotation();
      await rotation({ component: 'mailboxes' });
      await deleteTenant();
      expect(await drop()).toBe(true);
      expect(await inRotation()).toEqual(['mailboxes']);               // only the pair that was asked about
    });

    it('a bundle that never recorded a snapshot does not keep it in', async () => {
      await rotation();
      await bundle({ status: 'expired', snapshot: null });
      await deleteTenant();
      expect(await drop()).toBe(true);
    });

    it('a LIVE tenant stays in, whatever it has: its next bundle makes a repository', async () => {
      await rotation();
      expect(await drop()).toBe(false);
      expect(await inRotation()).toEqual(['files']);
    });

    it.each<[string, Parameters<typeof bundle>[0]]>([
      ['an expired bundle whose snapshot is still to be reclaimed', { status: 'expired' }],
      ['an expired bundle whose row is still to be purged', { status: 'expired', reclaimed: true }],
      ['a live bundle', { status: 'completed' }],
    ])('a gone tenant with %s stays in', async (_what, over) => {
      await rotation();
      await bundle(over);
      await deleteTenant();
      expect(await drop()).toBe(false);
      expect(await inRotation()).toEqual(['files']);
    });

    it('a gone tenant that is still owed a prune stays in until the prune has run', async () => {
      await rotation({ prunePending: true });
      await deleteTenant();
      expect(await drop()).toBe(false);
    });

    it('another component\'s bundle does not keep this one in', async () => {
      await rotation();
      await bundle({ status: 'expired', component: 'mailboxes' });
      await deleteTenant();
      expect(await drop('files')).toBe(true);
    });
  });

  describe('declaring a snapshot reclaimed', () => {
    const stamp = (layout: 'per-tenant' | 'per-component', stillPresent: string[]) => stampReclaimedComponents({
      db: db(), tenantId, component: 'files', layout, stillPresent: new Set(stillPresent), at: new Date(),
    });

    it('a snapshot gone from its own repository is stamped', async () => {
      const gone = await bundle({ status: 'expired', layout: 'per-tenant' });
      const there = await bundle({ layout: 'per-tenant' });
      expect(await stamp('per-tenant', [there.snapshot as string])).toBe(1);
      expect(await reclaimedIds()).toEqual([gone.componentId]);
    });

    it('a snapshot that lives in the OTHER repository is not judged by this one\'s contents', async () => {
      const merged = await bundle({ status: 'expired', layout: 'per-tenant' });
      const split = await bundle({ status: 'expired', layout: 'per-component' });
      const unrecorded = await bundle({ status: 'expired', layout: null });
      // The split repository was looked into, and is empty.
      expect(await stamp('per-component', [])).toBe(2);
      expect(await reclaimedIds()).toEqual([split.componentId, unrecorded.componentId].sort());
      // The merged bundle's snapshot was never looked for: it still names its layout.
      expect(await layouts()).toEqual(['per-tenant']);
      expect(await stamp('per-tenant', [merged.snapshot as string])).toBe(0);
    });
  });
});
