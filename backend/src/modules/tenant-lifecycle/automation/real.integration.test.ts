/**
 * The automatic archive/delete sweep's own reads and verdicts against a REAL
 * Postgres: which tenants it lists as due, what the card is told about the
 * tenants in line, how it reads the end of an archive, and which refusals it
 * takes for "not now" and which for "broken".
 *
 * The archive and the delete themselves are stand-ins — each has its own
 * tests; what is under test here is what the sweep asks of them and makes of
 * their answers.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { TenantAutomationRun } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { ApiError } from '../../../shared/errors.js';

const archiveTenant = vi.fn();
const deleteTenant = vi.fn();
const notifyAdmins = vi.fn(async () => undefined);
let archiveTarget: Error | null = null;

vi.mock('../../storage-lifecycle/service.js', () => ({ archiveTenant: (...a: unknown[]) => archiveTenant(...a) }));
vi.mock('../../tenants/service.js', () => ({ deleteTenant: (...a: unknown[]) => deleteTenant(...a) }));
vi.mock('../../storage-lifecycle/snapshot-ctx.js', () => ({
  buildArchiveServiceCtx: async () => { if (archiveTarget) throw archiveTarget; return { ctx: 'archive' }; },
}));
vi.mock('../../storage-lifecycle/settings.js', () => ({ loadStorageLifecycleSettings: async () => ({ retentionPreArchiveDays: 75 }) }));
vi.mock('../../notifications/events.js', () => ({ notifyAdminOperationalEvent: (...a: unknown[]) => notifyAdmins(...(a as [])) }));

const { getTenantAutomationStatus, notification, outcomeOfRefusal, realSweepIo } = await import('./real.js');

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('tenant automation: reads and verdicts (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;
  const deps = () => ({ db, k8s: {} as never, config: {} });
  const io = () => realSweepIo(deps(), { archiveWaitMs: 900, archivePollMs: 100 });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=tenant_automation_real_test' });
    await pool.query('DROP SCHEMA IF EXISTS tenant_automation_real_test CASCADE');
    await pool.query('CREATE SCHEMA tenant_automation_real_test');
    await pool.query(`CREATE TABLE platform_settings (setting_key varchar(100) PRIMARY KEY, setting_value text NOT NULL,
      updated_at timestamp NOT NULL DEFAULT now())`);
    // The columns these reads touch, typed as the real table types them.
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, name varchar(255) NOT NULL, status varchar(32) NOT NULL,
      is_system boolean NOT NULL DEFAULT false, storage_lifecycle_state varchar(32) NOT NULL DEFAULT 'idle',
      suspended_at timestamp, archived_at timestamp)`);
    await pool.query(`CREATE TABLE storage_operations (id varchar(36) PRIMARY KEY, state varchar(32) NOT NULL DEFAULT 'quiescing',
      completed_at timestamp, last_error text)`);
    db = drizzle(pool) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS tenant_automation_real_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings, tenants, storage_operations');
    archiveTenant.mockReset(); deleteTenant.mockReset(); notifyAdmins.mockClear();
    archiveTarget = null;
  });

  /** A limit, and tenants placed around it to the second — by the database's own clock arithmetic. */
  const LIMIT = new Date('2026-03-01T00:00:00.000Z');
  const tenant = (id: string, status: string, column: 'suspended_at' | 'archived_at' | null, offsetSeconds: number | null, extra = '') => pool.query(
    `INSERT INTO tenants (id, name, status${column ? `, ${column}` : ''}${extra ? ', is_system, storage_lifecycle_state' : ''})
     VALUES ($1, $2, $3${column ? ', $4::timestamp + make_interval(secs => $5)' : ''}${extra})`,
    column ? [id, `Tenant ${id}`, status, LIMIT.toISOString(), offsetSeconds] : [id, `Tenant ${id}`, status],
  );
  const ids = (list: ReadonlyArray<{ tenantId: string }>): string[] => list.map((t) => t.tenantId);

  describe('who is due', () => {
    it('archive: suspended before the limit, oldest first — not at it, not after it, not without a date, not in another status', async () => {
      await tenant('long', 'suspended', 'suspended_at', -86_400 * 30);
      await tenant('just', 'suspended', 'suspended_at', -1);
      await tenant('at', 'suspended', 'suspended_at', 0);
      await tenant('after', 'suspended', 'suspended_at', 1);
      await tenant('undated', 'suspended', null, null);
      await tenant('active', 'active', 'suspended_at', -86_400 * 30);       // resumed: the stamp may linger
      await tenant('archived', 'archived', 'suspended_at', -86_400 * 30);
      expect(ids(await io().dueForArchive(LIMIT))).toEqual(['long', 'just']);
    });

    it('delete: archived before the limit, oldest first, by the archive date — never by the suspension date', async () => {
      await tenant('long', 'archived', 'archived_at', -86_400 * 30);
      await tenant('just', 'archived', 'archived_at', -1);
      await tenant('at', 'archived', 'archived_at', 0);
      await tenant('undated', 'archived', null, null);
      await tenant('suspended-long-ago', 'archived', 'suspended_at', -86_400 * 400);   // archived, date unknown
      await tenant('still-suspended', 'suspended', 'archived_at', -86_400 * 30);
      expect(ids(await io().dueForDelete(LIMIT))).toEqual(['long', 'just']);
    });

    it('never the SYSTEM tenant, whatever a hand-written row says about it', async () => {
      await tenant('system-s', 'suspended', 'suspended_at', -86_400 * 400, ', true, \'idle\'');
      await tenant('system-a', 'archived', 'archived_at', -86_400 * 400, ', true, \'idle\'');
      await tenant('ordinary', 'suspended', 'suspended_at', -86_400 * 400);
      expect(ids(await io().dueForArchive(LIMIT))).toEqual(['ordinary']);
      expect(await io().dueForDelete(LIMIT)).toEqual([]);
    });
  });

  describe('what the card is told', () => {
    it('lists every suspended and archived tenant with the date its days count from, and what owns it right now', async () => {
      await tenant('s-old', 'suspended', 'suspended_at', -86_400 * 30);
      await tenant('s-new', 'suspended', 'suspended_at', 86_400);
      await tenant('s-none', 'suspended', null, null);
      await tenant('a-busy', 'archived', 'archived_at', -86_400, ', false, \'restoring\'');
      await tenant('sys', 'suspended', 'suspended_at', -86_400, ', true, \'idle\'');
      await tenant('live', 'active', null, null);
      const status = await getTenantAutomationStatus(deps());
      expect(status.suspended.map((c) => [c.tenantId, c.since?.slice(0, 10) ?? null, c.busy])).toEqual([
        ['s-old', '2026-01-30', null], ['s-new', '2026-03-02', null], ['s-none', null, null],
      ]);
      expect(status.archived.map((c) => [c.tenantId, c.busy])).toEqual([['a-busy', 'restoring']]);
      expect(status).toMatchObject({
        settings: { autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90 },
        intervalHours: 6, running: false, lastRun: null, nextRunAt: null, archiveBlockedReason: null, archiveRetentionDays: 75,
      });
    });

    it('says why no archive can be taken, and that a sweep is under way when its run lock is held', async () => {
      archiveTarget = new ApiError('NO_SNAPSHOT_TARGET', 'No backup target is assigned to tenant snapshots', 409);
      await pool.query(`INSERT INTO platform_settings (setting_key, setting_value) VALUES
        ('scheduler-lease:storage-auto-archive-run', json_build_object('holder', 'replica-b', 'until', now() + interval '1 minute')::text)`);
      const status = await getTenantAutomationStatus(deps());
      expect(status.archiveBlockedReason).toBe('No backup target is assigned to tenant snapshots');
      expect(status.running).toBe(true);
      expect(await io().archiveBlockedReason()).toBe('No backup target is assigned to tenant snapshots');
      // A lock whose time has run out is nobody's.
      await pool.query(`UPDATE platform_settings SET setting_value = json_build_object('holder', 'replica-b', 'until', now() - interval '1 second')::text`);
      expect((await getTenantAutomationStatus(deps())).running).toBe(false);
    });
  });

  describe('an archive', () => {
    const due = { tenantId: 't1', name: 'Tenant t1' };
    const opts = { retentionDays: 120, suspendedBefore: LIMIT };
    const started = (state: string, completed: boolean, lastError: string | null = null) => {
      archiveTenant.mockImplementation(async () => {
        await pool.query('INSERT INTO storage_operations (id, state, completed_at, last_error) VALUES ($1, $2, $3, $4)',
          ['op-1', state, completed ? new Date() : null, lastError]);
        return { operationId: 'op-1', snapshotId: 's-1' };
      });
    };

    it('is asked for with the retention and the limit the sweep decided, and counts once its operation has ended well', async () => {
      started('idle', true);
      expect(await io().archive(due, opts)).toEqual({ kind: 'done' });
      expect(archiveTenant).toHaveBeenCalledWith({ ctx: 'archive' }, 't1', { retentionDays: 120, onlyIfSuspendedBefore: LIMIT });
    });

    it('waits for an operation still under way, however the start call returned', async () => {
      started('quiescing', false);
      const pending = io().archive(due, opts);
      await new Promise((resolve) => { setTimeout(resolve, 350); });
      await pool.query(`UPDATE storage_operations SET state = 'idle', completed_at = now()`);
      expect(await pending).toEqual({ kind: 'done' });
    });

    it('an operation that ended failed is a failure, with its reason in words', async () => {
      started('failed', true, JSON.stringify({ code: 'PVC_PENDING', title: 'Volume did not attach', detail: 'the node is out of space' }));
      expect(await io().archive(due, opts)).toEqual({ kind: 'failed', error: 'Volume did not attach: the node is out of space' });
      await pool.query('TRUNCATE storage_operations');
      started('failed', true, 'restic: repository unreachable');
      expect(await io().archive(due, opts)).toEqual({ kind: 'failed', error: 'restic: repository unreachable' });
    });

    it('an operation that never ends is given up on after the wait, as a failure', async () => {
      started('snapshotting', false);
      const outcome = await io().archive(due, opts);
      expect(outcome).toMatchObject({ kind: 'failed' });
      expect((outcome as { error: string }).error).toContain('still running');
    });

    it('an operation gone with its tenant — deleted meanwhile — is a failure, not an endless wait', async () => {
      archiveTenant.mockResolvedValue({ operationId: 'no-such-op', snapshotId: 's' });
      expect(await io().archive(due, opts)).toEqual({ kind: 'failed', error: 'the tenant was deleted while it was being archived' });
    });

    it('with no backup target it is a failure of that tenant, and nothing is started', async () => {
      archiveTarget = new ApiError('NO_SNAPSHOT_TARGET', 'No backup target is assigned to tenant snapshots', 409);
      expect(await io().archive(due, opts)).toEqual({ kind: 'failed', error: 'No backup target is assigned to tenant snapshots' });
      expect(archiveTenant).not.toHaveBeenCalled();
    });
  });

  describe('a delete', () => {
    it('is the tenant delete, held to the limit the sweep decided', async () => {
      deleteTenant.mockResolvedValue({ transitionId: 'x' });
      expect(await io().remove({ tenantId: 't1', name: 'T' }, { archivedBefore: LIMIT })).toEqual({ kind: 'done' });
      expect(deleteTenant).toHaveBeenCalledWith(db, 't1', expect.anything(), { onlyIfArchivedBefore: LIMIT });
    });

    it('a refusal is read as the refusal it is', async () => {
      deleteTenant.mockRejectedValue(new ApiError('NO_LONGER_DUE', 'restored meanwhile', 409));
      expect(await io().remove({ tenantId: 't1', name: 'T' }, { archivedBefore: LIMIT })).toEqual({ kind: 'skipped', reason: 'restored meanwhile' });
    });
  });

  describe('which refusals are "not now"', () => {
    it.each([
      ['NO_LONGER_DUE', undefined], ['TENANT_BUSY', undefined], ['ALREADY_ARCHIVED', undefined], ['TENANT_NOT_FOUND', undefined],
      ['STORAGE_OP_IN_PROGRESS', { currentState: 'restoring' }],
    ])('%s %j: the tenant is left for a later sweep', (code, details) => {
      expect(outcomeOfRefusal(new ApiError(code, 'why', 409, details))).toEqual({ kind: 'skipped', reason: 'why' });
    });

    it('a FAILED storage operation is not "not now": nothing clears it but an operator, so it is reported every sweep', () => {
      const outcome = outcomeOfRefusal(new ApiError('STORAGE_OP_IN_PROGRESS', 'A failed operation is already in progress', 409, { currentState: 'failed' }));
      expect(outcome.kind).toBe('failed');
      expect((outcome as { error: string }).error).toContain('has not been cleared');
    });

    it.each([
      new ApiError('SNAPSHOT_INCOMPLETE', 'partial bundle', 500),
      new ApiError('SYSTEM_TENANT_PROTECTED', 'not the system tenant', 409),
      new Error('socket hang up'),
    ])('anything else is a failure: %s', (err) => {
      expect(outcomeOfRefusal(err)).toEqual({ kind: 'failed', error: err.message });
    });
  });

  describe('what the admins are told', () => {
    const run = (over: Partial<TenantAutomationRun>): TenantAutomationRun => ({
      startedAt: '2026-06-15T12:00:00.000Z', finishedAt: '2026-06-15T12:03:00.000Z', trigger: 'schedule',
      archived: [], deleted: [], failed: [], archiveSkippedReason: null, errors: [], ...over,
    });
    const stuck = { tenantId: 't9', name: 'Stuck', action: 'archive' as const, error: 'has not been cleared' };

    it('each tenant is its own item, and the notification opens the page the sweep is set on', async () => {
      const r = run({ archived: [{ tenantId: 'a', name: 'Alpha' }], deleted: [{ tenantId: 'b', name: 'Beta' }], failed: [stuck] });
      await io().notify(r);
      expect(notifyAdmins).toHaveBeenCalledTimes(1);
      const [, subsystem, payload, , resource] = notifyAdmins.mock.calls[0] as unknown as [unknown, string, { items: string[]; detail: string; severityLabel: string }, string, string];
      expect(subsystem).toBe('platform');
      expect(payload.items).toEqual(['Archived: Alpha', 'Deleted: Beta', 'Could not archive Stuck: has not been cleared']);
      expect(payload.detail).toBe('The automatic sweep archived 1, deleted 1, failed on 1 tenant(s).');
      expect(payload.severityLabel).toBe('needs attention');
      expect(resource).toBe('tenant_lifecycle_automation');
    });

    it('a sweep that changed something is always its own event', () => {
      const first = notification(run({ deleted: [{ tenantId: 'b', name: 'Beta' }] }));
      const second = notification(run({ startedAt: '2026-06-15T18:00:00.000Z', deleted: [{ tenantId: 'c', name: 'Gamma' }] }));
      expect(first.dedupeKey).not.toBe(second.dedupeKey);
      expect(first.payload.severityLabel).toBe('done');
    });

    it('the same thing still wrong six hours later is not said again that day — a new thing wrong is', () => {
      const morning = notification(run({ failed: [stuck] }));
      const noon = notification(run({ startedAt: '2026-06-15T18:00:00.000Z', failed: [stuck] }));
      const nextDay = notification(run({ startedAt: '2026-06-16T00:00:00.000Z', failed: [stuck] }));
      const another = notification(run({ startedAt: '2026-06-15T18:00:00.000Z', failed: [stuck, { ...stuck, tenantId: 't10', name: 'Also stuck' }] }));
      expect(noon.dedupeKey).toBe(morning.dedupeKey);
      expect(nextDay.dedupeKey).not.toBe(morning.dedupeKey);
      expect(another.dedupeKey).not.toBe(morning.dedupeKey);
      const blocked = notification(run({ archiveSkippedReason: 'no target' }));
      expect(blocked.dedupeKey).not.toBe(morning.dedupeKey);
      expect(blocked.payload.detail).toContain('no archive can be taken: no target');
    });
  });
});
