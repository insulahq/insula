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
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { tenantAutomationPlan, type TenantAutomationRun } from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { ApiError } from '../../../shared/errors.js';

const archiveTenant = vi.fn();
const deleteTenant = vi.fn();
const notifyAdmins = vi.fn(async () => undefined);
/** What the notification dispatcher is asked to send, and what it answers. */
const emitted: Array<Record<string, unknown>> = [];
let deliveries: Array<{ userId: string | null; channel: string; status: string; error?: string }> = [];
let emitFails: Error | null = null;
let archiveTarget: Error | null = null;

vi.mock('../../storage-lifecycle/service.js', () => ({ archiveTenant: (...a: unknown[]) => archiveTenant(...a) }));
vi.mock('../../tenants/service.js', () => ({ deleteTenant: (...a: unknown[]) => deleteTenant(...a) }));
vi.mock('../../storage-lifecycle/snapshot-ctx.js', () => ({
  buildArchiveServiceCtx: async () => { if (archiveTarget) throw archiveTarget; return { ctx: 'archive' }; },
}));
vi.mock('../../storage-lifecycle/settings.js', () => ({ loadStorageLifecycleSettings: async () => ({ retentionPreArchiveDays: 75 }) }));
// The tenant's notice goes out through the real emitter; only the admins' one is a stand-in.
vi.mock('../../notifications/events.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyAdminOperationalEvent: (...a: unknown[]) => notifyAdmins(...(a as [])),
}));
vi.mock('../../notifications/dispatcher/dispatch.js', () => ({
  emitEvent: async (_db: unknown, opts: Record<string, unknown>) => {
    if (emitFails) throw emitFails;
    emitted.push(opts);
    return { eventId: 'e-1', deliveryCount: 0, perChannelStatuses: deliveries };
  },
}));

