import { describe, it, expect, vi } from 'vitest';
import {
  getUserPreferences,
  updateUserPreferences,
  getUserSettings,
  updateUserSettings,
} from './service.js';

type Db = Parameters<typeof getUserPreferences>[0];

function mkCategory(id: string, opts: Partial<{ mandatory: boolean; defaultChannels: string[]; audience: string }> = {}) {
  return {
    id,
    defaultChannels: opts.defaultChannels ?? ['in_app', 'email'],
    isMandatory: opts.mandatory ?? false,
    isActive: true,
    audience: opts.audience ?? 'tenant',
  };
}

describe('getUserPreferences', () => {
  it('produces a (category × channel) matrix with default-channel falls', async () => {
    const cats = [mkCategory('cat.a'), mkCategory('cat.b', { defaultChannels: ['in_app'] })];
    const prefs: unknown[] = [];

    let callIdx = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => {
            // first call is categories, second is prefs (no orderBy)
            return Promise.resolve(callIdx++ === 0 ? cats : prefs);
          },
          then: (resolve: (v: unknown) => void) => resolve(prefs),
        }),
      }),
    }));
    const db = { select } as unknown as Db;

    const r = await getUserPreferences(db, 'u1');
    expect(r.preferences.length).toBe(4); // 2 categories × 2 channels
    const aEmail = r.preferences.find((p) => p.categoryId === 'cat.a' && p.channel === 'email');
    expect(aEmail?.enabled).toBe(true);
    const bEmail = r.preferences.find((p) => p.categoryId === 'cat.b' && p.channel === 'email');
    expect(bEmail?.enabled).toBe(false);
  });

  it('mandatory categories always surface as enabled+isMandatory even with a disable row', async () => {
    const cats = [mkCategory('cat.m', { mandatory: true })];
    const prefs = [{ categoryId: 'cat.m', channel: 'email', enabled: false }];
    let callIdx = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(callIdx++ === 0 ? cats : prefs),
          then: (resolve: (v: unknown) => void) => resolve(prefs),
        }),
      }),
    }));
    const db = { select } as unknown as Db;

    const r = await getUserPreferences(db, 'u1');
    for (const p of r.preferences) {
      expect(p.enabled).toBe(true);
      expect(p.isMandatory).toBe(true);
    }
  });

  it('explicit user override beats the default channels list', async () => {
    const cats = [mkCategory('cat.a', { defaultChannels: ['in_app', 'email'] })];
    const prefs = [{ categoryId: 'cat.a', channel: 'email', enabled: false }];
    let callIdx = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(callIdx++ === 0 ? cats : prefs),
          then: (resolve: (v: unknown) => void) => resolve(prefs),
        }),
      }),
    }));
    const db = { select } as unknown as Db;

    const r = await getUserPreferences(db, 'u1');
    const email = r.preferences.find((p) => p.channel === 'email');
    expect(email?.enabled).toBe(false);
  });
});

describe('updateUserPreferences', () => {
  it('skips unknown category ids and mandatory-disable attempts', async () => {
    // Two passes: known lookup, then a final getUserPreferences read.
    let knownCalls = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => {
          knownCalls++;
          // known categories
          if (knownCalls === 1) {
            return Promise.resolve([
              { id: 'cat.m', isMandatory: true },
              { id: 'cat.a', isMandatory: false },
            ]);
          }
          // categories list inside getUserPreferences
          if (knownCalls === 2) {
            return {
              orderBy: () => Promise.resolve([
                mkCategory('cat.m', { mandatory: true }),
                mkCategory('cat.a'),
              ]),
            };
          }
          // user prefs read
          return {
            orderBy: () => Promise.resolve([]),
            then: (resolve: (v: unknown) => void) => resolve([]),
          };
        },
      }),
    }));
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { select, insert } as unknown as Db;

    await updateUserPreferences(db, 'u1', {
      updates: [
        { categoryId: 'cat.m', channel: 'email', enabled: false }, // dropped
        { categoryId: 'unknown', channel: 'email', enabled: true }, // dropped
        { categoryId: 'cat.a', channel: 'email', enabled: false }, // written
      ],
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe('getUserSettings', () => {
  it('returns defaults when no row exists', async () => {
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const db = { select } as unknown as Db;
    const s = await getUserSettings(db, 'u1');
    expect(s.digestMode).toBe('immediate');
    expect(s.locale).toBe('en');
  });

  it('returns the row when present', async () => {
    const row = {
      userId: 'u1',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'Europe/Berlin',
      digestMode: 'daily',
      locale: 'de',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
    });
    const db = { select } as unknown as Db;
    const s = await getUserSettings(db, 'u1');
    expect(s.locale).toBe('de');
    expect(s.digestMode).toBe('daily');
    expect(s.quietHoursStart).toBe('22:00');
  });
});

describe('updateUserSettings', () => {
  it('merges patch onto existing values and upserts', async () => {
    const existing = {
      userId: 'u1',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'Europe/Berlin',
      digestMode: 'immediate',
      locale: 'en',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const select = vi.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([existing]) }) }),
    });
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { select, insert } as unknown as Db;

    const r = await updateUserSettings(db, 'u1', { locale: 'fr' });
    expect(r.locale).toBe('fr');
    expect(r.quietHoursStart).toBe('22:00');
    expect(insert).toHaveBeenCalled();
  });
});
