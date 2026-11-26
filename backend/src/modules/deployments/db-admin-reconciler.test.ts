import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./service.js', () => ({
  getTenantNamespace: vi.fn(async () => 'tenant-ns'),
  parseJsonField: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v),
  redeployWithCurrentConfig: vi.fn(async () => undefined),
}));
vi.mock('./db-manager.js', async (orig) => ({ ...(await orig<typeof import('./db-manager.js')>()), buildDbContext: vi.fn(), execInDbPod: vi.fn() }));
vi.mock('./db-admin-access.js', async (orig) => ({ ...(await orig<typeof import('./db-admin-access.js')>()), ensureDatabaseAdminAccess: vi.fn(), adminLoginWorks: vi.fn() }));
vi.mock('./tenant-admin.js', () => ({ ensureTenantAdmin: vi.fn(), chooseTenantAdminUsername: vi.fn(), tenantAdminLogsIn: vi.fn() }));
vi.mock('./tenant-admin-store.js', () => ({
  loadTenantAdminAccount: vi.fn(),
  recordFirstTenantAdminAccount: vi.fn(),
  newTenantAdminPassword: vi.fn(() => 'fresh-platform-secret'),
  tenantAdminReady: vi.fn(),
  markTenantAdminReady: vi.fn(),
}));
/** The lease as a replica sees it: one run per job at a time, the rest refused. */
const leaseRunning = new Set<string>();
vi.mock('../../shared/scheduler-lease.js', () => ({
  withSchedulerLease: vi.fn(async (_db: unknown, job: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (leaseRunning.has(job)) return { ran: false };
    leaseRunning.add(job);
    try { return { ran: true, value: await fn() }; } finally { leaseRunning.delete(job); }
  }),
}));
vi.mock('./mongo-hardening.js', () => ({ rotateRoot: vi.fn(), rootLogsInWith: vi.fn() }));
vi.mock('../notifications/events.js', () => ({
  notifyAdminTenantDatabaseAccessLost: vi.fn(async () => true),
  notifyAdminTenantDatabaseAccessRestored: vi.fn(async () => true),
}));

import { ApiError } from '../../shared/errors.js';
import { databaseAdminState } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { encrypt } from '../oidc/crypto.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { buildDbContext, execInDbPod, type DbManagerContext } from './db-manager.js';
import type { DbCommandRunner } from './db-exec.js';
import { adminLoginWorks, DbUnreachableError, ensureDatabaseAdminAccess } from './db-admin-access.js';
import { redeployWithCurrentConfig } from './service.js';
import { chooseTenantAdminUsername, ensureTenantAdmin, tenantAdminLogsIn } from './tenant-admin.js';
import { loadTenantAdminAccount, markTenantAdminReady, recordFirstTenantAdminAccount, tenantAdminReady } from './tenant-admin-store.js';
import { rootLogsInWith, rotateRoot } from './mongo-hardening.js';
import { notifyAdminTenantDatabaseAccessLost, notifyAdminTenantDatabaseAccessRestored } from '../notifications/events.js';
import { incidentReason, STALE_ROW_MS, STUCK_ALERT_AFTER_MS } from './db-admin-state.js';
import {
  HARDEN_INTERVAL_MS, LOCKOUT_ALERT_AFTER_MS, ON_DEMAND_MIN_INTERVAL_MS, SHAPE_INTERVAL_MS, UNREACHABLE_ALERT_AFTER_MS,
  incidentTransition, listManagedDatabases, reconcileDatabaseAdmin, reconcileDatabaseAdminFor, reconcileInstance, stateValuesFor,
  type InstanceOutcome, type ManagedDatabase, type ReconcileDeps,
} from './db-admin-reconciler.js';

type StateRow = typeof databaseAdminState.$inferSelect;

const KEY = '00'.repeat(32);
const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-01-02T12:00:00Z');
const md = { deploymentId: 'd1', tenantId: 't1', engine: 'mariadb' } as unknown as ManagedDatabase;
const out = (mode: InstanceOutcome['mode'], changes: string[] = [], detail?: string, extra: Partial<InstanceOutcome> = {}): InstanceOutcome => ({ md, mode, changes, detail, ...extra });

// ─── Pure functions ─────────────────────────────────────────────────────────

describe('stateValuesFor', () => {
  it('a first conversion records when it reached the target', () => {
    const row = stateValuesFor(out('socket', ['dropped root@%']), undefined, at('2026-01-01T10:00:00Z'));
    expect(row).toMatchObject({
      mode: 'socket', convertedAt: at('2026-01-01T10:00:00Z'), lockedSince: null, unreachableSince: null, alertedAt: null,
      lastChanges: 'dropped root@%', hardenedAt: null, hardenedPod: null, shapedAt: null, rootRotatedAt: null,
    });
  });

  it('a mode short of the target does not count as a conversion', () => {
    expect(stateValuesFor(out('password'), undefined, NOW).convertedAt).toBeNull();
    expect(stateValuesFor(out('locked'), undefined, NOW).convertedAt).toBeNull();
  });

  it('a lockout keeps its start and whether it alerted across checks', () => {
    const first = stateValuesFor(out('locked', [], 'x'), undefined, at('2026-01-01T10:00:00Z'));
    const alerted = { ...first, alertedAt: at('2026-01-01T10:00:05Z'), rootSecretCipher: null } as StateRow;
    const later = stateValuesFor(out('locked', [], 'y'), alerted, at('2026-01-01T10:10:00Z'));
    expect(later).toMatchObject({ lockedSince: at('2026-01-01T10:00:00Z'), alertedAt: at('2026-01-01T10:00:05Z'), detail: 'y' });
  });

  it('a recovered login ends the incident and keeps the first conversion time', () => {
    const prev = { ...stateValuesFor(out('socket'), undefined, at('2026-01-01T09:00:00Z')), mode: 'locked', lockedSince: at('2026-01-01T10:00:00Z'), alertedAt: at('2026-01-01T10:00:05Z'), rootSecretCipher: null } as StateRow;
    const now = stateValuesFor(out('socket'), prev, at('2026-01-01T11:00:00Z'));
    expect(now).toMatchObject({ mode: 'socket', lockedSince: null, unreachableSince: null, alertedAt: null, convertedAt: at('2026-01-01T09:00:00Z') });
  });

  describe('an instance that does not answer', () => {
    it('keeps what was last known about its login and starts its unreachable clock', () => {
      const prev = { ...stateValuesFor(out('locked'), undefined, at('2026-01-01T10:00:00Z')), alertedAt: at('2026-01-01T10:00:05Z'), hardenedAt: at('2026-01-01T09:00:00Z'), hardenedPod: 'p1', rootSecretCipher: 'cipher' } as StateRow;
      const now = stateValuesFor(out('unreachable', [], 'no pod'), prev, at('2026-01-01T10:10:00Z'));
      expect(now).toMatchObject({
        mode: 'locked', lockedSince: prev.lockedSince, alertedAt: prev.alertedAt, hardenedAt: prev.hardenedAt, hardenedPod: 'p1',
        checkedAt: at('2026-01-01T10:10:00Z'), detail: 'no pod', unreachableSince: at('2026-01-01T10:10:00Z'),
      });
    });

    it('keeps the clock across checks, and ends it when the instance answers', () => {
      const t0 = at('2026-01-01T10:00:00Z');
      const first = { ...stateValuesFor(out('socket'), undefined, at('2026-01-01T09:00:00Z')), rootSecretCipher: null } as StateRow;
      const down1 = { ...stateValuesFor(out('unreachable', [], 'a'), first, t0), rootSecretCipher: null } as StateRow;
      const down2 = stateValuesFor(out('unreachable', [], 'b'), down1, at('2026-01-01T10:30:00Z'));
      expect(down2.unreachableSince).toEqual(t0);
      const back = stateValuesFor(out('socket'), { ...down2, rootSecretCipher: null } as StateRow, at('2026-01-01T11:00:00Z'));
      expect(back).toMatchObject({ unreachableSince: null, alertedAt: null });
    });

    it('keeps whether it alerted while unreachable (as while locked)', () => {
      const down = { ...stateValuesFor(out('unreachable'), undefined, NOW), alertedAt: at('2026-01-02T12:30:00Z'), rootSecretCipher: null } as StateRow;
      expect(stateValuesFor(out('unreachable'), down, at('2026-01-02T12:20:00Z')).alertedAt).toEqual(at('2026-01-02T12:30:00Z'));
    });

    it('with nothing to keep ends up recorded as unreachable, its clock started', () => {
      expect(stateValuesFor(out('unreachable', [], 'no pod'), undefined, NOW)).toMatchObject({ mode: 'unreachable', detail: 'no pod', convertedAt: null, unreachableSince: NOW });
    });

    it('a check without a detail keeps the previous one', () => {
      const prev = { ...stateValuesFor(out('socket', [], 'earlier'), undefined, NOW), rootSecretCipher: null } as StateRow;
      expect(stateValuesFor(out('unreachable'), prev, NOW).detail).toBe('earlier');
    });
  });

  it('never carries root_secret_cipher: only the rotation writes it', () => {
    const prev = { ...stateValuesFor(out('socket'), undefined, NOW), rootSecretCipher: 'secret' } as StateRow;
    for (const o of [out('socket'), out('locked'), out('unreachable')]) {
      expect(stateValuesFor(o, prev, NOW)).not.toHaveProperty('rootSecretCipher');
    }
    expect(stateValuesFor(out('socket'), undefined, NOW)).not.toHaveProperty('rootSecretCipher');
  });

  it('keeps shapedAt, hardenedAt, hardenedPod and rootRotatedAt until a run says it did the work', () => {
    const prev = {
      ...stateValuesFor(out('socket'), undefined, at('2026-01-01T00:00:00Z')),
      shapedAt: at('2026-01-01T00:30:00Z'), hardenedAt: at('2026-01-01T01:00:00Z'), hardenedPod: 'old-pod', rootRotatedAt: at('2026-01-01T02:00:00Z'), rootSecretCipher: null,
    } as StateRow;
    // a quick check (no `full`) changes none of them
    expect(stateValuesFor(out('socket', [], undefined, { pod: 'new-pod' }), prev, NOW)).toMatchObject({
      shapedAt: at('2026-01-01T00:30:00Z'), hardenedAt: at('2026-01-01T01:00:00Z'), hardenedPod: 'old-pod', rootRotatedAt: at('2026-01-01T02:00:00Z'),
    });
    expect(stateValuesFor(out('socket', [], undefined, { full: true, hardened: true, rotated: true, pod: 'new-pod' }), prev, NOW))
      .toMatchObject({ shapedAt: NOW, hardenedAt: NOW, hardenedPod: 'new-pod', rootRotatedAt: NOW });
    // a full check that did not harden keeps the hardening record, and the pod it was done in
    expect(stateValuesFor(out('socket', [], undefined, { full: true, hardened: false, pod: 'new-pod' }), prev, NOW))
      .toMatchObject({ shapedAt: NOW, hardenedAt: at('2026-01-01T01:00:00Z'), hardenedPod: 'old-pod' });
  });

  it('keeps the last changes when a run changed nothing', () => {
    const prev = { ...stateValuesFor(out('socket', ['did a thing']), undefined, NOW), rootSecretCipher: null } as StateRow;
    expect(stateValuesFor(out('socket'), prev, NOW).lastChanges).toBe('did a thing');
    expect(stateValuesFor(out('socket', ['a', 'b']), prev, NOW).lastChanges).toBe('a; b');
  });
});