const { getTenantAutomationStatus, notification, outcomeOfRefusal, realSweepIo, setTenantAutomationExempt } = await import('./real.js');

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
      suspended_at timestamp, archived_at timestamp, updated_at timestamp NOT NULL DEFAULT now(),
      primary_email varchar(255) NOT NULL DEFAULT 'owner@acme.example.test', secondary_email varchar(255))`);
    await pool.query(`CREATE TABLE storage_operations (id varchar(36) PRIMARY KEY, state varchar(32) NOT NULL DEFAULT 'quiescing',
      completed_at timestamp, last_error text)`);
    // The exemption column and the notices table come from the migration that
    // ships them — run as it is, and twice: it has to be safe to run again.
    const migration = readFileSync(new URL('../../../db/migrations/0157_tenant_automation_notices.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query(migration);
    db = drizzle(pool) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS tenant_automation_real_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings, tenants, storage_operations, tenant_automation_notices');
    archiveTenant.mockReset(); deleteTenant.mockReset(); notifyAdmins.mockClear();
    archiveTarget = null;
    emitted.length = 0; emitFails = null;
    deliveries = [{ userId: 'u-1', channel: 'email', status: 'queued' }, { userId: 'u-1', channel: 'in_app', status: 'sent' }];
  });

  /** A limit, and tenants placed around it to the second — by the database's own clock arithmetic. */
  const LIMIT = new Date('2026-03-01T00:00:00.000Z');
  const tenant = (id: string, status: string, column: 'suspended_at' | 'archived_at' | null, offsetSeconds: number | null, extra = '') => pool.query(
    `INSERT INTO tenants (id, name, status${column ? `, ${column}` : ''}${extra ? ', is_system, storage_lifecycle_state' : ''})
     VALUES ($1, $2, $3${column ? ', $4::timestamp + make_interval(secs => $5)' : ''}${extra})`,
    column ? [id, `Tenant ${id}`, status, LIMIT.toISOString(), offsetSeconds] : [id, `Tenant ${id}`, status],
  );
  const ids = (list: ReadonlyArray<{ tenantId: string }>): string[] => list.map((t) => t.tenantId);

  /** A notice row, placed relative to the limit like the tenants. */
  const notice = (id: string, step: 'archive' | 'delete', toldOffsetSeconds: number, dateOffsetSeconds: number, reached = 1) => pool.query(
    `INSERT INTO tenant_automation_notices (tenant_id, step, told_at, announced_for, reached)
     VALUES ($1, $2, $3::timestamptz + make_interval(secs => $4), $3::timestamptz + make_interval(secs => $5), $6)`,
    [id, step, LIMIT.toISOString(), toldOffsetSeconds, dateOffsetSeconds, reached],
  );
  const keepOut = (id: string) => pool.query('UPDATE tenants SET lifecycle_automation_exempt = true WHERE id = $1', [id]);
  /** Who the plan makes due at the moment a limit of `days` puts its line at LIMIT. */
  const dueAmong = (list: ReadonlyArray<{ tenantId: string; since: Date | null; notice: unknown }>, days = 30): string[] => {
    const now = LIMIT.getTime() + days * 86_400_000;
    return list.filter((t) => tenantAutomationPlan(t as never, days, 0, now).kind === 'due').map((t) => t.tenantId);
  };

  describe('who is in line', () => {
    it('archive: every suspended tenant with its suspension date, oldest first, the undated last — and no tenant in another status', async () => {
      await tenant('long', 'suspended', 'suspended_at', -86_400 * 30);
      await tenant('just', 'suspended', 'suspended_at', -1);
      await tenant('at', 'suspended', 'suspended_at', 0);
      await tenant('after', 'suspended', 'suspended_at', 1);
      await tenant('undated', 'suspended', null, null);
      await tenant('active', 'active', 'suspended_at', -86_400 * 30);       // resumed: the stamp may linger
      await tenant('archived', 'archived', 'suspended_at', -86_400 * 30);
      const line = await io().inLine('archive');
      expect(ids(line)).toEqual(['long', 'just', 'at', 'after', 'undated']);
      expect(line.map((t) => t.since?.toISOString() ?? null)).toEqual([
        '2026-01-30T00:00:00.000Z', '2026-02-28T23:59:59.000Z', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:01.000Z', null,
      ]);
      // Past the limit: before it — not at it, not after it, not without a date.
      expect(dueAmong(line)).toEqual(['long', 'just']);
    });

    it('delete: every archived tenant by its archive date — never by its suspension date', async () => {
      await tenant('long', 'archived', 'archived_at', -86_400 * 30);
      await tenant('just', 'archived', 'archived_at', -1);
      await tenant('at', 'archived', 'archived_at', 0);
      await tenant('undated', 'archived', null, null);
      await tenant('suspended-long-ago', 'archived', 'suspended_at', -86_400 * 400);   // archived, date unknown
      await tenant('still-suspended', 'suspended', 'archived_at', -86_400 * 30);
      const line = await io().inLine('delete');
      expect(ids(line).slice(0, 3)).toEqual(['long', 'just', 'at']);
      expect(ids(line).slice(3).sort()).toEqual(['suspended-long-ago', 'undated']);
      expect(dueAmong(line)).toEqual(['long', 'just']);
    });

    it('never the SYSTEM tenant, whatever a hand-written row says about it', async () => {
      await tenant('system-s', 'suspended', 'suspended_at', -86_400 * 400, ', true, \'idle\'');
      await tenant('system-a', 'archived', 'archived_at', -86_400 * 400, ', true, \'idle\'');
      await tenant('ordinary', 'suspended', 'suspended_at', -86_400 * 400);
      expect(ids(await io().inLine('archive'))).toEqual(['ordinary']);
      expect(await io().inLine('delete')).toEqual([]);
    });

    it('never a tenant an admin keeps out — in either step', async () => {
      await tenant('kept-s', 'suspended', 'suspended_at', -86_400 * 400);
      await tenant('kept-a', 'archived', 'archived_at', -86_400 * 400);
      await tenant('plain-s', 'suspended', 'suspended_at', -86_400 * 400);
      await tenant('plain-a', 'archived', 'archived_at', -86_400 * 400);
      await keepOut('kept-s');
      await keepOut('kept-a');
      expect(ids(await io().inLine('archive'))).toEqual(['plain-s']);
      expect(ids(await io().inLine('delete'))).toEqual(['plain-a']);
    });

    it('carries what each tenant was told for THAT step, and nothing told for the other', async () => {
      await tenant('told', 'suspended', 'suspended_at', -86_400 * 40);
      await tenant('other-step', 'suspended', 'suspended_at', -86_400 * 40);
      await tenant('untold', 'suspended', 'suspended_at', -86_400 * 40);
      await notice('told', 'archive', -86_400 * 5, 86_400 * 2);
      await notice('other-step', 'delete', -86_400 * 5, 86_400 * 2);
      const line = await io().inLine('archive');
      expect(line.map((t) => [t.tenantId, t.notice ? [t.notice.toldAt.toISOString(), t.notice.date.toISOString()] : null])).toEqual([
        ['other-step', null],
        ['told', ['2026-02-24T00:00:00.000Z', '2026-03-03T00:00:00.000Z']],
        ['untold', null],
      ]);
    });
  });

  describe('telling a tenant', () => {
    const DATE = new Date('2026-03-08T12:00:00.000Z');
    const inLineOne = async (id: string, step: 'archive' | 'delete' = 'archive') => {
      const t = (await io().inLine(step)).find((x) => x.tenantId === id);
      if (!t) throw new Error(`${id} is not in line`);
      return t;
    };
    const noticeRows = async () => (await pool.query(
      'SELECT tenant_id, step, announced_for, reached FROM tenant_automation_notices ORDER BY tenant_id, step',
    )).rows.map((r: { tenant_id: string; step: string; announced_for: Date; reached: number }) => [r.tenant_id, r.step, r.announced_for.toISOString(), r.reached]);

    it('sends the tenant its date under the archive category and writes down that it was told', async () => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      expect(await io().tell('archive', await inLineOne('t1'), DATE)).toEqual({ kind: 'told', reached: true });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        categoryId: 'tenant.archive_scheduled',
        scope: { kind: 'tenant', tenantId: 't1' },
        tenantId: 't1',
        variables: { dueDate: '2026-03-08' },
        // The account's contact address too: it reaches a tenant with no user.
        externalRecipients: ['owner@acme.example.test'],
      });
      expect(await noticeRows()).toEqual([['t1', 'archive', '2026-03-08T12:00:00.000Z', 2]]);
      // The next sweep reads it as told.
      expect((await inLineOne('t1')).notice?.date.toISOString()).toBe('2026-03-08T12:00:00.000Z');
    });

    it('writes to both of the account\'s contact addresses when it has two, and to none that is not an address', async () => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      await pool.query(`UPDATE tenants SET secondary_email = 'billing@acme.example.test' WHERE id = 't1'`);
      await io().tell('archive', await inLineOne('t1'), DATE);
      expect(emitted[0].externalRecipients).toEqual(['owner@acme.example.test', 'billing@acme.example.test']);
      await pool.query(`UPDATE tenants SET primary_email = 'none', secondary_email = '' WHERE id = 't1'`);
      await io().tell('archive', await inLineOne('t1'), DATE);
      expect(emitted[1].externalRecipients).toEqual([]);
    });

    it('uses the delete category for the delete step, and keeps the two steps\' notices apart', async () => {
      await tenant('t1', 'archived', 'archived_at', -86_400 * 100);
      await notice('t1', 'archive', -86_400 * 200, -86_400 * 190);
      await io().tell('delete', await inLineOne('t1', 'delete'), DATE);
      expect(emitted[0]).toMatchObject({ categoryId: 'tenant.deletion_scheduled' });
      expect((await noticeRows()).map((r) => r[1])).toEqual(['archive', 'delete']);
    });

    it('telling again replaces the earlier notice of that step', async () => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      await notice('t1', 'archive', -86_400 * 300, -86_400 * 293);        // from an earlier suspension
      await io().tell('archive', await inLineOne('t1'), DATE);
      expect(await noticeRows()).toEqual([['t1', 'archive', '2026-03-08T12:00:00.000Z', 2]]);
    });

    it('gives the message a key of its own per suspension and date, so a repeat is not sent twice and a new suspension is', async () => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      await io().tell('archive', await inLineOne('t1'), DATE);
      await io().tell('archive', await inLineOne('t1'), DATE);
      await pool.query(`UPDATE tenants SET suspended_at = suspended_at + interval '10 days' WHERE id = 't1'`);
      await io().tell('archive', await inLineOne('t1'), DATE);
      await io().tell('archive', await inLineOne('t1'), new Date('2026-03-09T12:00:00.000Z'));
      const keys = emitted.map((e) => e.dedupeKey as string);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
      expect(keys[3]).not.toBe(keys[2]);
      expect(new Set(keys.map((k) => k.length <= 200)).has(false)).toBe(false);
    });

    it.each<[string, Array<{ userId: string | null; channel: string; status: string; error?: string }>, boolean]>([
      ['nobody to send it to', [], false],
      ['only the operators\' broadcast channel took it', [{ userId: null, channel: 'ntfy', status: 'sent' }], false],
      ['every copy was muted or skipped', [{ userId: 'u', channel: 'email', status: 'muted' }, { userId: 'u', channel: 'in_app', status: 'skipped', error: 'no template' }], false],
      ['a copy failed outright', [{ userId: 'u', channel: 'email', status: 'failed' }], false],
      ['one copy is queued', [{ userId: 'u', channel: 'email', status: 'queued' }], true],
      ['only the contact address took it — the tenant has no user', [{ userId: null, channel: 'email', status: 'queued' }], true],
      ['the tenant had this very message already', [{ userId: 'u', channel: 'email', status: 'skipped', error: 'duplicate' }], true],
    ])('when %s, the notice is written all the same and says whether it reached anybody', async (_what, statuses, reached) => {
      deliveries = statuses;
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      expect(await io().tell('archive', await inLineOne('t1'), DATE)).toEqual({ kind: 'told', reached });
      expect((await getTenantAutomationStatus(deps())).suspended[0].notice).toMatchObject({ date: '2026-03-08T12:00:00.000Z', reached });
      // What the next sweep reads: a notice that reached nobody is no notice.
      expect((await inLineOne('t1')).notice?.reached).toBe(reached);
      const whenTheDateHasCome = DATE.getTime() + 86_400_000;
      expect(tenantAutomationPlan(await inLineOne('t1'), 30, 7, whenTheDateHasCome).kind).toBe(reached ? 'due' : 'tell');
    });

    it('writes nothing down when the message could not be sent: the tenant is told by the next sweep, never archived untold', async () => {
      emitFails = new Error('the mail queue is down');
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      await expect(io().tell('archive', await inLineOne('t1'), DATE)).rejects.toThrow('the mail queue is down');
      expect(await noticeRows()).toEqual([]);
    });

    it.each<[string, string, string]>([
      ['resumed', `UPDATE tenants SET status = 'active' WHERE id = 't1'`, 'no longer suspended'],
      ['resumed and suspended again', `UPDATE tenants SET suspended_at = suspended_at + interval '1 second' WHERE id = 't1'`, 'no longer suspended as it was'],
      ['kept out', `UPDATE tenants SET lifecycle_automation_exempt = true WHERE id = 't1'`, 'kept out'],
      ['deleted', `DELETE FROM tenants WHERE id = 't1'`, 'gone'],
    ])('a tenant %s since the sweep read its list is not told', async (_what, change, why) => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      const listed = await inLineOne('t1');
      await pool.query(change);
      const outcome = await io().tell('archive', listed, DATE);
      expect(outcome.kind).toBe('skipped');
      expect((outcome as { reason: string }).reason).toContain(why);
      expect(emitted).toEqual([]);
      expect(await noticeRows()).toEqual([]);
    });

    it('a deleted tenant takes its notices with it', async () => {
      await tenant('t1', 'suspended', 'suspended_at', -86_400 * 40);
      await io().tell('archive', await inLineOne('t1'), DATE);
      await pool.query(`DELETE FROM tenants WHERE id = 't1'`);
      expect(await noticeRows()).toEqual([]);
    });
  });

  describe('keeping a tenant out', () => {
    it('sets and clears the flag, answers the tenant as stored, and lists it on the card whatever its status', async () => {
      await tenant('live', 'active', null, null);
      await tenant('susp', 'suspended', 'suspended_at', -86_400 * 40);
      expect(await setTenantAutomationExempt(db, 'live', true)).toEqual({ tenantId: 'live', name: 'Tenant live', status: 'active', exempt: true });
      await setTenantAutomationExempt(db, 'susp', true);
      const status = await getTenantAutomationStatus(deps());
      expect(status.kept).toEqual([
        { tenantId: 'live', name: 'Tenant live', status: 'active' },
        { tenantId: 'susp', name: 'Tenant susp', status: 'suspended' },
      ]);
      expect(status.suspended).toEqual([]);           // kept out: not in line
      expect(await setTenantAutomationExempt(db, 'susp', false)).toMatchObject({ exempt: false });
      const after = await getTenantAutomationStatus(deps());
      expect(after.kept.map((k) => k.tenantId)).toEqual(['live']);
      expect(after.suspended.map((c) => c.tenantId)).toEqual(['susp']);
    });

    it('answers 404 for a tenant that does not exist, and for the SYSTEM tenant — which is never in line anyway', async () => {
      await tenant('sys', 'active', 'suspended_at', 0, ', true, \'idle\'');
      await expect(setTenantAutomationExempt(db, 'nobody', true)).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
      await expect(setTenantAutomationExempt(db, 'sys', true)).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
      expect((await pool.query(`SELECT lifecycle_automation_exempt AS e FROM tenants WHERE id = 'sys'`)).rows[0].e).toBe(false);
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
        settings: { autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90, noticeDays: 7 },
        intervalHours: 6, running: false, lastRun: null, nextRunAt: null, archiveBlockedReason: null, archiveRetentionDays: 75,
        kept: [],
      });
    });

    it('shows what a tenant was told for this suspension, and not what it was told before it was resumed', async () => {
      await tenant('told', 'suspended', 'suspended_at', -86_400 * 40);
      await tenant('stale', 'suspended', 'suspended_at', -86_400 * 40);
      await tenant('unreached', 'suspended', 'suspended_at', -86_400 * 40);
      await notice('told', 'archive', -86_400 * 5, 86_400 * 2);
      await notice('stale', 'archive', -86_400 * 300, -86_400 * 293);      // told in an earlier suspension
      await notice('unreached', 'archive', -86_400 * 5, 86_400 * 2, 0);
      const status = await getTenantAutomationStatus(deps());
      expect(status.suspended.map((c) => [c.tenantId, c.notice])).toEqual([
        ['stale', null],
        ['told', { toldAt: '2026-02-24T00:00:00.000Z', date: '2026-03-03T00:00:00.000Z', reached: true }],
        ['unreached', { toldAt: '2026-02-24T00:00:00.000Z', date: '2026-03-03T00:00:00.000Z', reached: false }],
      ]);
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
      archived: [], deleted: [], failed: [], told: [], archiveSkippedReason: null, errors: [], ...over,
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

    it('says who was told and for which date — and counts a message that reached nobody as something to look at', async () => {
      const r = run({ told: [
        { tenantId: 'a', name: 'Alpha', action: 'archive', date: '2026-06-22T12:00:00.000Z', reached: true },
        { tenantId: 'b', name: 'Beta', action: 'delete', date: '2026-06-29T12:00:00.000Z', reached: false },
      ] });
      const { payload, dedupeKey } = notification(r);
      expect(payload.items).toEqual(['Told Alpha: archive on 2026-06-22', 'Nobody to tell at Beta: not deleted until it can be told']);
      expect(payload.detail).toContain('The automatic sweep told 1 tenant(s).');
      expect(payload.detail).toContain('1 tenant(s) could not be told');
      expect(payload.severityLabel).toBe('needs attention');
      expect(dedupeKey).toBe('tenant-automation:2026-06-15T12:00:00.000Z');       // somebody was written to: its own event
      expect(notification(run({ told: [r.told[0]] })).payload.severityLabel).toBe('done');
    });

    it('a tenant that still cannot be told is said once a day, not at every sweep', () => {
      const silent = { tenantId: 'b', name: 'Beta', action: 'delete' as const, date: '2026-06-29T12:00:00.000Z', reached: false };
      const morning = notification(run({ told: [silent] }));
      const noon = notification(run({ startedAt: '2026-06-15T18:00:00.000Z', told: [{ ...silent, date: '2026-06-29T18:00:00.000Z' }] }));
      const nextDay = notification(run({ startedAt: '2026-06-16T00:00:00.000Z', told: [silent] }));
      expect(noon.dedupeKey).toBe(morning.dedupeKey);
      expect(nextDay.dedupeKey).not.toBe(morning.dedupeKey);
      expect(morning.payload.severityLabel).toBe('needs attention');
      expect(morning.payload.detail).not.toContain('The automatic sweep');     // it did nothing
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
