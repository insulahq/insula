import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyMock = vi.fn();
vi.mock('../notifications/events.js', () => ({
  notifyTenantSubscriptionExpiry: (...args: unknown[]) => notifyMock(...args),
}));

const { runExpiryWarningPass } = await import('./expiry-warning-scheduler.js');

interface MockTenant {
  id: string;
  name: string | null;
  expiresAt: Date | null;
  isSystem: boolean;
  status: string;
}

function buildDb(rowsByWindow: Map<number, MockTenant[]>) {
  // The scheduler issues one SELECT per window. The mock tracks which
  // call we're on by counting; each call returns the rows pre-bound to
  // the next window in iteration order (7, 3, 1).
  let callIndex = 0;
  const ordered = [7, 3, 1];
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => {
        const window = ordered[callIndex++];
        const rows = rowsByWindow.get(window) ?? [];
        return Promise.resolve(rows);
      },
    }),
  }));
  return { select } as unknown as Parameters<typeof runExpiryWarningPass>[0];
}

const NOW = new Date('2026-06-01T12:00:00Z');

beforeEach(() => {
  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
});

describe('runExpiryWarningPass', () => {
  it('returns zero counters when no tenants match any window', async () => {
    const db = buildDb(new Map());
    const r = await runExpiryWarningPass(db, { now: NOW });
    expect(r).toEqual({ scanned: 0, emitted: 0, failed: 0 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('emits one warning per tenant×window', async () => {
    const map = new Map<number, MockTenant[]>([
      [7, [{ id: 't1', name: 'Acme', expiresAt: new Date('2026-06-08T15:00:00Z'), isSystem: false, status: 'active' }]],
      [3, [{ id: 't2', name: 'Bravo', expiresAt: new Date('2026-06-04T09:00:00Z'), isSystem: false, status: 'active' }]],
      [1, [{ id: 't3', name: 'Charlie', expiresAt: new Date('2026-06-02T20:00:00Z'), isSystem: false, status: 'active' }]],
    ]);
    const db = buildDb(map);
    const r = await runExpiryWarningPass(db, { now: NOW });
    expect(r).toEqual({ scanned: 3, emitted: 3, failed: 0 });
    expect(notifyMock).toHaveBeenCalledTimes(3);
    // Each call should pass a dedupeKey scoped to (tenant × window × expiry-date)
    const keys = notifyMock.mock.calls.map((c) => c[3] as string);
    expect(keys).toContain('subscription-expiry:t1:7d:2026-06-08');
    expect(keys).toContain('subscription-expiry:t2:3d:2026-06-04');
    expect(keys).toContain('subscription-expiry:t3:1d:2026-06-02');
  });

  it('dedupeKey includes daysOut so two windows for the same tenant produce different keys', async () => {
    // Same expiry within both 7-day and 3-day windows would be a config
    // edge case (windows overlap), but assert the key shape: each window
    // gets its own key suffix.
    const expiry = new Date('2026-06-04T09:00:00Z');
    const t: MockTenant = { id: 'tA', name: 'Acme', expiresAt: expiry, isSystem: false, status: 'active' };
    const db = buildDb(new Map<number, MockTenant[]>([[7, [t]], [3, [t]], [1, []]]));
    await runExpiryWarningPass(db, { now: NOW });
    const keys = notifyMock.mock.calls.map((c) => c[3] as string);
    expect(keys[0]).toBe('subscription-expiry:tA:7d:2026-06-04');
    expect(keys[1]).toBe('subscription-expiry:tA:3d:2026-06-04');
  });

  it('counts failed emits without aborting the batch', async () => {
    const map = new Map<number, MockTenant[]>([
      [7, [{ id: 't1', name: 'Acme', expiresAt: new Date('2026-06-08T15:00:00Z'), isSystem: false, status: 'active' }]],
      [3, []],
      [1, [{ id: 't2', name: 'Bravo', expiresAt: new Date('2026-06-02T15:00:00Z'), isSystem: false, status: 'active' }]],
    ]);
    notifyMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    const db = buildDb(map);
    const r = await runExpiryWarningPass(db, { now: NOW });
    expect(r).toEqual({ scanned: 2, emitted: 1, failed: 1 });
  });

  it('respects a custom windowsDays override', async () => {
    const t: MockTenant = { id: 'tA', name: 'Acme', expiresAt: new Date('2026-06-15T09:00:00Z'), isSystem: false, status: 'active' };
    // The buildDb mock binds windows to [7,3,1] regardless of override;
    // here we just verify the scheduler issues the right number of
    // SELECT calls — i.e. the override shape is respected.
    const select = vi.fn().mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([t]) }),
    }));
    const db = { select } as unknown as Parameters<typeof runExpiryWarningPass>[0];
    const r = await runExpiryWarningPass(db, { now: NOW, windowsDays: [14, 7] });
    expect(r.scanned).toBe(2); // one tenant returned per window × 2 windows
    expect(select).toHaveBeenCalledTimes(2);
  });
});