describe('incidentTransition', () => {
  const since = at('2026-01-01T10:00:00Z');
  const plus = (ms: number): Date => new Date(since.getTime() + ms);
  const lockedRow = (over: Partial<StateRow> = {}): StateRow => ({
    ...stateValuesFor(out('locked'), undefined, since), alertedAt: null, rootSecretCipher: null, ...over,
  }) as StateRow;
  const lockedAfter = (over: Partial<ReturnType<typeof stateValuesFor>> = {}) => ({ ...lockedRow(), ...over });
  const downRow = (over: Partial<StateRow> = {}): StateRow => ({
    ...stateValuesFor(out('unreachable'), undefined, since), alertedAt: null, rootSecretCipher: null, ...over,
  }) as StateRow;

  describe('a lockout, after five minutes', () => {
    it('a few seconds (a restart) is not announced', () => {
      expect(incidentTransition('locked', undefined, lockedAfter(), plus(0))).toBe('none');
      expect(incidentTransition('locked', undefined, lockedAfter(), plus(30_000))).toBe('none');
    });

    it('the boundary: one millisecond short is not announced, exactly five minutes is', () => {
      expect(incidentTransition('locked', lockedRow(), lockedAfter(), plus(LOCKOUT_ALERT_AFTER_MS - 1))).toBe('none');
      expect(incidentTransition('locked', lockedRow(), lockedAfter(), plus(LOCKOUT_ALERT_AFTER_MS))).toBe('announce-lost');
      expect(incidentTransition('locked', lockedRow(), lockedAfter(), plus(LOCKOUT_ALERT_AFTER_MS + 1))).toBe('announce-lost');
    });

    it('is five minutes', () => expect(LOCKOUT_ALERT_AFTER_MS).toBe(5 * 60 * 1000));

    it('already announced is not announced again', () => {
      const alerted = lockedAfter({ alertedAt: plus(LOCKOUT_ALERT_AFTER_MS) });
      expect(incidentTransition('locked', lockedRow({ alertedAt: alerted.alertedAt }), alerted, plus(2 * LOCKOUT_ALERT_AFTER_MS))).toBe('none');
    });

    it('an alert that did not go out is retried on the next check', () => {
      expect(incidentTransition('locked', lockedRow(), lockedAfter(), plus(LOCKOUT_ALERT_AFTER_MS + 600_000))).toBe('announce-lost');
    });

    it('with no recorded start it cannot be timed, so it is not announced', () => {
      expect(incidentTransition('locked', undefined, lockedAfter({ lockedSince: null }), plus(10 * LOCKOUT_ALERT_AFTER_MS))).toBe('none');
    });
  });

  describe('an instance that does not answer, after an hour', () => {
    const downAfter = (over: Partial<ReturnType<typeof stateValuesFor>> = {}) => ({ ...downRow(), ...over });

    it('is not announced within the hour (a restart, a long start-up, an upgrade)', () => {
      expect(incidentTransition('unreachable', undefined, downAfter(), plus(UNREACHABLE_ALERT_AFTER_MS - 1))).toBe('none');
    });

    it('the boundary: exactly an hour is announced', () => {
      expect(incidentTransition('unreachable', downRow(), downAfter(), plus(UNREACHABLE_ALERT_AFTER_MS))).toBe('announce-lost');
    });

    it('is an hour', () => expect(UNREACHABLE_ALERT_AFTER_MS).toBe(60 * 60 * 1000));

    it('already announced is not announced again', () => {
      expect(incidentTransition('unreachable', downRow({ alertedAt: plus(UNREACHABLE_ALERT_AFTER_MS) }), downAfter({ alertedAt: plus(UNREACHABLE_ALERT_AFTER_MS) }), plus(5 * UNREACHABLE_ALERT_AFTER_MS))).toBe('none');
    });

    it('with no recorded start it cannot be timed', () => {
      expect(incidentTransition('unreachable', undefined, downAfter({ unreachableSince: null }), plus(10 * UNREACHABLE_ALERT_AFTER_MS))).toBe('none');
    });

    it('a locked instance that goes quiet is still the lockout\'s incident: announced once, never twice', () => {
      const alertedLock = { ...lockedAfter({ alertedAt: plus(LOCKOUT_ALERT_AFTER_MS) }), unreachableSince: since };
      expect(incidentTransition('unreachable', lockedRow({ alertedAt: alertedLock.alertedAt }), alertedLock, plus(2 * UNREACHABLE_ALERT_AFTER_MS))).toBe('none');
    });
  });

  describe('recovery', () => {
    const ok = (mode: 'socket' | 'password' | 'trust' | 'restricted' | 'open') => stateValuesFor(out(mode), undefined, plus(3_600_000));

    it('is announced for an incident that alerted — a lockout or an hour of silence', () => {
      expect(incidentTransition('socket', lockedRow({ alertedAt: plus(1) }), ok('socket'), plus(3_600_000))).toBe('announce-restored');
      expect(incidentTransition('socket', downRow({ alertedAt: plus(1) }), ok('socket'), plus(3_600_000))).toBe('announce-restored');
    });

    it.each(['socket', 'password', 'trust', 'restricted', 'open'] as const)('in %s mode', (mode) => {
      expect(incidentTransition(mode, lockedRow({ alertedAt: plus(1) }), ok(mode), plus(3_600_000))).toBe('announce-restored');
    });

    it('is not announced for an incident that never alerted', () => {
      expect(incidentTransition('socket', lockedRow(), ok('socket'), plus(3_600_000))).toBe('none');
      expect(incidentTransition('socket', downRow(), ok('socket'), plus(3_600_000))).toBe('none');
    });

    it('needs the incident\'s start too', () => {
      expect(incidentTransition('socket', lockedRow({ alertedAt: plus(1), lockedSince: null }), ok('socket'), plus(3_600_000))).toBe('none');
    });

    it('a first check that is fine announces nothing', () => {
      expect(incidentTransition('socket', undefined, stateValuesFor(out('socket'), undefined, NOW), NOW)).toBe('none');
    });

    it('is announced once: the record it leaves has no alert for the next check to see', () => {
      const after = ok('socket');
      expect(after.alertedAt).toBeNull();
      expect(incidentTransition('socket', { ...after, rootSecretCipher: null } as StateRow, after, plus(7_200_000))).toBe('none');
    });
  });
});

