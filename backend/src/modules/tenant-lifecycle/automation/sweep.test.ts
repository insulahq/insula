import { describe, expect, it } from 'vitest';
import type { TenantAutomationRun, TenantAutomationSettings } from '@insula/api-contracts';
import { runTenantAutomationSweep, type ActionOutcome, type DueTenant, type SweepIo } from './sweep.js';

/**
 * What the automatic archive/delete sweep decides — against a fake of
 * everything it touches, so each case states exactly what the world looks
 * like and what the sweep then does to it.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00.000Z');

const OFF: TenantAutomationSettings = {
  autoArchiveEnabled: false, autoArchiveAfterDays: 30, autoDeleteEnabled: false, autoDeleteAfterDays: 90,
};

interface World {
  settings: TenantAutomationSettings;
  archiveRetentionDays: number;
  /** tenant → the day it was suspended / archived, as days before NOW. */
  suspended: Record<string, number>;
  archived: Record<string, number>;
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
    archiveOutcome: {}, removeOutcome: {}, notifyFails: false, ...over,
  };
}

function harness(w: World) {
  const calls: string[] = [];
  const recorded: TenantAutomationRun[] = [];
  const notified: TenantAutomationRun[] = [];
  const log: string[] = [];
  const due = (set: Record<string, number>, before: Date): DueTenant[] => Object.entries(set)
    .filter(([, daysAgo]) => NOW.getTime() - daysAgo * DAY < before.getTime())
    .sort(([, a], [, b]) => b - a)
    .map(([name]) => ({ tenantId: `id-${name}`, name }));
  const outcome = (o: ActionOutcome | Error | undefined): ActionOutcome => {
    if (o instanceof Error) throw o;
    return o ?? { kind: 'done' };
  };
  let reads = 0;
  const io: { -readonly [K in keyof SweepIo]: SweepIo[K] } = {
    settings: async () => { reads += 1; w.onSettingsRead?.(reads); return w.settings; },
    archiveRetentionDays: async () => w.archiveRetentionDays,
    dueForArchive: async (before) => {
      calls.push('list-archive');
      if (w.listArchiveFails) throw new Error('the database did not answer');
      return due(w.suspended, before);
    },
    dueForDelete: async (before) => {
      calls.push('list-delete');
      if (w.listDeleteFails) throw new Error('the database did not answer');
      return due(w.archived, before);
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
    expect(run).toMatchObject({ trigger: 'schedule', archived: [], deleted: [], failed: [], archiveSkippedReason: null, errors: [] });
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
      settings: { autoArchiveEnabled: true, autoArchiveAfterDays: 30, autoDeleteEnabled: true, autoDeleteAfterDays: 1 },
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
    // b was listed under the 1-day limit; it is handed on with the 90-day one,
    // which the delete then refuses it under (archived 5 days ago).
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
});
