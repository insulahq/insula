import { describe, expect, it } from 'vitest';
import {
  tenantAutomationArchiveRetentionDays,
  tenantAutomationPlan,
  tenantAutomationSettingsUpdateSchema,
} from '@insula/api-contracts';

/**
 * What happens to one tenant at one moment — the decision the sweep takes and
 * the admin panel previews. Every case names the tenant's dates outright.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
const ahead = (days: number): string => new Date(NOW + days * DAY).toISOString();

describe('tenantAutomationPlan', () => {
  it('never touches a tenant with no recorded date', () => {
    expect(tenantAutomationPlan({ since: null }, 30, 7, NOW)).toEqual({ kind: 'never' });
    expect(tenantAutomationPlan({ since: null }, 30, 0, NOW)).toEqual({ kind: 'never' });
  });

  describe('with nobody told', () => {
    it('is due once past the limit, and says when before', () => {
      expect(tenantAutomationPlan({ since: ago(31) }, 30, 0, NOW)).toEqual({ kind: 'due' });
      expect(tenantAutomationPlan({ since: ago(20) }, 30, 0, NOW)).toEqual({ kind: 'later', actAt: NOW + 10 * DAY, told: false, tellAt: null });
    });

    it('is not due at the limit to the millisecond, and is one millisecond on', () => {
      expect(tenantAutomationPlan({ since: ago(30) }, 30, 0, NOW).kind).toBe('later');
      expect(tenantAutomationPlan({ since: ago(30) }, 30, 0, NOW + 1).kind).toBe('due');
    });

    it('still keeps the date of a tenant that was told while there was a notice period', () => {
      // An admin sets the period to nothing; the tenant was promised six more days.
      const notice = { toldAt: ago(1), date: ahead(6) };
      expect(tenantAutomationPlan({ since: ago(45), notice }, 30, 0, NOW)).toEqual({ kind: 'later', actAt: NOW + 6 * DAY, told: true, tellAt: null });
      expect(tenantAutomationPlan({ since: ago(45), notice: { toldAt: ago(8), date: ago(1) } }, 30, 0, NOW)).toEqual({ kind: 'due' });
    });

    it('takes no account of a message that reached nobody, or of one from an earlier suspension', () => {
      expect(tenantAutomationPlan({ since: ago(45), notice: { toldAt: ago(1), date: ahead(6), reached: false } }, 30, 0, NOW)).toEqual({ kind: 'due' });
      expect(tenantAutomationPlan({ since: ago(45), notice: { toldAt: ago(60), date: ahead(6) } }, 30, 0, NOW)).toEqual({ kind: 'due' });
    });
  });

  describe('with a notice period', () => {
    it('waits, and says when the tenant will be told, while its limit is further off than the notice period', () => {
      expect(tenantAutomationPlan({ since: ago(10) }, 30, 7, NOW)).toEqual({ kind: 'later', actAt: NOW + 20 * DAY, told: false, tellAt: NOW + 13 * DAY });
    });

    it('tells a tenant that is within the notice period of its limit, and gives it the whole period from now', () => {
      expect(tenantAutomationPlan({ since: ago(23) }, 30, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
      expect(tenantAutomationPlan({ since: ago(28) }, 30, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
      // Long past its limit, as on the day the step is first switched on.
      expect(tenantAutomationPlan({ since: ago(400) }, 30, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
    });

    it('never gives a date before the limit', () => {
      for (const days of [23, 25, 29.9, 30, 31, 400]) {
        const plan = tenantAutomationPlan({ since: ago(days) }, 30, 7, NOW);
        expect(plan.kind, String(days)).toBe('tell');
        if (plan.kind === 'tell') expect(plan.actAt).toBeGreaterThanOrEqual(NOW - days * DAY + 30 * DAY);
      }
    });

    it('is not due while the date it was given is ahead, and is due when it has come', () => {
      const since = ago(45);
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(2), date: ahead(5) } }, 30, 7, NOW))
        .toEqual({ kind: 'later', actAt: NOW + 5 * DAY, told: true, tellAt: null });
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(7), date: new Date(NOW).toISOString() } }, 30, 7, NOW)).toEqual({ kind: 'due' });
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(8), date: ago(1) } }, 30, 7, NOW)).toEqual({ kind: 'due' });
    });

    it('does not count a notice sent before this suspension began', () => {
      const plan = tenantAutomationPlan({ since: ago(40), notice: { toldAt: ago(60), date: ago(53) } }, 30, 7, NOW);
      expect(plan).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
    });

    it('does not count it even when its date would fit this suspension\'s limit', () => {
      // A limit shorter than the notice period: told on day 0 for day 7, resumed,
      // suspended again four days ago — past the 3-day limit, and the old date
      // (half a day ago) lies after it. Only "told before this suspension"
      // separates this from a tenant that is due.
      const candidate = { since: ago(4), notice: { toldAt: ago(5), date: ago(0.5) } };
      expect(tenantAutomationPlan(candidate, 3, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
      // The same dates, told inside this suspension: due.
      expect(tenantAutomationPlan({ since: ago(8), notice: { toldAt: ago(7.5), date: ago(0.5) } }, 3, 7, NOW)).toEqual({ kind: 'due' });
    });

    it('does not count a message that reached nobody: the tenant is told again, and is not due on that date', () => {
      const since = ago(45);
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(8), date: ago(1), reached: false } }, 30, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(2), date: ahead(5), reached: false } }, 30, 7, NOW)).toEqual({ kind: 'tell', actAt: NOW + 7 * DAY });
      // Reached, or not said either way (an older record): it counts.
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(8), date: ago(1), reached: true } }, 30, 7, NOW)).toEqual({ kind: 'due' });
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(8), date: ago(1) } }, 30, 7, NOW)).toEqual({ kind: 'due' });
    });

    it('does not count a notice whose date is before the limit — the limit was raised since', () => {
      // Told "on the 14th" under 30 days; the limit is 60 now, the tenant 45 days in.
      const plan = tenantAutomationPlan({ since: ago(45), notice: { toldAt: ago(8), date: ago(1) } }, 60, 7, NOW);
      expect(plan).toEqual({ kind: 'later', actAt: NOW + 15 * DAY, told: false, tellAt: NOW + 8 * DAY });
    });

    it('keeps the date a tenant was given when the limit is lowered afterwards', () => {
      const plan = tenantAutomationPlan({ since: ago(28), notice: { toldAt: ago(5), date: ahead(2) } }, 10, 7, NOW);
      expect(plan).toEqual({ kind: 'later', actAt: NOW + 2 * DAY, told: true, tellAt: null });
    });

    it('keeps the date a tenant was given when the notice period is changed afterwards', () => {
      const candidate = { since: ago(45), notice: { toldAt: ago(2), date: ahead(5) } };
      expect(tenantAutomationPlan(candidate, 30, 30, NOW)).toEqual({ kind: 'later', actAt: NOW + 5 * DAY, told: true, tellAt: null });
      expect(tenantAutomationPlan(candidate, 30, 1, NOW)).toEqual({ kind: 'later', actAt: NOW + 5 * DAY, told: true, tellAt: null });
    });

    it('accepts a date stored a few microseconds short of the limit it was computed from', () => {
      // `since` is kept finer than a millisecond; the date derived from it may read a hair early.
      const since = ago(37);
      const date = new Date(NOW - 7 * DAY - 1).toISOString();          // the limit, less a millisecond
      expect(tenantAutomationPlan({ since, notice: { toldAt: ago(14), date } }, 30, 7, NOW)).toEqual({ kind: 'due' });
    });

    it('reads dates given as Date objects exactly as it reads strings', () => {
      const asStrings = tenantAutomationPlan({ since: ago(45), notice: { toldAt: ago(2), date: ahead(5) } }, 30, 7, NOW);
      const asDates = tenantAutomationPlan({ since: new Date(ago(45)), notice: { toldAt: new Date(ago(2)), date: new Date(ahead(5)) } }, 30, 7, NOW);
      expect(asDates).toEqual(asStrings);
    });
  });
});

describe('tenantAutomationArchiveRetentionDays', () => {
  const base = { autoDeleteEnabled: true, autoDeleteAfterDays: 90, noticeDays: 0 };
  it('is the platform retention while automatic delete is off', () => {
    expect(tenantAutomationArchiveRetentionDays({ ...base, autoDeleteEnabled: false, autoDeleteAfterDays: 400, noticeDays: 30 }, 90)).toBe(90);
  });
  it('covers the delete limit plus the notice period when that is longer', () => {
    expect(tenantAutomationArchiveRetentionDays({ ...base, autoDeleteAfterDays: 400 }, 90)).toBe(400);
    expect(tenantAutomationArchiveRetentionDays({ ...base, noticeDays: 14 }, 90)).toBe(104);
    expect(tenantAutomationArchiveRetentionDays({ ...base, autoDeleteAfterDays: 14, noticeDays: 7 }, 90)).toBe(90);
  });
});

describe('the settings a save may carry', () => {
  it('takes a notice period from 0 to 90 whole days', () => {
    for (const noticeDays of [0, 1, 7, 90]) {
      expect(tenantAutomationSettingsUpdateSchema.safeParse({ noticeDays }).success, String(noticeDays)).toBe(true);
    }
  });
  it.each([[-1], [91], [1.5], ['7'], [null]])('refuses a notice period of %j, naming the field', (noticeDays) => {
    const parsed = tenantAutomationSettingsUpdateSchema.safeParse({ noticeDays });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['noticeDays']);
  });
});