describe('stateValuesFor — stale rows, stuck set-up, the hardening retry, capped text', () => {
  const t0 = at('2026-01-02T10:00:00Z');
  const rowAt = (checked: Date, over: Partial<StateRow> = {}): StateRow => ({
    ...stateValuesFor(out('socket'), undefined, checked), lockedSince: checked, unreachableSince: checked, stuckSince: checked, alertedAt: checked, rootSecretCipher: null, ...over,
  }) as StateRow;

  it('a row nobody checked for over 30 minutes (the instance was stopped) starts its incident clocks again', () => {
    const stale = rowAt(new Date(t0.getTime() - STALE_ROW_MS - 1));
    expect(stateValuesFor(out('locked'), stale, t0)).toMatchObject({ lockedSince: t0, alertedAt: null });
    expect(stateValuesFor(out('unreachable'), stale, t0)).toMatchObject({ unreachableSince: t0, alertedAt: null });
    expect(stateValuesFor(out('socket', [], undefined, { stuck: true }), stale, t0)).toMatchObject({ stuckSince: t0, alertedAt: null });
  });

  it('exactly 30 minutes is not stale, and what the row knew is kept', () => {
    const fresh = rowAt(new Date(t0.getTime() - STALE_ROW_MS));
    expect(stateValuesFor(out('locked'), fresh, t0)).toMatchObject({ lockedSince: fresh.lockedSince, alertedAt: fresh.alertedAt });
  });

  it('staleness does not cost the first-conversion time or the hardening record', () => {
    const stale = rowAt(new Date(t0.getTime() - 10 * STALE_ROW_MS), { hardenedAt: at('2026-01-01T00:00:00Z'), hardenedPod: 'p', convertedAt: at('2025-12-01T00:00:00Z') });
    expect(stateValuesFor(out('unreachable'), stale, t0)).toMatchObject({ hardenedPod: 'p', convertedAt: at('2025-12-01T00:00:00Z') });
  });

  describe('stuckSince', () => {
    const base = rowAt(new Date(t0.getTime() - 60_000), { lockedSince: null, unreachableSince: null, stuckSince: null, alertedAt: null });
    it('starts with a stuck check and is kept by the next', () => {
      const first = { ...stateValuesFor(out('socket', [], undefined, { full: true, stuck: true }), base, t0), rootSecretCipher: null } as StateRow;
      expect(first.stuckSince).toEqual(t0);
      const later = stateValuesFor(out('socket', [], undefined, { full: true, stuck: true }), first, new Date(t0.getTime() + 60_000));
      expect(later.stuckSince).toEqual(t0);
    });
    it('a full check that is not stuck ends it', () => {
      const stuck = { ...base, stuckSince: t0 } as StateRow;
      expect(stateValuesFor(out('socket', [], undefined, { full: true, hardened: true }), stuck, new Date(t0.getTime() + 60_000)).stuckSince).toBeNull();
    });
    it('a quick check says nothing about the set-up: it keeps it', () => {
      const stuck = { ...base, stuckSince: t0 } as StateRow;
      expect(stateValuesFor(out('socket'), stuck, new Date(t0.getTime() + 60_000)).stuckSince).toEqual(t0);
    });
    it('keeps whether it alerted while stuck, and drops it when the incident ends', () => {
      const stuck = { ...base, stuckSince: t0, alertedAt: t0 } as StateRow;
      const now = new Date(t0.getTime() + 60_000);
      expect(stateValuesFor(out('socket', [], undefined, { full: true, stuck: true }), stuck, now).alertedAt).toEqual(t0);
      expect(stateValuesFor(out('socket', [], undefined, { full: true, hardened: true }), stuck, now).alertedAt).toBeNull();
    });
  });

  describe('hardenTriedAt', () => {
    const base = rowAt(new Date(t0.getTime() - 60_000), { lockedSince: null, unreachableSince: null, stuckSince: null, alertedAt: null, hardenTriedAt: at('2026-01-02T09:30:00Z') });
    it('is stamped by a pass that did not finish', () => {
      expect(stateValuesFor(out('socket', [], undefined, { full: true, hardenTried: true }), base, t0).hardenTriedAt).toEqual(t0);
    });
    it('is cleared by a pass that finished', () => {
      expect(stateValuesFor(out('socket', [], undefined, { full: true, hardened: true, pod: 'p' }), base, t0).hardenTriedAt).toBeNull();
    });
    it('is kept by a check that did not harden', () => {
      expect(stateValuesFor(out('socket', [], undefined, { full: true }), base, t0).hardenTriedAt).toEqual(base.hardenTriedAt);
    });
  });

  it('caps the detail (tenant-influenced client text) at 1000 characters, in both branches', () => {
    const long = 'x'.repeat(5000);
    expect(stateValuesFor(out('locked', [], long), undefined, t0).detail).toHaveLength(1000);
    const prev = { ...rowAt(new Date(t0.getTime() - 1000)), rootSecretCipher: null } as StateRow;
    expect(stateValuesFor(out('unreachable', [], long), prev, t0).detail).toHaveLength(1000);
    expect(stateValuesFor(out('locked', [], 'short'), undefined, t0).detail).toBe('short');
  });
});

describe('incidentTransition — a set-up that does not finish', () => {
  const since = at('2026-01-02T00:00:00Z');
  const stuckRow = (over: Partial<StateRow> = {}): StateRow => ({
    ...stateValuesFor(out('socket', [], undefined, { full: true, stuck: true }), undefined, since), rootSecretCipher: null, ...over,
  }) as StateRow;
  const after = (over: Partial<ReturnType<typeof stateValuesFor>> = {}) => ({ ...stuckRow(), ...over });

  it('is announced after six hours, not before', () => {
    expect(incidentTransition('socket', stuckRow(), after(), new Date(since.getTime() + STUCK_ALERT_AFTER_MS - 1))).toBe('none');
    expect(incidentTransition('socket', stuckRow(), after(), new Date(since.getTime() + STUCK_ALERT_AFTER_MS))).toBe('announce-lost');
    expect(STUCK_ALERT_AFTER_MS).toBe(6 * 3600_000);
  });

  it('once', () => {
    const alerted = after({ alertedAt: since });
    expect(incidentTransition('socket', stuckRow({ alertedAt: since }), alerted, new Date(since.getTime() + 2 * STUCK_ALERT_AFTER_MS))).toBe('none');
  });

  it('its recovery is announced after an alerted incident', () => {
    const done = stateValuesFor(out('socket', [], undefined, { full: true, hardened: true }), { ...stuckRow({ alertedAt: since }) }, new Date(since.getTime() + STUCK_ALERT_AFTER_MS + 1000));
    expect(incidentTransition('socket', stuckRow({ alertedAt: since }), done, new Date(since.getTime() + STUCK_ALERT_AFTER_MS + 1000))).toBe('announce-restored');
  });

  it('its reason says the tenant has no SQL Manager', () => {
    expect(incidentReason(after({ detail: 'the hardening pass did not finish' }))).toBe('set-up has not finished for six hours, its tenant has no SQL Manager — the hardening pass did not finish');
  });

  it('the reason follows the clocks: a lockout, a silence, else the set-up', () => {
    const t = at('2026-01-02T00:00:00Z');
    expect(incidentReason({ ...after(), lockedSince: t, detail: 'd' })).toBe('login refused — d');
    expect(incidentReason({ ...after(), mode: 'socket', unreachableSince: t, stuckSince: null, detail: 'd' })).toBe('no answer for over an hour — d');
  });
});

describe('incidentReason', () => {
  it('says why, for the notification\'s list item', () => {
    expect(incidentReason(stateValuesFor(out('locked', [], 'root refuses both'), undefined, NOW))).toBe('login refused — root refuses both');
    expect(incidentReason(stateValuesFor(out('unreachable', [], 'no running pod'), undefined, NOW))).toBe('no answer for over an hour — no running pod');
    expect(incidentReason(stateValuesFor(out('locked'), undefined, NOW))).toBe('login refused — no detail');
  });
});

// ─── reconcileInstance ──────────────────────────────────────────────────────

