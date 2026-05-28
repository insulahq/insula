import { describe, it, expect, vi } from 'vitest';
import { isCategoryAllowedForUser } from './gate.js';

type Db = Parameters<typeof isCategoryAllowedForUser>[0];

function mockChain(catRow: unknown | undefined, prefRow: unknown | undefined) {
  let call = 0;
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(call++ === 0 ? (catRow ? [catRow] : []) : (prefRow ? [prefRow] : [])),
      }),
    }),
  }));
  return select;
}

describe('isCategoryAllowedForUser', () => {
  it('returns false when category does not exist', async () => {
    const db = { select: mockChain(undefined, undefined) } as unknown as Db;
    const r = await isCategoryAllowedForUser(db, 'u1', 'x', 'email');
    expect(r).toBe(false);
  });

  it('returns false when category is inactive', async () => {
    const db = {
      select: mockChain(
        { id: 'c', defaultChannels: ['email'], isMandatory: false, isActive: false },
        undefined,
      ),
    } as unknown as Db;
    const r = await isCategoryAllowedForUser(db, 'u1', 'c', 'email');
    expect(r).toBe(false);
  });

  it('returns true unconditionally for mandatory categories', async () => {
    const db = {
      select: mockChain(
        { id: 'c', defaultChannels: ['in_app'], isMandatory: true, isActive: true },
        // Even with an explicit disable row, mandatory wins.
        { enabled: false },
      ),
    } as unknown as Db;
    const r = await isCategoryAllowedForUser(db, 'u1', 'c', 'email');
    expect(r).toBe(true);
  });

  it('respects explicit user opt-out row when present', async () => {
    const db = {
      select: mockChain(
        { id: 'c', defaultChannels: ['in_app', 'email'], isMandatory: false, isActive: true },
        { enabled: false },
      ),
    } as unknown as Db;
    const r = await isCategoryAllowedForUser(db, 'u1', 'c', 'email');
    expect(r).toBe(false);
  });

  it('falls back to default channels when no user row exists', async () => {
    const db = {
      select: mockChain(
        { id: 'c', defaultChannels: ['in_app'], isMandatory: false, isActive: true },
        undefined,
      ),
    } as unknown as Db;
    const inApp = await isCategoryAllowedForUser(db, 'u1', 'c', 'in_app');
    expect(inApp).toBe(true);
    const db2 = {
      select: mockChain(
        { id: 'c', defaultChannels: ['in_app'], isMandatory: false, isActive: true },
        undefined,
      ),
    } as unknown as Db;
    const email = await isCategoryAllowedForUser(db2, 'u1', 'c', 'email');
    expect(email).toBe(false);
  });
});
