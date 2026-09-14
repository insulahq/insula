import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyMock = vi.fn();
const adminDigestMock = vi.fn();
vi.mock('../notifications/events.js', () => ({
  notifyTenantSubscriptionExpiry: (...args: unknown[]) => notifyMock(...args),
  notifyAdminSubscriptionsExpiring: (...args: unknown[]) => adminDigestMock(...args),
}));

const { runExpiryWarningPass, DEFAULT_WARNING_WINDOWS } = await import('./expiry-warning-scheduler.js');

interface MockTenant {
  id: string;
  name: string | null;
  expiresAt: Date | null;
  isSystem: boolean;
  status: string;
}

function buildDb(rowsByWindow: Map<number, MockTenant[]>) {
  // The scheduler issues one SELECT per window, in the real window order.
  // Derived from DEFAULT_WARNING_WINDOWS rather than hardcoded: a fixture that
  // pins [7, 3, 1] silently stops lining up the moment the cadence changes,
  // and then returns the wrong rows for the right window.
  let callIndex = 0;
  const ordered = [...DEFAULT_WARNING_WINDOWS];
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
  adminDigestMock.mockReset();
  adminDigestMock.mockResolvedValue(undefined);
});

describe('runExpiryWarningPass', () => {
  it('returns zero counters when no tenants match any window', async () => {
    const db = buildDb(new Map());
    const r = await runExpiryWarningPass(db, { now: NOW });
    expect(r).toEqual({ scanned: 0, emitted: 0, failed: 0 });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('emits one warning per tenant×window across the five weekly slots', async () => {
    // Cadence widened 2026-09-14 from 7/3/1 to weekly for five weeks. Seven
    // days is not enough notice to raise a purchase order, so the first
    // warning a finance team could act on used to arrive after the point they
    // could act.
    const map = new Map<number, MockTenant[]>([
      [35, [{ id: 't1', name: 'Acme', expiresAt: new Date('2026-07-06T15:00:00Z'), isSystem: false, status: 'active' }]],
      [14, [{ id: 't2', name: 'Bravo', expiresAt: new Date('2026-06-15T09:00:00Z'), isSystem: false, status: 'active' }]],
      [7, [{ id: 't3', name: 'Charlie', expiresAt: new Date('2026-06-08T20:00:00Z'), isSystem: false, status: 'active' }]],
    ]);
    const db = buildDb(map);
    const r = await runExpiryWarningPass(db, { now: NOW });
    expect(r).toEqual({ scanned: 3, emitted: 3, failed: 0 });
    expect(notifyMock).toHaveBeenCalledTimes(3);
    // Each call passes a dedupeKey scoped to (tenant × window × expiry-date)
    const keys = notifyMock.mock.calls.map((c) => c[3] as string);
    expect(keys).toContain('subscription-expiry:t1:35d:2026-07-06');
    expect(keys).toContain('subscription-expiry:t2:14d:2026-06-15');
    expect(keys).toContain('subscription-expiry:t3:7d:2026-06-08');
  });

  it('warns weekly for five weeks', () => {
    expect([...DEFAULT_WARNING_WINDOWS]).toEqual([35, 28, 21, 14, 7]);
  });

  it('also tells the OPERATOR, once, as an aggregated list', async () => {
    // The operator chases the renewal and was never told at all. One
    // notification per run, not one per tenant per slot.
    const db = buildDb(new Map<number, MockTenant[]>([
      [35, [{ id: 't1', name: 'Acme', expiresAt: new Date('2026-07-06T15:00:00Z'), isSystem: false, status: 'active' }]],
      [7, [{ id: 't2', name: 'Bravo', expiresAt: new Date('2026-06-08T09:00:00Z'), isSystem: false, status: 'active' }]],
    ]));
    await runExpiryWarningPass(db, { now: NOW });
    expect(adminDigestMock).toHaveBeenCalledTimes(1);
    const payload = adminDigestMock.mock.calls[0][1] as Record<string, string>;
    expect(payload.tenantCount).toBe('2');
    expect(payload.tenantList).toContain('Acme');
    expect(payload.tenantList).toContain('Bravo');
  });

  it('tells the operator nothing when no subscription is expiring', async () => {
    await runExpiryWarningPass(buildDb(new Map()), { now: NOW });
    expect(adminDigestMock).not.toHaveBeenCalled();
  });

  it('dedupeKey includes daysOut so two windows for the same tenant produce different keys', async () => {
    // Same expiry within both 7-day and 3-day windows would be a config
    // edge case (windows overlap), but assert the key shape: each window
    // gets its own key suffix.
    const expiry = new Date('2026-06-04T09:00:00Z');
    const t: MockTenant = { id: 'tA', name: 'Acme', expiresAt: expiry, isSystem: false, status: 'active' };
    const db = buildDb(new Map<number, MockTenant[]>([[35, [t]], [14, [t]]]));
    await runExpiryWarningPass(db, { now: NOW });
    const keys = notifyMock.mock.calls.map((c) => c[3] as string);
    expect(keys[0]).toBe('subscription-expiry:tA:35d:2026-06-04');
    expect(keys[1]).toBe('subscription-expiry:tA:14d:2026-06-04');
  });

  it('counts failed emits without aborting the batch', async () => {
    const map = new Map<number, MockTenant[]>([
      [35, [{ id: 't1', name: 'Acme', expiresAt: new Date('2026-07-06T15:00:00Z'), isSystem: false, status: 'active' }]],
      [7, [{ id: 't2', name: 'Bravo', expiresAt: new Date('2026-06-08T15:00:00Z'), isSystem: false, status: 'active' }]],
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