interface Upsert { readonly table: unknown; readonly values: Record<string, unknown>; readonly set?: Record<string, unknown> }

function fakeDb(o: { prev?: Array<Partial<StateRow>>; managed?: unknown[]; failUpsertFor?: string } = {}) {
  const upserts: Upsert[] = [];
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const chain = (rows: unknown[]) => { const c: Record<string, unknown> = {}; c.from = () => c; c.innerJoin = () => c; c.where = async () => rows; return c; };
  const db = {
    select: () => ({ from: (t: unknown) => (t === databaseAdminState ? { where: async () => o.prev ?? [] } : chain(o.managed ?? [{ id: 'dep-1' }])) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (c: { set: Record<string, unknown> }) => {
          if (o.failUpsertFor && values.deploymentId === o.failUpsertFor) throw new Error('database is down');
          upserts.push({ table, values, set: c.set });
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, values });
          // `await`ed as is, or with .returning() (the extra-mounts clearing)
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: 'dep-1' }] });
        },
      }),
    }),
  };
  return { db: db as unknown as Database, upserts, updates };
}

function mdFor(over: Record<string, unknown> = {}): ManagedDatabase {
  return {
    deploymentId: 'dep-1', deploymentName: 'db', tenantId: 'ten-1', tenantName: 'Acme', engine: 'mariadb', componentName: 'mariadb', standalone: true,
    entry: { runtime: 'mariadb', code: 'mariadb-11', type: 'database' }, configuration: { MARIADB_ROOT_PASSWORD: 'cfg' }, extraMountCount: 0, ...over,
  } as unknown as ManagedDatabase;
}

function dbCtx(over: Partial<DbManagerContext> = {}): DbManagerContext {
  return { kubeconfigPath: undefined, namespace: 'tenant-ns', podName: 'pod', containerName: 'c', engine: 'mariadb', rootPassword: 'cfg', rootUsername: 'root', ...over };
}

function prevRow(over: Partial<StateRow> = {}): StateRow {
  return {
    deploymentId: 'dep-1', tenantId: 'ten-1', engine: 'mariadb', mode: 'socket', detail: null, lastChanges: null, checkedAt: at('2026-01-02T11:55:00Z'),
    convertedAt: at('2026-01-01T00:00:00Z'), lockedSince: null, unreachableSince: null, stuckSince: null, alertedAt: null, shapedAt: null, hardenTriedAt: null, hardenedAt: null, hardenedPod: null,
    rootSecretCipher: null, rootRotatedAt: null, ...over,
  } as StateRow;
}

const run = vi.fn();
function deps(db: Database, over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return { db, k8s: {} as ReconcileDeps['k8s'], encryptionKey: KEY, run, now: () => NOW, ...over };
}

const ACCOUNT = { username: 'dbadmin', password: 'pw' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(buildDbContext).mockResolvedValue(dbCtx());
  vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'socket', changed: [] });
  vi.mocked(ensureTenantAdmin).mockResolvedValue({ changes: [], problems: [] });
  vi.mocked(tenantAdminReady).mockResolvedValue(true);
  vi.mocked(markTenantAdminReady).mockResolvedValue(undefined);
  vi.mocked(tenantAdminLogsIn).mockResolvedValue(true);
  vi.mocked(adminLoginWorks).mockResolvedValue(true);
  vi.mocked(loadTenantAdminAccount).mockResolvedValue(ACCOUNT);
  vi.mocked(chooseTenantAdminUsername).mockResolvedValue('dbadmin');
  vi.mocked(recordFirstTenantAdminAccount).mockImplementation(async (_db, _id, candidate) => candidate);
  vi.mocked(rotateRoot).mockResolvedValue(true);
  vi.mocked(rootLogsInWith).mockResolvedValue(true);
});

