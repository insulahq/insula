import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { getClusterId } from './cluster-id.js';

/** Minimal fake: a single mutable cluster_id cell behind select/insert. */
function fakeDb(initial: string | null): Database {
  let stored = initial;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(stored ? [{ value: stored }] : [])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: { value: string }) => ({
        onConflictDoNothing: vi.fn(() => {
          if (stored == null) stored = v.value; // first writer wins
          return Promise.resolve();
        }),
      })),
    })),
  } as unknown as Database;
}

describe('getClusterId', () => {
  it('returns the existing id when one is already persisted', async () => {
    expect(await getClusterId(fakeDb('11111111-2222-3333-4444-555555555555'))).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  it('generates a UUID once and is stable across calls', async () => {
    const db = fakeDb(null);
    const first = await getClusterId(db);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await getClusterId(db)).toBe(first); // persisted → never changes
  });
});
