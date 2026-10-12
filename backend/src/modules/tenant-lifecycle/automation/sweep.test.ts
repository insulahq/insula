import { describe, expect, it } from 'vitest';
import type { TenantAutomationRun, TenantAutomationSettings } from '@insula/api-contracts';
import { runTenantAutomationSweep, type ActionOutcome, type InLineTenant, type SweepIo, type TellOutcome } from './sweep.js';

/**
 * What the automatic archive/delete sweep decides — against a fake of
 * everything it touches, so each case states exactly what the world looks
 * like and what the sweep then does to it.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00.000Z');

/** Both steps off, and nobody told: a tenant is acted on as soon as it is past its limit. */
const OFF: TenantAutomationSettings = {
  autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90, noticeDays: 0,
};

/** A notice as the fake world holds it: told so many days ago, for a date so many days from NOW (negative: past). */
interface FakeNotice { readonly toldDaysAgo: number; readonly dateInDays: number; readonly reached?: boolean }

interface World {
  settings: TenantAutomationSettings;
  archiveRetentionDays: number;
  /** tenant → the day it was suspended / archived, as days before NOW. */
  suspended: Record<string, number>;
  archived: Record<string, number>;
  /** tenant → what it was told, per step. */
  archiveNotices: Record<string, FakeNotice>;
  deleteNotices: Record<string, FakeNotice>;
  tellOutcome: Record<string, TellOutcome | Error>;
  blocked: string | null;
  archiveOutcome: Record<string, ActionOutcome | Error>;
  removeOutcome: Record<string, ActionOutcome | Error>;
  notifyFails: boolean;
  /** Called before every read of the settings; a test changes the world in it. */
  onSettingsRead?: (reads: number) => void;
  listArchiveFails?: boolean;
  listDeleteFails?: boolean;
  recordFails?: boolean;
}

function world(over: Partial<World> = {}): World {
  return {
    settings: OFF, archiveRetentionDays: 90, suspended: {}, archived: {}, blocked: null,
    archiveNotices: {}, deleteNotices: {}, tellOutcome: {},
    archiveOutcome: {}, removeOutcome: {}, notifyFails: false, ...over,
  };
}

function harness(w: World) {
  const calls: string[] = [];
  const recorded: TenantAutomationRun[] = [];
  const notified: TenantAutomationRun[] = [];
  const log: string[] = [];
  // Everybody in the status, oldest first — what is due among them is the sweep's to decide.
  const inLine = (set: Record<string, number>, notices: Record<string, FakeNotice>): InLineTenant[] => Object.entries(set)
    .sort(([, a], [, b]) => b - a)
    .map(([name, daysAgo]) => {
      const n = notices[name];
      return {
        tenantId: `id-${name}`,
        name,
        since: new Date(NOW.getTime() - daysAgo * DAY),
        notice: n ? { toldAt: new Date(NOW.getTime() - n.toldDaysAgo * DAY), date: new Date(NOW.getTime() + n.dateInDays * DAY), reached: n.reached ?? true } : null,
      };
    });
  const outcome = (o: ActionOutcome | Error | undefined): ActionOutcome => {
    if (o instanceof Error) throw o;
    return o ?? { kind: 'done' };
  };
  let reads = 0;
  const io: { -readonly [K in keyof SweepIo]: SweepIo[K] } = {
    settings: async () => { reads += 1; w.onSettingsRead?.(reads); return w.settings; },
    archiveRetentionDays: async () => w.archiveRetentionDays,
    inLine: async (step) => {
      calls.push(`list-${step}`);
      if (step === 'archive' ? w.listArchiveFails : w.listDeleteFails) throw new Error('the database did not answer');
      return step === 'archive' ? inLine(w.suspended, w.archiveNotices) : inLine(w.archived, w.deleteNotices);
    },
    tell: async (step, tenant, date) => {
      calls.push(`tell ${tenant.name}: ${step} on ${date.toISOString().slice(0, 10)}`);
      const o = w.tellOutcome[tenant.name];
      if (o instanceof Error) throw o;
      return o ?? { kind: 'told', reached: true };
    },
    archiveBlockedReason: async () => { calls.push('blocked?'); return w.blocked; },
    archive: async (tenant, opts) => {
      calls.push(`archive ${tenant.name} keep=${opts.retentionDays} before=${opts.suspendedBefore.toISOString().slice(0, 10)}`);
      return outcome(w.archiveOutcome[tenant.name]);
    },
    remove: async (tenant, opts) => {
      calls.push(`delete ${tenant.name} before=${opts.archivedBefore.toISOString().slice(0, 10)}`);
      return outcome(w.removeOutcome[tenant.name]);
    },
    record: async (run) => { if (w.recordFails) throw new Error('the database did not answer'); recorded.push(run); },
    notify: async (run) => { if (w.notifyFails) throw new Error('mail is down'); notified.push(run); },
    now: () => NOW,
    log: (line) => { log.push(line); },
  };
  return { io, calls, recorded, notified, log };
}

