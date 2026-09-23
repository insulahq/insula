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
          // Preferences are scoped to the user's own audience, so the first
          // read is the user row that decides it. A tenant offered switches
          // for admin-only categories can never be sent any of them.
          if (knownCalls === 1) {
            return Promise.resolve([{ panel: 'tenant' }]);
          }
          // known categories
          if (knownCalls === 2) {
            return Promise.resolve([
              { id: 'cat.m', isMandatory: true },
              { id: 'cat.a', isMandatory: false },
            ]);
          }
          // categories list inside getUserPreferences (after its own
          // audience lookup, which lands on the fall-through below)
          if (knownCalls === 4) {
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

/**
 * "Why does the tenant panel NOTIFICATION SETTINGS page show ALL
 * NOTIFICATIONS, even those meant for platform admins?"
 *
 * Because the matrix loaded every active category. Recipients are resolved by
 * scope at dispatch — an `admin` scope selects admin-panel users, a `tenant`
 * scope that tenant's users — so an admin-audience category can never reach a
 * tenant user. The page was offering switches for 44 notifications that would
 * never be sent, including cluster, node and firewall events.
 */
describe('preferences are scoped to the user audience', () => {
  function dbFor(panel: string, categories: unknown[]) {
    const calls: Array<Record<string, unknown>> = [];
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: (cond: unknown) => {
          calls.push({ cond });
          // 1st: the user row. 2nd: categories. 3rd: prefs.
          if (calls.length === 1) return Promise.resolve([{ panel }]);
          return {
            orderBy: () => Promise.resolve(calls.length === 2 ? categories : []),
            then: (resolve: (v: unknown) => void) => resolve([]),
          };
        },
      }),
    }));
    return { db: { select } as unknown as Db, calls };
  }

  it('a tenant user sees only tenant categories', async () => {
    const { db } = dbFor('tenant', [mkCategory('tenant.thing', { audience: 'tenant' })]);
    const r = await getUserPreferences(db, 'u1');
    expect(r.preferences.length).toBeGreaterThan(0);
    expect(r.preferences.every((p) => p.categoryId.startsWith('tenant.'))).toBe(true);
  });

  it('filters in the QUERY, not after the fact', async () => {
    // Filtering in JS would still ship every category id to a tenant over the
    // wire. The audience has to be part of the WHERE.
    const render = (q: unknown): string => {
      let out = '';
      const walk = (chunks: unknown[]): void => {
        for (const c of chunks) {
          if (c && typeof c === 'object' && 'queryChunks' in c) {
            walk((c as { queryChunks: unknown[] }).queryChunks);
            continue;
          }
          if (c && typeof c === 'object' && 'value' in c) {
            const v = (c as { value: unknown }).value;
            if (Array.isArray(v)) out += v.join(' ');
            else if (typeof v === 'string') out += v;
          }
        }
      };
      if (q && typeof q === 'object' && 'queryChunks' in q) {
        walk((q as { queryChunks: unknown[] }).queryChunks);
      }
      return out;
    };
    const { db, calls } = dbFor('tenant', [mkCategory('tenant.thing')]);
    await getUserPreferences(db, 'u1');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(render(calls[1].cond)).toContain('tenant');
  });

  it('an unreadable user row degrades to the NARROWER audience', async () => {
    // Showing too few switches is a smaller failure than showing an operator's.
    let n = 0;
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => {
          n += 1;
          if (n === 1) return Promise.resolve([]); // no user row
          return {
            orderBy: () => Promise.resolve([mkCategory('tenant.thing')]),
            then: (resolve: (v: unknown) => void) => resolve([]),
          };
        },
      }),
    }));
    const db = { select } as unknown as Db;
    const r = await getUserPreferences(db, 'u1');
    expect(r.preferences.every((p) => p.categoryId.startsWith('tenant.'))).toBe(true);
  });
});