describe('reconcileInstance', () => {
  it('no running pod is unreachable', async () => {
    vi.mocked(buildDbContext).mockRejectedValue(new ApiError('POD_NOT_FOUND', 'No running pod found', 503));
    expect(await reconcileInstance(deps(fakeDb().db), mdFor())).toEqual({ md: mdFor(), mode: 'unreachable', changes: [], detail: 'no running pod' });
    expect(ensureDatabaseAdminAccess).not.toHaveBeenCalled();
  });

  it('any other failure to build the context is unreachable with its message', async () => {
    vi.mocked(buildDbContext).mockRejectedValue(new Error('apiserver timeout'));
    expect(await reconcileInstance(deps(fakeDb().db), mdFor())).toMatchObject({ mode: 'unreachable', detail: 'apiserver timeout' });
  });

  it('MongoDB without a root password has no administrator login to keep: open', async () => {
    vi.mocked(buildDbContext).mockResolvedValue(dbCtx({ engine: 'mongodb', rootPassword: '' }));
    expect(await reconcileInstance(deps(fakeDb().db), mdFor({ engine: 'mongodb' }))).toMatchObject({ mode: 'open', changes: [] });
    expect(ensureDatabaseAdminAccess).not.toHaveBeenCalled();
  });

  it('without an injected runner every command runs under `timeout 300` in the pod', async () => {
    vi.mocked(execInDbPod).mockResolvedValue({ stdout: '', stderr: '' });
    let given: DbCommandRunner | undefined;
    vi.mocked(ensureDatabaseAdminAccess).mockImplementation(async (_c, _o, r) => { given = r; return { mode: 'socket', changed: [] }; });
    await reconcileInstance({ ...deps(fakeDb().db), run: undefined }, mdFor());
    await given!(dbCtx(), ['mariadb', '-e', 'SELECT 1'], 'in');
    expect(execInDbPod).toHaveBeenCalledWith(expect.anything(), ['timeout', '300', 'mariadb', '-e', 'SELECT 1'], 'in');
  });

  it('a database that never answered is unreachable, not locked, and keeps what was done before it', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new DbUnreachableError("ERROR 2002: Can't connect"));
    const o = await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(o).toMatchObject({ mode: 'unreachable', detail: "ERROR 2002: Can't connect" });
    expect(ensureTenantAdmin).not.toHaveBeenCalled();
  });

  it('an exec that failed some other way is unreachable too', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new Error('websocket closed'));
    expect(await reconcileInstance(deps(fakeDb().db), mdFor())).toMatchObject({ mode: 'unreachable', detail: 'websocket closed' });
  });

  it('an app stack: root is checked, the tenant administrator is not touched', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'an app stack' });
    const o = await reconcileInstance(deps(fakeDb().db), mdFor({ standalone: false }));
    expect(o).toMatchObject({ mode: 'password', detail: 'an app stack' });
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledWith(expect.anything(), { standalone: false }, run);
    expect(ensureTenantAdmin).not.toHaveBeenCalled();
    expect(loadTenantAdminAccount).not.toHaveBeenCalled();
  });

  it('a lockout: nothing more is attempted', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'root refuses both' });
    expect(await reconcileInstance(deps(fakeDb().db), mdFor())).toMatchObject({ mode: 'locked', detail: 'root refuses both' });
    expect(ensureTenantAdmin).not.toHaveBeenCalled();
  });

  it('a standalone instance still on the password login also gets its tenant administrator, but no hardening pass', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'socket login does not work here' });
    const o = await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: false }, run);
    expect(o).toMatchObject({ mode: 'password', hardened: false, detail: 'socket login does not work here' });
  });

  it('the first check hardens, and reports it', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'socket', changed: ['root@localhost now logs in by socket only'] });
    vi.mocked(ensureTenantAdmin).mockResolvedValue({ changes: ['created dbadmin'], problems: [] });
    const o = await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: true }, run);
    expect(o).toMatchObject({ mode: 'socket', hardened: true, rotated: false, changes: ['root@localhost now logs in by socket only', 'created dbadmin'] });
  });

  it.each([
    ['an hour ago', HARDEN_INTERVAL_MS - 23 * 3600_000, false],
    ['one millisecond short of a day', HARDEN_INTERVAL_MS - 1, false],
    ['exactly a day', HARDEN_INTERVAL_MS, true],
    ['two days', 2 * HARDEN_INTERVAL_MS, true],
  ])('hardened %s -> harden=%s', async (_label, ageMs, expected) => {
    const o = await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow({ hardenedAt: new Date(NOW.getTime() - ageMs), hardenedPod: 'pod' }));
    expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: expected }, run);
    expect(o.hardened).toBe(expected);
  });

  it('the daily pass is a day', () => expect(HARDEN_INTERVAL_MS).toBe(24 * 3600_000));

  it('a new pod is hardened at once, whatever the age of the last pass (it may be a restore of an older data directory)', async () => {
    await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow({ hardenedAt: new Date(NOW.getTime() - 60_000), hardenedPod: 'the-old-pod' }));
    expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: true }, run);
  });

  it('only a target mode is hardened: root is not the platform\'s alone on the password login', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'x' });
    await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow());
    expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: false }, run);
  });

  describe('a hardening pass that keeps failing', () => {
    const failing = () => vi.mocked(ensureTenantAdmin).mockResolvedValue({ changes: [], problems: ['narrowing accounts: boom'] });

    it('is a stuck outcome, remembered as tried', async () => {
      failing();
      const o = await reconcileInstance(deps(fakeDb().db), mdFor());
      expect(o).toMatchObject({ hardened: false, hardenTried: true, stuck: true });
    });

    it('is not tried again within the hour, and stays stuck while it was', async () => {
      const prev = prevRow({ hardenedAt: null, hardenTriedAt: new Date(NOW.getTime() - 30 * 60_000), stuckSince: new Date(NOW.getTime() - 3600_000), detail: 'earlier problem' });
      const o = await reconcileInstance(deps(fakeDb().db), mdFor(), prev);
      expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: false }, run);
      expect(o).toMatchObject({ hardened: false, hardenTried: false, stuck: true, detail: 'earlier problem' });
    });

    it('is tried again after an hour', async () => {
      const prev = prevRow({ hardenedAt: null, hardenTriedAt: new Date(NOW.getTime() - SHAPE_INTERVAL_MS) });
      await reconcileInstance(deps(fakeDb().db), mdFor(), prev);
      expect(ensureTenantAdmin).toHaveBeenCalledWith(expect.anything(), ACCOUNT, { harden: true }, run);
    });

    it('a finished pass is not stuck', async () => {
      const o = await reconcileInstance(deps(fakeDb().db), mdFor());
      expect(o).toMatchObject({ hardened: true, stuck: false, hardenTried: false });
    });
  });

  describe('the panel shows the account once it is set up and hardened', () => {
    it('a part-way access failure (partial) does not mark it ready on the password login', async () => {
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'a step failed', partial: true });
      await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow());
      expect(markTenantAdminReady).not.toHaveBeenCalled();
    });

    it('a completed hardening pass marks it ready', async () => {
      await reconcileInstance(deps(fakeDb().db), mdFor());
      expect(markTenantAdminReady).toHaveBeenCalledWith(expect.anything(), 'dep-1', NOW);
    });

    it('a pass that did not finish does not, and says why in the detail (the next check tries again)', async () => {
      vi.mocked(ensureTenantAdmin).mockResolvedValue({ changes: [], problems: ['narrowing accounts: ERROR 1045', 'objects that ran as root: boom'] });
      const o = await reconcileInstance(deps(fakeDb().db), mdFor());
      expect(markTenantAdminReady).not.toHaveBeenCalled();
      expect(o.hardened).toBe(false);
      expect(o.detail).toBe('the hardening pass did not finish, it is tried again within the hour: narrowing accounts: ERROR 1045; objects that ran as root: boom');
    });

    it('a check that did not harden (not due) leaves it as it was', async () => {
      await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow({ hardenedAt: new Date(NOW.getTime() - 3600_000), hardenedPod: 'pod' }));
      expect(markTenantAdminReady).not.toHaveBeenCalled();
    });

    it('on the password login (root is not the platform\'s alone, so there is nothing to wait for) it is ready at once', async () => {
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'x' });
      await reconcileInstance(deps(fakeDb().db), mdFor(), prevRow());
      expect(markTenantAdminReady).toHaveBeenCalledTimes(1);
    });
  });

  describe('a standalone instance stored with extra mounts', () => {
    it('has them cleared and is redeployed without them, once; nothing else is checked', async () => {
      const f = fakeDb();
      const o = await reconcileInstance(deps(f.db), mdFor({ extraMountCount: 2 }));
      expect(f.updates).toEqual([{ table: expect.anything(), values: { extraMounts: null } }]);
      expect(redeployWithCurrentConfig).toHaveBeenCalledWith(f.db, { id: 'dep-1' }, expect.anything());
      expect(o).toMatchObject({ mode: 'unreachable', detail: 'restarted without its extra mounts' });
      expect(o.changes).toEqual(['removed its extra mounts and restarted it once (a database instance takes none)']);
      expect(buildDbContext).not.toHaveBeenCalled();
      expect(ensureDatabaseAdminAccess).not.toHaveBeenCalled();
    });

    it('a failure is reported, not thrown — and the row keeps its mounts, so the next check tries again', async () => {
      vi.mocked(redeployWithCurrentConfig).mockRejectedValueOnce(new Error('apiserver down'));
      const f = fakeDb();
      const o = await reconcileInstance(deps(f.db), mdFor({ extraMountCount: 1 }));
      expect(o).toMatchObject({ mode: 'unreachable', detail: 'its extra mounts could not be removed: apiserver down' });
      expect(f.updates).toEqual([]);
    });

    it('an app stack\'s mounts are the tenant\'s own and are left alone', async () => {
      const f = fakeDb();
      await reconcileInstance(deps(f.db), mdFor({ standalone: false, extraMountCount: 2 }));
      expect(f.updates).toEqual([]);
      expect(redeployWithCurrentConfig).not.toHaveBeenCalled();
      expect(ensureDatabaseAdminAccess).toHaveBeenCalled();
    });
  });

  describe('between two full checks (the quick path)', () => {
    const recent = (over: Partial<StateRow> = {}): StateRow => prevRow({ shapedAt: new Date(NOW.getTime() - 30 * 60_000), hardenedPod: 'pod', ...over });

    it('proves both logins and stops there: no full check, no write to the instance', async () => {
      const o = await reconcileInstance(deps(fakeDb().db), mdFor(), recent({ detail: 'earlier' }));
      expect(o).toEqual({ md: mdFor(), mode: 'socket', changes: [], detail: 'earlier', pod: 'pod' });
      expect(o.full).toBeUndefined();
      expect(tenantAdminLogsIn).toHaveBeenCalledWith(expect.anything(), ACCOUNT, run);
      expect(adminLoginWorks).toHaveBeenCalledWith(expect.anything(), 'socket', run);
      expect(ensureDatabaseAdminAccess).not.toHaveBeenCalled();
      expect(ensureTenantAdmin).not.toHaveBeenCalled();
    });

    it('a quick outcome does not touch shapedAt (the next full check is still due on time)', async () => {
      const o = await reconcileInstance(deps(fakeDb().db), mdFor(), recent());
      const row = stateValuesFor(o, { ...recent(), rootSecretCipher: null } as StateRow, NOW);
      expect(row.shapedAt).toEqual(recent().shapedAt);
    });

    it.each([
      ['the last full check is an hour old', () => recent({ shapedAt: new Date(NOW.getTime() - SHAPE_INTERVAL_MS) })],
      ['there was never a full check', () => recent({ shapedAt: null })],
      ['the last mode was a lockout', () => recent({ mode: 'locked' })],
      ['the last mode was unreachable', () => recent({ mode: 'unreachable' })],
      ['the last mode was open', () => recent({ mode: 'open' })],
      ['the pod is not the one that was hardened', () => recent({ hardenedPod: 'other-pod' })],
      ['nothing was ever hardened in a pod', () => recent({ hardenedPod: null })],
    ])('falls back to a full check when %s', async (_why, row) => {
      await reconcileInstance(deps(fakeDb().db), mdFor(), row());
      expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(1);
    });

    it('is one hour', () => expect(SHAPE_INTERVAL_MS).toBe(3600_000));

    it.each([
      ['the tenant administrator is not ready yet', () => vi.mocked(tenantAdminReady).mockResolvedValue(false)],
      ['it has no account on record', () => vi.mocked(loadTenantAdminAccount).mockResolvedValue(null)],
      ['the tenant administrator no longer logs in', () => vi.mocked(tenantAdminLogsIn).mockResolvedValue(false)],
      ['the platform\'s own login no longer works', () => vi.mocked(adminLoginWorks).mockResolvedValue(false)],
    ])('falls back to a full check when %s', async (_why, arrange) => {
      arrange();
      await reconcileInstance(deps(fakeDb().db), mdFor(), recent());
      expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(1);
    });

    it('on the password login the pod does not matter: root was never the platform\'s alone', async () => {
      const o = await reconcileInstance(deps(fakeDb().db), mdFor(), recent({ mode: 'password', hardenedPod: 'other-pod' }));
      expect(o.full).toBeUndefined();
      expect(adminLoginWorks).toHaveBeenCalledWith(expect.anything(), 'password', run);
    });

    it('an app stack only proves the platform\'s own login: it has no tenant administrator', async () => {
      const o = await reconcileInstance(deps(fakeDb().db), mdFor({ standalone: false }), recent({ mode: 'password' }));
      expect(o.full).toBeUndefined();
      expect(tenantAdminReady).not.toHaveBeenCalled();
      expect(tenantAdminLogsIn).not.toHaveBeenCalled();
    });
  });

  it('a first account is named and recorded BEFORE it is created', async () => {
    const order: string[] = [];
    vi.mocked(loadTenantAdminAccount).mockResolvedValue(null);
    vi.mocked(chooseTenantAdminUsername).mockImplementation(async () => { order.push('choose'); return 'dbadmin_insula'; });
    vi.mocked(recordFirstTenantAdminAccount).mockImplementation(async (_d, _i, c) => { order.push('record'); return c; });
    vi.mocked(ensureTenantAdmin).mockImplementation(async () => { order.push('ensure'); return { changes: [], problems: [] }; });
    await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(order).toEqual(['choose', 'record', 'ensure']);
    const candidate = vi.mocked(recordFirstTenantAdminAccount).mock.calls[0]![2];
    expect(candidate).toEqual({ username: 'dbadmin_insula', password: 'fresh-platform-secret' });
  });

  it('when another run recorded the account first, that one is used', async () => {
    vi.mocked(loadTenantAdminAccount).mockResolvedValue(null);
    vi.mocked(recordFirstTenantAdminAccount).mockResolvedValue({ username: 'dbadmin', password: 'theirs' });
    await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(vi.mocked(ensureTenantAdmin).mock.calls[0]![1]).toEqual({ username: 'dbadmin', password: 'theirs' });
  });

  it('a tenant administrator that cannot be set up keeps the login mode and says why; hardening is not recorded', async () => {
    vi.mocked(ensureTenantAdmin).mockRejectedValue(new Error('ERROR 1045: Access denied'));
    const o = await reconcileInstance(deps(fakeDb().db), mdFor());
    expect(o).toMatchObject({ mode: 'socket', detail: 'the tenant administrator account could not be set up: ERROR 1045: Access denied', rotated: false });
    expect(o.hardened).toBeUndefined();
  });

  describe('MongoDB', () => {
    const mongo = (over: Record<string, unknown> = {}) => mdFor({ engine: 'mongodb', ...over });
    beforeEach(() => {
      vi.mocked(buildDbContext).mockResolvedValue(dbCtx({ engine: 'mongodb', rootPassword: 'tenant-knew-this' }));
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'restricted', changed: [] });
    });

    it('the first time root is restricted, its password is replaced — and the new one kept BEFORE it is set', async () => {
      const order: string[] = [];
      const f = fakeDb();
      const insertSpy = f.db.insert.bind(f.db) as (t: unknown) => unknown;
      (f.db as unknown as { insert: unknown }).insert = (t: unknown) => { order.push('keep-secret'); return insertSpy(t); };
      vi.mocked(rotateRoot).mockImplementation(async () => { order.push('rotate'); return true; });
      vi.mocked(ensureTenantAdmin).mockImplementation(async (c) => { order.push(`ensure-with:${c.rootPassword}`); return { changes: [], problems: [] }; });
      const o = await reconcileInstance(deps(f.db), mongo());
      expect(order).toEqual(['keep-secret', 'rotate', 'ensure-with:fresh-platform-secret']);
      expect(o).toMatchObject({ rotated: true, mode: 'restricted' });
      expect(o.changes).toContain('root has a new password only the platform knows (the tenant knew the old one)');
      expect(f.upserts[0]!.values).toMatchObject({ deploymentId: 'dep-1', mode: 'restricted' });
      expect(f.upserts[0]!.values.rootSecretCipher).toEqual(expect.stringMatching(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/));
      expect(f.upserts[0]!.set).toEqual({ rootSecretCipher: f.upserts[0]!.values.rootSecretCipher });
      // the configuration now carries it
      expect(f.updates).toHaveLength(1);
    });

    it('a rotation that was cut off is retried with the SAME new password it kept before', async () => {
      const pending = 'kept-before-the-cut';
      const f = fakeDb();
      const prev = prevRow({ engine: 'mongodb', mode: 'restricted', rootSecretCipher: encrypt(pending, KEY) });
      vi.mocked(rotateRoot).mockImplementation(async (_x, next) => { expect(next).toBe(pending); return true; });
      const o = await reconcileInstance(deps(f.db), mongo(), prev);
      expect(o.rotated).toBe(true);
      expect(rotateRoot).toHaveBeenCalledTimes(1);
      expect(f.upserts[0]!.values.rootSecretCipher).toBe(prev.rootSecretCipher);
      expect(vi.mocked(ensureTenantAdmin).mock.calls[0]![0].rootPassword).toBe(pending);
    });

    it('a kept password that is already the configured one is not reused: a fresh one is made', async () => {
      const prev = prevRow({ engine: 'mongodb', mode: 'restricted', rootSecretCipher: encrypt('tenant-knew-this', KEY) });
      vi.mocked(rootLogsInWith).mockResolvedValue(true);
      await reconcileInstance(deps(fakeDb().db), mongo(), prev);
      expect(vi.mocked(rotateRoot).mock.calls[0]![1]).toBe('fresh-platform-secret');
    });

    it('a rotation whose proof fails is retried next time, and the rest goes on with the old password', async () => {
      vi.mocked(rotateRoot).mockResolvedValue(false);
      const f = fakeDb();
      const o = await reconcileInstance(deps(f.db), mongo());
      expect(o).toMatchObject({ rotated: false, detail: "root's password could not be replaced; the next check tries again" });
      expect(f.updates).toEqual([]);
      expect(vi.mocked(ensureTenantAdmin).mock.calls[0]![0].rootPassword).toBe('tenant-knew-this');
    });

    it('is not rotated twice', async () => {
      await reconcileInstance(deps(fakeDb().db), mongo(), prevRow({ engine: 'mongodb', mode: 'restricted', rootRotatedAt: at('2026-01-01T00:00:00Z') }));
      expect(rotateRoot).not.toHaveBeenCalled();
    });

    it('an app stack\'s root is never rotated (its app knows it)', async () => {
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [] });
      await reconcileInstance(deps(fakeDb().db), mongo({ standalone: false }));
      expect(rotateRoot).not.toHaveBeenCalled();
    });

    it('a configuration that lost the new password is put right when the platform\'s copy still logs in', async () => {
      const secret = 'platform-set-this';
      const prev = prevRow({ engine: 'mongodb', rootSecretCipher: encrypt(secret, KEY), rootRotatedAt: at('2026-01-01T00:00:00Z') });
      vi.mocked(rootLogsInWith).mockImplementation(async (_x, pw) => pw === secret);
      const f = fakeDb();
      const o = await reconcileInstance(deps(f.db), mongo(), prev);
      expect(o.changes).toContain("put root's password back into the configuration");
      expect(f.updates).toHaveLength(1);
      expect(vi.mocked(ensureDatabaseAdminAccess).mock.calls[0]![0].rootPassword).toBe(secret);
      expect(vi.mocked(ensureTenantAdmin).mock.calls[0]![0].rootPassword).toBe(secret);
    });

    it('nothing is put back while the configured password still logs in', async () => {
      const prev = prevRow({ engine: 'mongodb', rootSecretCipher: encrypt('platform-set-this', KEY), rootRotatedAt: at('2026-01-01T00:00:00Z') });
      vi.mocked(rootLogsInWith).mockResolvedValue(true);
      const f = fakeDb();
      const o = await reconcileInstance(deps(f.db), mongo(), prev);
      expect(f.updates).toEqual([]);
      expect(o.changes).not.toContain("put root's password back into the configuration");
    });

    it('nothing is put back when neither password logs in (that is a lockout for the next step to report)', async () => {
      const prev = prevRow({ engine: 'mongodb', rootSecretCipher: encrypt('platform-set-this', KEY), rootRotatedAt: at('2026-01-01T00:00:00Z') });
      vi.mocked(rootLogsInWith).mockResolvedValue(false);
      const f = fakeDb();
      await reconcileInstance(deps(f.db), mongo(), prev);
      expect(f.updates).toEqual([]);
    });

    it('with no kept secret there is nothing to recover', async () => {
      await reconcileInstance(deps(fakeDb().db), mongo(), prevRow({ engine: 'mongodb', rootRotatedAt: at('2026-01-01T00:00:00Z') }));
      expect(rootLogsInWith).not.toHaveBeenCalled();
    });
  });
});