const names = (list: ReadonlyArray<{ name: string }>): string[] => list.map((t) => t.name);

describe('the automatic archive/delete sweep', () => {
  it('does nothing — reads no tenant at all — while both steps are off, and still records that it ran', async () => {
    const h = harness(world({ suspended: { old: 400 }, archived: { older: 900 } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual([]);
    expect(run).toMatchObject({ trigger: 'schedule', archived: [], deleted: [], told: [], failed: [], archiveSkippedReason: null, errors: [] });
    expect(h.recorded).toEqual([run]);
    expect(h.notified).toEqual([]);
  });

  it('archives the tenants suspended for longer than the limit, the longest-suspended first, and no other', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true },
      suspended: { recent: 29, old: 45, oldest: 200 },
      archived: { ancient: 900 },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual([
      'list-archive', 'blocked?',
      'archive oldest keep=90 before=2026-05-16',
      'archive old keep=90 before=2026-05-16',
    ]);
    expect(names(run.archived)).toEqual(['oldest', 'old']);
    expect(run.deleted).toEqual([]);          // the delete step is off
  });

  it('works through its tenants one at a time: the next archive starts only when the one before has ended', async () => {
    const h = harness(world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: { first: 90, second: 60, third: 45 } }));
    const events: string[] = [];
    let running = 0;
    let most = 0;
    h.io.archive = async (tenant) => {
      running += 1;
      most = Math.max(most, running);
      events.push(`start ${tenant.name}`);
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      events.push(`end ${tenant.name}`);
      running -= 1;
      return { kind: 'done' };
    };
    await runTenantAutomationSweep(h.io, 'schedule');
    expect(most).toBe(1);
    expect(events).toEqual(['start first', 'end first', 'start second', 'end second', 'start third', 'end third']);
  });

  it('a tenant suspended for exactly the limit is not due yet; a moment longer and it is', async () => {
    const settings = { ...OFF, autoArchiveEnabled: true };
    const exactly = harness(world({ settings, suspended: { edge: 30 } }));
    expect((await runTenantAutomationSweep(exactly.io, 'schedule')).archived).toEqual([]);
    const past = harness(world({ settings, suspended: { edge: 30 + 1 / 86_400 } }));
    expect(names((await runTenantAutomationSweep(past.io, 'schedule')).archived)).toEqual(['edge']);
  });

  it('deletes the tenants archived for longer than the delete limit', async () => {
    const h = harness(world({
      settings: { ...OFF, autoDeleteEnabled: true, autoDeleteAfterDays: 60 },
      suspended: { old: 400 },
      archived: { fresh: 59, stale: 61 },
    }));
    const run = await runTenantAutomationSweep(h.io, 'manual');
    expect(h.calls).toEqual(['list-delete', 'delete stale before=2026-04-16']);
    expect(names(run.deleted)).toEqual(['stale']);
    expect(run.trigger).toBe('manual');
  });

  it('keeps an archive for the platform\'s archive retention — or for the delete limit, when automatic delete is on and longer', async () => {
    const suspended = { old: 45 };
    const plain = harness(world({ settings: { ...OFF, autoArchiveEnabled: true, autoDeleteAfterDays: 400 }, suspended, archiveRetentionDays: 90 }));
    await runTenantAutomationSweep(plain.io, 'schedule');
    expect(plain.calls.at(-1)).toContain('keep=90');           // delete is off: its limit means nothing

    const longer = harness(world({ settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true, autoDeleteAfterDays: 400 }, suspended, archiveRetentionDays: 90 }));
    await runTenantAutomationSweep(longer.io, 'schedule');
    expect(longer.calls.find((c) => c.startsWith('archive'))).toContain('keep=400');   // must not expire before the tenant is deleted

    const shorter = harness(world({ settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true, autoDeleteAfterDays: 14 }, suspended, archiveRetentionDays: 90 }));
    await runTenantAutomationSweep(shorter.io, 'schedule');
    expect(shorter.calls.find((c) => c.startsWith('archive'))).toContain('keep=90');
  });

  it('when no archive can be taken, archives nobody, says why — and still deletes what is due', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true },
      suspended: { old: 45 },
      archived: { stale: 200 },
      blocked: 'No backup target is assigned to tenant snapshots.',
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('archive'))).toEqual([]);
    expect(run.archiveSkippedReason).toBe('No backup target is assigned to tenant snapshots.');
    expect(names(run.deleted)).toEqual(['stale']);
    expect(h.notified).toHaveLength(1);
  });

  it('does not ask whether an archive can be taken when nobody is due', async () => {
    const h = harness(world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: { recent: 3 }, blocked: 'no target' }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual(['list-archive']);
    expect(run.archiveSkippedReason).toBeNull();
    expect(h.notified).toEqual([]);
  });

  it('a tenant that is no longer due, or busy, is left alone: neither done nor failed, and the sweep goes on', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true },
      suspended: { resumed: 60, fine: 50 },
      archived: { restoring: 300, gone: 200 },
      archiveOutcome: { resumed: { kind: 'skipped', reason: 'no longer suspended' } },
      removeOutcome: { restoring: { kind: 'skipped', reason: 'a restoring operation is in progress' } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.archived)).toEqual(['fine']);
    expect(names(run.deleted)).toEqual(['gone']);
    expect(run.failed).toEqual([]);
    expect(h.log).toContain('left resumed (id-resumed) alone: no longer suspended');
  });

  it('a failure — reported or thrown — is recorded with its reason and does not stop the tenants after it', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true },
      suspended: { a: 60, b: 50, c: 40 },
      archived: { x: 300, y: 200 },
      archiveOutcome: { a: { kind: 'failed', error: 'the backup target did not answer' }, b: new Error('boom') },
      removeOutcome: { x: new Error('namespace would not go') },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.archived)).toEqual(['c']);
    expect(names(run.deleted)).toEqual(['y']);
    expect(run.failed).toEqual([
      { tenantId: 'id-a', name: 'a', action: 'archive', error: 'the backup target did not answer' },
      { tenantId: 'id-b', name: 'b', action: 'archive', error: 'boom' },
      { tenantId: 'id-x', name: 'x', action: 'delete', error: 'namespace would not go' },
    ]);
    expect(h.notified).toEqual([run]);
  });

  it('a tenant archived by this sweep is not deleted by it, however short the delete limit', async () => {
    // The fake lists what was archived BEFORE the sweep; a real archive stamps
    // "now", which is never before a limit counted back from the sweep's start.
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoArchiveAfterDays: 30, autoDeleteEnabled: true, autoDeleteAfterDays: 1 },
      suspended: { old: 45 },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.archived)).toEqual(['old']);
    expect(h.calls.filter((c) => c.startsWith('delete'))).toEqual([]);
    expect(h.calls.find((c) => c === 'list-delete')).toBeTruthy();
  });

  // ── a sweep lasts hours; the settings may change under it ────────────────

  it('a step switched off during the sweep stops before the next tenant', async () => {
    const w = world({ settings: { ...OFF, autoDeleteEnabled: true }, archived: { a: 400, b: 300, c: 200 } });
    const h = harness(w);
    // The admin sees the first delete on the card and switches the step off.
    h.io.remove = async (tenant) => { h.calls.push(`delete ${tenant.name}`); w.settings = { ...w.settings, autoDeleteEnabled: false }; return { kind: 'done' }; };
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('delete'))).toEqual(['delete a']);
    expect(names(run.deleted)).toEqual(['a']);
    expect(run.failed).toEqual([]);
    expect(h.log.some((l) => l.includes('the delete step was switched off during the sweep: stopped before b, 2 tenant(s) left as they are'))).toBe(true);
  });

  it('a limit raised during the sweep is the one the next tenant is held to', async () => {
    const w = world({ settings: { ...OFF, autoDeleteEnabled: true, autoDeleteAfterDays: 1 }, archived: { a: 400, b: 5 } });
    const h = harness(w);
    const limits: string[] = [];
    // "1 day" was a slip; the admin corrects it to 90 while the sweep is at its first tenant.
    h.io.remove = async (tenant, opts) => {
      limits.push(`${tenant.name} before=${opts.archivedBefore.toISOString().slice(0, 10)}`);
      w.settings = { ...w.settings, autoDeleteAfterDays: 90 };
      return { kind: 'done' };
    };
    await runTenantAutomationSweep(h.io, 'schedule');
    // a was held to the longer of the two limits — the one stored when its turn
    // came. b, archived 5 days ago, was due under the slip and is not under the
    // correction: nothing is asked of it at all.
    expect(limits).toEqual(['a before=2026-06-14']);
  });

  it('a limit raised before a tenant\'s turn holds that tenant to the raised limit', async () => {
    const w = world({ settings: { ...OFF, autoDeleteEnabled: true, autoDeleteAfterDays: 1 }, archived: { a: 400, b: 200 } });
    const h = harness(w);
    const limits: string[] = [];
    h.io.remove = async (tenant, opts) => {
      limits.push(`${tenant.name} before=${opts.archivedBefore.toISOString().slice(0, 10)}`);
      w.settings = { ...w.settings, autoDeleteAfterDays: 90 };
      return { kind: 'done' };
    };
    await runTenantAutomationSweep(h.io, 'schedule');
    // b is past both limits; its delete checks it against the 90 days stored now.
    expect(limits).toEqual(['a before=2026-06-14', 'b before=2026-03-17']);
  });

  it('a limit lowered during the sweep reaches nobody the list did not hold: the list\'s limit stays the bound', async () => {
    const w = world({ settings: { ...OFF, autoDeleteEnabled: true, autoDeleteAfterDays: 90 }, archived: { a: 400, b: 300 } });
    const h = harness(w);
    const limits: string[] = [];
    h.io.remove = async (_tenant, opts) => {
      limits.push(opts.archivedBefore.toISOString().slice(0, 10));
      w.settings = { ...w.settings, autoDeleteAfterDays: 1 };
      return { kind: 'done' };
    };
    await runTenantAutomationSweep(h.io, 'schedule');
    expect(limits).toEqual(['2026-03-17', '2026-03-17']);
  });

  it('an archive is kept for what the settings say when it is taken, not when the sweep began', async () => {
    const w = world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: { a: 90, b: 60 }, archiveRetentionDays: 90 });
    const h = harness(w);
    const kept: number[] = [];
    h.io.archive = async (_tenant, opts) => {
      kept.push(opts.retentionDays);
      w.settings = { ...w.settings, autoDeleteEnabled: true, autoDeleteAfterDays: 400 };
      return { kind: 'done' };
    };
    await runTenantAutomationSweep(h.io, 'schedule');
    expect(kept).toEqual([90, 400]);
  });

  // ── a step that cannot go on ─────────────────────────────────────────────

  it('a step that cannot list its tenants is recorded as stopped, and the other step still runs', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true },
      suspended: { old: 45 }, archived: { stale: 200 }, listArchiveFails: true,
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(run.errors).toEqual(['The archive step stopped: the database did not answer']);
    expect(names(run.deleted)).toEqual(['stale']);
    expect(h.recorded).toEqual([run]);
    expect(h.notified).toEqual([run]);
  });

  it('what was done before a step stopped is still recorded and told', async () => {
    const w = world({ settings: { ...OFF, autoDeleteEnabled: true }, archived: { a: 400, b: 300 } });
    const h = harness(w);
    // The settings cannot be read any more once the first tenant is gone.
    w.onSettingsRead = (reads) => { if (reads > 3) throw new Error('the database did not answer'); };
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.deleted)).toEqual(['a']);
    expect(run.errors).toEqual(['The delete step stopped: the database did not answer']);
    expect(h.recorded).toEqual([run]);
    expect(h.notified).toEqual([run]);
  });

  it('with the settings unreadable it touches nothing and says so', async () => {
    const h = harness(world({ suspended: { old: 400 }, archived: { older: 900 }, onSettingsRead: () => { throw new Error('the database did not answer'); } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual([]);
    expect(run.errors).toEqual([
      'The archive step stopped: the database did not answer',
      'The delete step stopped: the database did not answer',
    ]);
    expect(h.notified).toEqual([run]);
  });

  it('a run that cannot be written down is still told to the admins', async () => {
    const h = harness(world({ settings: { ...OFF, autoDeleteEnabled: true }, archived: { stale: 200 }, recordFails: true }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.deleted)).toEqual(['stale']);
    expect(h.recorded).toEqual([]);
    expect(h.notified).toEqual([run]);
    expect(h.log.some((l) => l.includes('could not record the run: the database did not answer'))).toBe(true);
  });

  it('tells the admins only when it did, or could not do, something', async () => {
    const quiet = harness(world({ settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true }, suspended: { recent: 2 } }));
    await runTenantAutomationSweep(quiet.io, 'schedule');
    expect(quiet.notified).toEqual([]);
    expect(quiet.recorded).toHaveLength(1);

    const busy = harness(world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: { old: 45 } }));
    await runTenantAutomationSweep(busy.io, 'schedule');
    expect(busy.notified).toHaveLength(1);
  });

  it('a notification that cannot be sent is logged and does not fail the sweep it reports', async () => {
    const h = harness(world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended: { old: 45 }, notifyFails: true }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.archived)).toEqual(['old']);
    expect(h.recorded).toEqual([run]);
    expect(h.log.some((l) => l.includes('could not notify the admins: mail is down'))).toBe(true);
  });

  it('stores at most fifty names per list', async () => {
    const suspended = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${String(i).padStart(2, '0')}`, 100 + i]));
    const h = harness(world({ settings: { ...OFF, autoArchiveEnabled: true }, suspended }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('archive'))).toHaveLength(60);
    expect(run.archived).toHaveLength(50);
  });

  // ── a notice period: told first, acted on at the date given ──────────────

  const NOTICE: TenantAutomationSettings = { ...OFF, autoArchiveEnabled: true, noticeDays: 7 };

  it('with a notice period, a tenant coming within it of its limit is told, given that many days, and not archived', async () => {
    // Suspended 25 days ago under a 30-day limit: 5 days to go, inside the 7.
    // It is given 7 from today — two days past its limit, never before it.
    const h = harness(world({ settings: NOTICE, suspended: { soon: 25, far: 10 } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual(['list-archive', 'blocked?', 'tell soon: archive on 2026-06-22']);
    expect(run.told).toEqual([{ tenantId: 'id-soon', name: 'soon', action: 'archive', date: '2026-06-22T12:00:00.000Z', reached: true }]);
    expect(run.archived).toEqual([]);
    expect(h.notified).toEqual([run]);       // somebody was written to: the admins hear of it
  });

  it('a tenant is told at the run that finds it exactly a notice period from its limit, and not at one before', async () => {
    const at = harness(world({ settings: NOTICE, suspended: { edge: 23 } }));
    expect(names((await runTenantAutomationSweep(at.io, 'schedule')).told)).toEqual(['edge']);
    const before = harness(world({ settings: NOTICE, suspended: { edge: 23 - 1 / 86_400 } }));
    expect((await runTenantAutomationSweep(before.io, 'schedule')).told).toEqual([]);
  });

  it('a tenant already past its limit when nobody has told it is told now, and given the whole notice period', async () => {
    const h = harness(world({ settings: NOTICE, suspended: { overdue: 400 } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => !c.startsWith('list') && c !== 'blocked?')).toEqual(['tell overdue: archive on 2026-06-22']);
    expect(run.archived).toEqual([]);
  });

  it('a tenant that was told is archived once its date has come, and not a day before', async () => {
    const h = harness(world({
      settings: NOTICE,
      suspended: { due: 45, waiting: 44 },
      archiveNotices: { due: { toldDaysAgo: 8, dateInDays: -1 }, waiting: { toldDaysAgo: 2, dateInDays: 5 } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('archive') || c.startsWith('tell'))).toEqual(['archive due keep=90 before=2026-05-16']);
    expect(names(run.archived)).toEqual(['due']);
    expect(run.told).toEqual([]);            // `waiting` has its notice; it is not told twice
  });

  it('a notice from an earlier suspension does not count: the tenant is told again', async () => {
    // Told 60 days ago, resumed, suspended again 40 days ago.
    const h = harness(world({ settings: NOTICE, suspended: { again: 40 }, archiveNotices: { again: { toldDaysAgo: 60, dateInDays: -53 } } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(run.archived).toEqual([]);
    expect(names(run.told)).toEqual(['again']);
  });

  it('…also when the old date happens to lie after this suspension\'s limit: it is told, not archived', async () => {
    // A 3-day limit under a 7-day notice. Told five days ago, resumed,
    // suspended again four days ago; the date it was given then passed half a
    // day ago, which is after the new limit.
    const h = harness(world({
      settings: { ...NOTICE, autoArchiveAfterDays: 3 },
      suspended: { again: 4 },
      archiveNotices: { again: { toldDaysAgo: 5, dateInDays: -0.5 } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('archive'))).toEqual([]);
    expect(names(run.told)).toEqual(['again']);
  });

  it('a limit raised after the notice went out makes the notice void: nothing is done on the old date', async () => {
    // Told "archive on the 14th" under a 30-day limit; the limit is 60 days now and the tenant is 45 days in.
    const h = harness(world({
      settings: { ...NOTICE, autoArchiveAfterDays: 60 },
      suspended: { reprieved: 45 },
      archiveNotices: { reprieved: { toldDaysAgo: 8, dateInDays: -1 } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual(['list-archive']);     // not due, and its new limit is still 15 days off
    expect(run.archived).toEqual([]);
    expect(run.told).toEqual([]);
  });

  it('a limit lowered after the notice went out leaves the date the tenant was given', async () => {
    const h = harness(world({
      settings: { ...NOTICE, autoArchiveAfterDays: 10 },
      suspended: { promised: 28 },
      archiveNotices: { promised: { toldDaysAgo: 5, dateInDays: 2 } },   // "in a week", said five days ago
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(run.archived).toEqual([]);
    expect(run.told).toEqual([]);
  });

  it('with the notice period set to nothing afterwards, a tenant that was given a date keeps it; one that was not is archived', async () => {
    const h = harness(world({
      settings: { ...NOTICE, noticeDays: 0 },
      suspended: { promised: 45, untold: 44 },
      archiveNotices: { promised: { toldDaysAgo: 1, dateInDays: 6 } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.archived)).toEqual(['untold']);
    expect(run.told).toEqual([]);            // nobody is told any more
  });

  it('tells nobody of an archive that cannot be taken', async () => {
    const h = harness(world({ settings: NOTICE, suspended: { soon: 25 }, blocked: 'No backup target is assigned to tenant snapshots.' }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual(['list-archive', 'blocked?']);
    expect(run.told).toEqual([]);
    expect(run.archiveSkippedReason).toBe('No backup target is assigned to tenant snapshots.');
  });

  it('the delete step tells and waits in the same way', async () => {
    const h = harness(world({
      settings: { ...OFF, autoDeleteEnabled: true, noticeDays: 14 },
      archived: { told: 120, untold: 100, early: 80 },
      deleteNotices: { told: { toldDaysAgo: 20, dateInDays: -6 } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls).toEqual([
      'list-delete',
      'delete told before=2026-03-17',
      'tell untold: delete on 2026-06-29',
      'tell early: delete on 2026-06-29',     // 10 days from its limit: inside the 14, and given the full 14
    ]);
    expect(names(run.deleted)).toEqual(['told']);
    expect(run.told.map((t) => `${t.name}:${t.action}`)).toEqual(['untold:delete', 'early:delete']);
  });

  it('a message that reached nobody is recorded as such, and the admins hear of it', async () => {
    const h = harness(world({ settings: NOTICE, suspended: { silent: 45 }, tellOutcome: { silent: { kind: 'told', reached: false } } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(run.told).toEqual([{ tenantId: 'id-silent', name: 'silent', action: 'archive', date: '2026-06-22T12:00:00.000Z', reached: false }]);
    expect(h.log.some((l) => l.includes('the message reached nobody') && l.includes('not archived meanwhile'))).toBe(true);
    expect(h.notified).toEqual([run]);
  });

  it('a tenant whose message reached nobody is never archived on that date: it is told again at every sweep', async () => {
    // Told eight days ago for yesterday — to nobody. Reached, it would be due.
    const unreached = harness(world({
      settings: NOTICE, suspended: { silent: 45 },
      archiveNotices: { silent: { toldDaysAgo: 8, dateInDays: -1, reached: false } },
    }));
    const run = await runTenantAutomationSweep(unreached.io, 'schedule');
    expect(unreached.calls.filter((c) => c.startsWith('archive'))).toEqual([]);
    expect(unreached.calls.filter((c) => c.startsWith('tell'))).toEqual(['tell silent: archive on 2026-06-22']);
    expect(run.archived).toEqual([]);

    const reached = harness(world({
      settings: NOTICE, suspended: { heard: 45 },
      archiveNotices: { heard: { toldDaysAgo: 8, dateInDays: -1 } },
    }));
    expect(names((await runTenantAutomationSweep(reached.io, 'schedule')).archived)).toEqual(['heard']);
  });

  it('the same holds before a delete', async () => {
    const h = harness(world({
      settings: { ...OFF, autoDeleteEnabled: true, noticeDays: 14 },
      archived: { silent: 200 },
      deleteNotices: { silent: { toldDaysAgo: 30, dateInDays: -16, reached: false } },
    }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('delete'))).toEqual([]);
    expect(names(run.told)).toEqual(['silent']);
  });

  it('a tenant that is no longer in line when its turn to be told comes is passed over', async () => {
    const h = harness(world({ settings: NOTICE, suspended: { resumed: 45, other: 44 }, tellOutcome: { resumed: { kind: 'skipped', reason: 'it is no longer suspended' } } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.told)).toEqual(['other']);
    expect(run.failed).toEqual([]);
    expect(h.log).toContain('did not tell resumed (id-resumed): it is no longer suspended');
  });

  it('a message that cannot be sent is a failure with its reason, and the tenants after it are still told', async () => {
    const h = harness(world({ settings: NOTICE, suspended: { broken: 45, fine: 44 }, tellOutcome: { broken: new Error('the mail queue is down') } }));
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(run.failed).toEqual([{ tenantId: 'id-broken', name: 'broken', action: 'archive', error: 'It could not be told: the mail queue is down' }]);
    expect(names(run.told)).toEqual(['fine']);
  });

  it('a notice period raised during the sweep is the one the next tenant is given', async () => {
    const w = world({ settings: NOTICE, suspended: { a: 400, b: 300 } });
    const h = harness(w);
    const base = h.io.tell;
    h.io.tell = async (step, tenant, date) => { const o = await base(step, tenant, date); w.settings = { ...w.settings, noticeDays: 30 }; return o; };
    await runTenantAutomationSweep(h.io, 'schedule');
    expect(h.calls.filter((c) => c.startsWith('tell'))).toEqual(['tell a: archive on 2026-06-22', 'tell b: archive on 2026-07-15']);
  });

  it('a step switched off during the sweep stops the telling too', async () => {
    const w = world({ settings: NOTICE, suspended: { a: 400, b: 300 } });
    const h = harness(w);
    const base = h.io.tell;
    h.io.tell = async (step, tenant, date) => { const o = await base(step, tenant, date); w.settings = { ...w.settings, autoArchiveEnabled: false }; return o; };
    const run = await runTenantAutomationSweep(h.io, 'schedule');
    expect(names(run.told)).toEqual(['a']);
  });

  it('keeps an archive for the delete limit plus the notice period, when that is longer than the platform\'s retention', async () => {
    const h = harness(world({
      settings: { ...OFF, autoArchiveEnabled: true, autoDeleteEnabled: true, autoDeleteAfterDays: 90, noticeDays: 14 },
      suspended: { old: 45 },
      archiveNotices: { old: { toldDaysAgo: 20, dateInDays: -6 } },
      archiveRetentionDays: 90,
    }));
    await runTenantAutomationSweep(h.io, 'schedule');
    // A tenant told late is deleted up to a notice period after its limit; its archive must still be there.
    expect(h.calls.find((c) => c.startsWith('archive'))).toContain('keep=104');
  });
});