// ─── reconcileDatabaseAdmin ─────────────────────────────────────────────────

describe('reconcileDatabaseAdmin', () => {
  const mdN = (n: number) => mdFor({ deploymentId: `dep-${n}`, deploymentName: `db${n}` });

  it('does nothing for no instances', async () => {
    expect(await reconcileDatabaseAdmin(deps(fakeDb().db), [])).toEqual({ checked: 0, changed: 0, locked: 0, unreachable: 0 });
  });

  it('records each instance, and never writes root_secret_cipher with the outcome', async () => {
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', rootSecretCipher: 'kept' })] });
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'socket', changed: ['something'] });
    const r = await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(r).toEqual({ checked: 1, changed: 1, locked: 0, unreachable: 0 });
    expect(f.upserts).toHaveLength(1);
    expect(f.upserts[0]!.values).toMatchObject({ deploymentId: 'dep-1', mode: 'socket', lastChanges: 'something' });
    expect(f.upserts[0]!.values).not.toHaveProperty('rootSecretCipher');
    expect(f.upserts[0]!.set).not.toHaveProperty('rootSecretCipher');
  });

  it('counts locked and unreachable instances', async () => {
    vi.mocked(ensureDatabaseAdminAccess)
      .mockResolvedValueOnce({ mode: 'locked', changed: [], detail: 'refused' })
      .mockRejectedValueOnce(new DbUnreachableError('restarting'));
    const r = await reconcileDatabaseAdmin(deps(fakeDb().db), [mdN(1), mdN(2)]);
    expect(r).toEqual({ checked: 2, changed: 0, locked: 1, unreachable: 1 });
  });

  it('a lockout is not announced the first time (it may be a restart)', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
    await reconcileDatabaseAdmin(deps(fakeDb().db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessLost).not.toHaveBeenCalled();
  });

  it('a lockout that has lasted five minutes is announced once, listing the instance, and marked alerted', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
    const lockedSince = new Date(NOW.getTime() - LOCKOUT_ALERT_AFTER_MS);
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', mode: 'locked', lockedSince })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessLost).toHaveBeenCalledTimes(1);
    const [, vars, key] = vi.mocked(notifyAdminTenantDatabaseAccessLost).mock.calls[0]!;
    expect(vars).toEqual({ count: '1', tenantList: ['Acme — db1 (mariadb): login refused — refused'] });
    expect(key).toBe(`db-admin-lost:dep-1@${lockedSince.getTime()}`);
    expect(f.updates).toEqual([{ table: databaseAdminState, values: { alertedAt: NOW } }]);
  });

  it('one notification for several instances locked out together', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
    const lockedSince = new Date(NOW.getTime() - 3_600_000);
    const f = fakeDb({ prev: [1, 2].map((n) => prevRow({ deploymentId: `dep-${n}`, mode: 'locked', lockedSince })) });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1), mdN(2)]);
    expect(notifyAdminTenantDatabaseAccessLost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAdminTenantDatabaseAccessLost).mock.calls[0]![1]).toMatchObject({ count: '2' });
  });

  it('a notification that did not go out is not marked alerted (the next pass tries again)', async () => {
    vi.mocked(notifyAdminTenantDatabaseAccessLost).mockResolvedValueOnce(false);
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', mode: 'locked', lockedSince: new Date(NOW.getTime() - 3_600_000) })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(f.updates).toEqual([]);
  });

  it('a notification that throws does not fail the pass', async () => {
    vi.mocked(notifyAdminTenantDatabaseAccessLost).mockRejectedValueOnce(new Error('smtp down'));
    vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', mode: 'locked', lockedSince: new Date(NOW.getTime() - 3_600_000) })] });
    await expect(reconcileDatabaseAdmin(deps(f.db), [mdN(1)])).resolves.toMatchObject({ locked: 1 });
    expect(f.updates).toEqual([]);
  });

  it('an alerted lockout that ended is announced as restored, once', async () => {
    const lockedSince = new Date(NOW.getTime() - 3_600_000);
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', mode: 'locked', lockedSince, alertedAt: new Date(NOW.getTime() - 3_000_000) })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessRestored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAdminTenantDatabaseAccessRestored).mock.calls[0]![1]).toEqual({ count: '1', tenantList: ['Acme — db1 (mariadb)'] });
    expect(vi.mocked(notifyAdminTenantDatabaseAccessRestored).mock.calls[0]![2]).toBe(`db-admin-restored:dep-1@${lockedSince.getTime()}`);
  });

  it('an unreachable instance mid-incident is not announced as restored', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new DbUnreachableError('restarting'));
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'dep-1', mode: 'locked', lockedSince: new Date(NOW.getTime() - 3_600_000), alertedAt: NOW })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessRestored).not.toHaveBeenCalled();
    // and what was known is kept
    expect(f.upserts[0]!.values).toMatchObject({ mode: 'locked', alertedAt: NOW });
  });

  it('one instance whose bookkeeping fails does not stop the rest', async () => {
    const f = fakeDb({ failUpsertFor: 'dep-1' });
    const r = await reconcileDatabaseAdmin(deps(f.db), [mdN(1), mdN(2)]);
    expect(r.checked).toBe(2);
    expect(f.upserts.map((u) => u.values.deploymentId)).toEqual(['dep-2']);
  });

  it('a second pass over an instance another run holds the lease for skips it: nothing is checked or recorded for it', async () => {
    let release: (() => void) | undefined;
    vi.mocked(buildDbContext).mockImplementation(() => new Promise((resolve) => { release = () => resolve(dbCtx()); }));
    const f = fakeDb();
    const a = reconcileDatabaseAdmin(deps(f.db), [mdN(7)]);
    await vi.waitFor(() => expect(release).toBeDefined());
    const b = await reconcileDatabaseAdmin(deps(f.db), [mdN(7)]);
    expect(b).toEqual({ checked: 1, changed: 0, locked: 0, unreachable: 0 });
    release!();
    await a;
    expect(buildDbContext).toHaveBeenCalledTimes(1);
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(1);
    expect(f.upserts).toHaveLength(1);
  });

  it('each instance runs under its own lease, long enough for the time limit, released when done', async () => {
    await reconcileDatabaseAdmin(deps(fakeDb().db), [mdN(9)]);
    expect(withSchedulerLease).toHaveBeenCalledWith(expect.anything(), 'database-admin:dep-9', 2 * 5 * 60 * 1000, expect.any(Function),
      { release: true, maxHoldMs: Infinity, startupRetry: false });
  });

  it('an instance whose lease is held elsewhere is not recorded and not counted as unreachable', async () => {
    vi.mocked(withSchedulerLease).mockResolvedValueOnce({ ran: false });
    const f = fakeDb();
    const r = await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(r).toEqual({ checked: 1, changed: 0, locked: 0, unreachable: 0 });
    expect(f.upserts).toEqual([]);
    expect(ensureDatabaseAdminAccess).not.toHaveBeenCalled();
  });

  it('a pass after the first has finished checks again', async () => {
    const f = fakeDb();
    await reconcileDatabaseAdmin(deps(f.db), [mdN(8)]);
    await reconcileDatabaseAdmin(deps(f.db), [mdN(8)]);
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileDatabaseAdmin — unreachable incidents, concurrency, limits', () => {
  const mdN = (n: number) => mdFor({ deploymentId: `lim-${n}`, deploymentName: `db${n}` });
  const hourAgo = (extraMs = 0): Date => new Date(NOW.getTime() - UNREACHABLE_ALERT_AFTER_MS - extraMs);

  // The row keeps the last known mode while unreachable; the reason follows the incident's clock.
  it('an instance silent for an hour is announced once, with what is known', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new DbUnreachableError('restarting'));
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', mode: 'socket', unreachableSince: hourAgo() })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessLost).toHaveBeenCalledTimes(1);
    const [, vars, key] = vi.mocked(notifyAdminTenantDatabaseAccessLost).mock.calls[0]!;
    expect(vars).toEqual({ count: '1', tenantList: ['Acme — db1 (mariadb): no answer for over an hour — restarting'] });
    expect(key).toBe(`db-admin-lost:lim-1@${hourAgo().getTime()}`);
    expect(f.updates).toEqual([{ table: databaseAdminState, values: { alertedAt: NOW } }]);
  });

  it('one minute short of the hour is not announced', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new DbUnreachableError('restarting'));
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', unreachableSince: hourAgo(-60_000) })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessLost).not.toHaveBeenCalled();
  });

  it('the first miss starts the clock and announces nothing', async () => {
    vi.mocked(ensureDatabaseAdminAccess).mockRejectedValue(new DbUnreachableError('restarting'));
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'lim-1' })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(f.upserts[0]!.values).toMatchObject({ unreachableSince: NOW, alertedAt: null });
    expect(notifyAdminTenantDatabaseAccessLost).not.toHaveBeenCalled();
  });

  it('an instance that answers again after an announced silence is announced as restored, once', async () => {
    const since = hourAgo(60_000);
    const f = fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', mode: 'socket', unreachableSince: since, alertedAt: new Date(NOW.getTime() - 600_000) })] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1)]);
    expect(notifyAdminTenantDatabaseAccessRestored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAdminTenantDatabaseAccessRestored).mock.calls[0]![2]).toBe(`db-admin-restored:lim-1@${since.getTime()}`);
    expect(f.upserts[0]!.values).toMatchObject({ unreachableSince: null, alertedAt: null });
  });

  it('a lockout and a silence listed together are one notification, each with its own reason', async () => {
    vi.mocked(ensureDatabaseAdminAccess)
      .mockResolvedValueOnce({ mode: 'locked', changed: [], detail: 'refused' })
      .mockRejectedValueOnce(new DbUnreachableError('no route'));
    const f = fakeDb({ prev: [
      prevRow({ deploymentId: 'lim-1', mode: 'locked', lockedSince: new Date(NOW.getTime() - 3_600_000) }),
      prevRow({ deploymentId: 'lim-2', unreachableSince: hourAgo() }),
    ] });
    await reconcileDatabaseAdmin(deps(f.db), [mdN(1), mdN(2)]);
    expect(notifyAdminTenantDatabaseAccessLost).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAdminTenantDatabaseAccessLost).mock.calls[0]![1]).toEqual({
      count: '2',
      tenantList: ['Acme — db1 (mariadb): login refused — refused', 'Acme — db2 (mariadb): no answer for over an hour — no route'],
    });
  });

  it('checks four instances at a time, never more, and finishes all of them', async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(buildDbContext).mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return dbCtx();
    });
    const f = fakeDb();
    const pass = reconcileDatabaseAdmin(deps(f.db), [1, 2, 3, 4, 5, 6, 7].map((n) => mdFor({ deploymentId: `par-${n}`, deploymentName: `p${n}` })));
    await vi.waitFor(() => expect(active).toBe(4));
    await new Promise((r) => setTimeout(r, 20));
    expect(active).toBe(4);
    release();
    const result = await pass;
    expect(result.checked).toBe(7);
    expect(peak).toBe(4);
    expect(f.upserts).toHaveLength(7);
  });

  it('an instance that hangs is given up on after five minutes: unreachable, the rest unaffected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(buildDbContext).mockImplementation(async (_k8s, _kc, _ns, name) => (name === 'db1' ? new Promise<DbManagerContext>(() => {}) : dbCtx()));
      const f = fakeDb();
      const pass = reconcileDatabaseAdmin(deps(f.db), [mdFor({ deploymentId: 'hang-1', deploymentName: 'db1' }), mdFor({ deploymentId: 'hang-2', deploymentName: 'db2' })]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      const result = await pass;
      expect(result).toMatchObject({ checked: 2, unreachable: 1 });
      const hung = f.upserts.find((u) => u.values.deploymentId === 'hang-1')!;
      expect(hung.values).toMatchObject({ mode: 'unreachable', detail: 'the check took longer than 5 minutes' });
      expect(f.upserts.find((u) => u.values.deploymentId === 'hang-2')!.values).toMatchObject({ mode: 'socket' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the instance given up on keeps its lease while its run is still pending: no second run starts beside it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.mocked(buildDbContext).mockImplementationOnce(() => new Promise<DbManagerContext>(() => {}));
      const f = fakeDb();
      const first = reconcileDatabaseAdmin(deps(f.db), [mdFor({ deploymentId: 'hang-3' })]);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await first;
      const again = await reconcileDatabaseAdmin(deps(f.db), [mdFor({ deploymentId: 'hang-3' })]);
      expect(again.unreachable).toBe(0);
      expect(buildDbContext).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('what is logged', () => {
    it('the password login is logged when it comes about, not on every tick', async () => {
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'password', changed: [], detail: 'an app stack' });
      await reconcileDatabaseAdmin(deps(fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', mode: 'socket' })] }).db), [mdN(1)]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0]![0]).toContain('password — an app stack');
      vi.mocked(console.warn).mockClear();
      await reconcileDatabaseAdmin(deps(fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', mode: 'password' })] }).db), [mdN(1)]);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('a lockout is an error on every check', async () => {
      vi.mocked(ensureDatabaseAdminAccess).mockResolvedValue({ mode: 'locked', changed: [], detail: 'refused' });
      await reconcileDatabaseAdmin(deps(fakeDb({ prev: [prevRow({ deploymentId: 'lim-1', mode: 'locked', lockedSince: NOW })] }).db), [mdN(1)]);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('the platform cannot log in as administrator — refused'));
    });
  });
});

// ─── reconcileDatabaseAdminFor / listManagedDatabases ───────────────────────

describe('listManagedDatabases', () => {
  const row = (id: string, status: string, type: string, components: unknown, tenantName = 'Acme') => ({
    d: { id, name: `n-${id}`, tenantId: 'ten-1', configuration: JSON.stringify({ A: '1' }), status, extraMounts: id === 'a' ? [{ hostPath: '/x' }] : null },
    e: { type, code: 'x', components },
    tenantName,
  });

  it('keeps instances with a managed database component, noting whether each is standalone', async () => {
    const f = fakeDb({ managed: [
      row('a', 'running', 'database', JSON.stringify([{ name: 'main', database: 'postgresql' }])),
      row('b', 'running', 'application', [{ name: 'web' }, { name: 'db', database: 'mariadb' }]),
      row('c', 'running', 'application', [{ name: 'web' }]),
      row('d', 'running', 'database', [{ name: 'x', database: 'redis' }]),
      row('e', 'running', 'database', null),
    ] });
    const list = await listManagedDatabases(f.db);
    expect(list.map((m) => [m.deploymentId, m.engine, m.componentName, m.standalone])).toEqual([
      ['a', 'postgresql', 'main', true],
      ['b', 'mariadb', 'db', false],
    ]);
    expect(list[0]).toMatchObject({ deploymentName: 'n-a', tenantName: 'Acme', configuration: { A: '1' }, extraMountCount: 1 });
    expect(list[1]).toMatchObject({ extraMountCount: 0 });
  });
});

describe('reconcileDatabaseAdminFor', () => {
  const managedRow = (id: string) => ({
    d: { id, name: `n-${id}`, tenantId: 'ten-1', configuration: '{}', status: 'running' },
    e: { type: 'database', code: 'mariadb-11', components: [{ name: 'main', database: 'mariadb' }] },
    tenantName: 'Acme',
  });
  const at0 = (ms: number): (() => Date) => () => new Date(NOW.getTime() + ms);

  it('handles the deployment now, and ignores a second request within 30 seconds', async () => {
    const f = fakeDb({ managed: [managedRow('od-1')] });
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(0) }), 'od-1');
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(ON_DEMAND_MIN_INTERVAL_MS - 1) }), 'od-1');
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(1);
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(ON_DEMAND_MIN_INTERVAL_MS) }), 'od-1');
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(2);
  });

  it('is 30 seconds', () => expect(ON_DEMAND_MIN_INTERVAL_MS).toBe(30_000));

  it('another deployment is not held back by this one', async () => {
    const f = fakeDb({ managed: [managedRow('od-2')] });
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(0) }), 'od-2');
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(1) }), 'od-3');
    expect(ensureDatabaseAdminAccess).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a deployment that is not a running managed database', async () => {
    await reconcileDatabaseAdminFor(deps(fakeDb({ managed: [] }).db, { now: at0(0) }), 'od-4');
    expect(buildDbContext).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const broken = { select: () => { throw new Error('connection refused'); } } as unknown as Database;
    await expect(reconcileDatabaseAdminFor(deps(broken, { now: at0(0) }), 'od-5')).resolves.toBeUndefined();
  });

  it('a request while the same instance is being checked is ignored', async () => {
    let release: (() => void) | undefined;
    vi.mocked(buildDbContext).mockImplementation(() => new Promise((resolve) => { release = () => resolve(dbCtx()); }));
    const f = fakeDb({ managed: [managedRow('od-6')] });
    const running = reconcileDatabaseAdmin(deps(f.db), [{ ...mdFor(), deploymentId: 'od-6' }]);
    await vi.waitFor(() => expect(release).toBeDefined());
    // the lease is held: the on-demand run finds nothing to do
    await reconcileDatabaseAdminFor(deps(f.db, { now: at0(0) }), 'od-6');
    release!();
    await running;
    expect(buildDbContext).toHaveBeenCalledTimes(1);
  });
});
