import { describe, it, expect, vi, beforeEach } from 'vitest';

// Assert WHO gets told, which is the entire defect this module had: the old
// implementation resolved recipients from `mailbox_access` — zero rows
// platform-wide — so it notified nobody for its whole life.
const thresholdMock = vi.fn(async () => undefined);
const fleetMock = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({
  notifyMailboxQuotaThreshold: (...a: unknown[]) => thresholdMock(...(a as [])),
  notifyAdminMailboxQuotaFleet: (...a: unknown[]) => fleetMock(...(a as [])),
}));

import {
  checkQuotaThresholds,
  thresholdsCrossed,
  percentOf,
  THRESHOLDS,
} from './quota-notifications.js';

/**
 * Mock DB: `execute` is called in a fixed order —
 *   1. candidate SELECT
 *   2..n. one INSERT … RETURNING per (mailbox, threshold) claim
 *   then the hysteresis UPDATE and the GC DELETE.
 * Claims return a row (fresh) unless the id is listed in `alreadyFiring`.
 */
function createMockDb(candidates: Record<string, unknown>[]) {
  // Keyed off CALL ORDER, not the SQL text: a drizzle `sql` template is an
  // object, and stringifying it to sniff for "INSERT" silently matched
  // nothing — which read as "no threshold was ever claimed" and turned the
  // assertions green-adjacent for the wrong reason.
  //
  //   call 1        candidate SELECT
  //   calls 2..n    one INSERT … RETURNING per (mailbox, threshold) claim
  //   then          the hysteresis UPDATE and the GC DELETE
  let call = 0;
  const execute = vi.fn().mockImplementation(async () => {
    call += 1;
    if (call === 1) return { rows: candidates };
    return { rows: [{ mailbox_id: 'claimed' }] };
  });
  return { execute } as never;
}

function mailbox(over: Partial<Record<string, unknown>> = {}) {
  return {
    mailbox_id: 'mb-1',
    tenant_id: 't-1',
    tenant_name: 'Example Ltd',
    full_address: 'user@example.test',
    quota_mb: 1000,
    used_mb: 800,
    ...over,
  };
}

beforeEach(() => {
  thresholdMock.mockClear();
  fleetMock.mockClear();
});

describe('thresholdsCrossed', () => {
  it('includes 99 — the last point at which the owner can still act', () => {
    expect(THRESHOLDS).toEqual([80, 90, 99, 100]);
    expect(thresholdsCrossed(995, 1000)).toEqual([80, 90, 99]);
  });

  it('returns every crossed threshold, not just the highest', () => {
    expect(thresholdsCrossed(1000, 1000)).toEqual([80, 90, 99, 100]);
  });

  it('returns nothing below the first threshold', () => {
    expect(thresholdsCrossed(700, 1000)).toEqual([]);
  });

  it('treats a zero quota as unlimited rather than dividing by zero', () => {
    expect(thresholdsCrossed(500, 0)).toEqual([]);
    expect(percentOf(500, 0)).toBe(0);
  });
});

describe('checkQuotaThresholds — who actually gets told', () => {
  it('notifies the TENANT and the MAILBOX OWNER, with no mailbox_access anywhere', async () => {
    // The production state: mailbox_access is empty. That used to mean silence.
    const db = createMockDb([mailbox()]);
    const r = await checkQuotaThresholds(db);

    expect(r.fired).toBe(1);
    expect(thresholdMock).toHaveBeenCalledTimes(1);
    const [, tenantId, address, payload] = thresholdMock.mock.calls[0] as unknown[];
    expect(tenantId).toBe('t-1');
    expect(address).toBe('user@example.test');
    expect(payload).toMatchObject({
      mailboxAddress: 'user@example.test',
      tenantName: 'Example Ltd',
      percent: '80',
      usedMb: '800',
      quotaMb: '1000',
    });
  });

  it('names the tenant and the mailbox in every payload', async () => {
    // "Which tenant, which mailbox, what and when" — the four things the
    // retired SLO alert could not say.
    const db = createMockDb([mailbox()]);
    await checkQuotaThresholds(db, new Date('2026-09-14T10:30:00Z'));
    const payload = (thresholdMock.mock.calls[0] as unknown[])[3] as Record<string, string>;
    expect(payload.occurredAt).toContain('2026-09-14');
    expect(payload.tenantName).toBe('Example Ltd');
    expect(payload.mailboxAddress).toBe('user@example.test');
  });

  it('sends ONE notification for the highest threshold, not one per crossing', async () => {
    // This asserted `fired === 4` — one notification per crossed threshold.
    // Operator decision 2026-09-16 after production sent the same mailbox's
    // 80 and 90 warnings two seconds apart: a mailbox that jumps from 78% to
    // 95% between two passes has crossed three lines, and the reader needs to
    // be told once, at the worst of them. Inverted rather than deleted, so a
    // regression back to per-crossing fan-out fails here.
    const db = createMockDb([mailbox({ used_mb: 1000 })]);
    const r = await checkQuotaThresholds(db);
    expect(r.fired).toBe(1);
    expect(thresholdMock.mock.calls).toHaveLength(1);
    // And it is the HIGHEST — 100, the one where mail is already bouncing.
    expect((thresholdMock.mock.calls[0] as unknown[])[4]).toMatchObject({ exceeded: true });
  });

  it('still claims the lower thresholds it skipped, so they cannot re-fire', async () => {
    // The lower crossings must be recorded even though they are not sent. If
    // only the highest were claimed, the next pass would see 80 and 90 as new
    // and mail them — turning one jump into a slow drip of stale warnings.
    const db = createMockDb([mailbox({ used_mb: 1000 })]);
    await checkQuotaThresholds(db);
    // The mock counts CALLS rather than sniffing SQL text (see its note), so
    // the claim count is read the same way: 1 candidate SELECT + one claim per
    // crossed threshold (4) + the hysteresis UPDATE + the GC DELETE.
    const calls = (db as unknown as { execute: { mock: { calls: unknown[] } } }).execute.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1 + 4);
  });

  it('marks only 100% as exceeded, so 99 stays a warning', async () => {
    const db = createMockDb([mailbox({ used_mb: 995 })]);
    await checkQuotaThresholds(db);
    for (const call of thresholdMock.mock.calls as unknown[][]) {
      expect((call[4] as { exceeded: boolean }).exceeded).toBe(false);
    }
  });
});

describe('checkQuotaThresholds — the operator view', () => {
  it('says NOTHING to the operator below 100%', async () => {
    // Not the operator's business until mail actually bounces.
    const db = createMockDb([mailbox({ used_mb: 995 })]);
    const r = await checkQuotaThresholds(db);
    expect(r.overQuota).toBe(0);
    expect(fleetMock).not.toHaveBeenCalled();
  });

  it('sends ONE aggregated notification naming every affected mailbox', async () => {
    const db = createMockDb([
      mailbox({ mailbox_id: 'a', full_address: 'a@example.test', used_mb: 1000 }),
      mailbox({ mailbox_id: 'b', full_address: 'b@example.test', used_mb: 1000, tenant_id: 't-2', tenant_name: 'Other Ltd' }),
    ]);
    const r = await checkQuotaThresholds(db);

    expect(r.overQuota).toBe(2);
    expect(fleetMock).toHaveBeenCalledTimes(1);
    const payload = (fleetMock.mock.calls[0] as unknown[])[1] as Record<string, string>;
    expect(payload.mailboxCount).toBe('2');
    expect(payload.tenantCount).toBe('2');
    // The whole point: the operator can see WHICH mailbox and WHICH tenant.
    expect(payload.mailboxList).toContain('a@example.test');
    expect(payload.mailboxList).toContain('Example Ltd');
    expect(payload.mailboxList).toContain('b@example.test');
    expect(payload.mailboxList).toContain('Other Ltd');
  });

  it('dedupes the fleet notification per UTC day', async () => {
    const db = createMockDb([mailbox({ used_mb: 1000 })]);
    await checkQuotaThresholds(db, new Date('2026-09-14T23:00:00Z'));
    expect((fleetMock.mock.calls[0] as unknown[])[2]).toBe('mailbox-quota-fleet:2026-09-14');
  });
});

describe('checkQuotaThresholds — no candidates', () => {
  it('does nothing and tells nobody when every mailbox is healthy', async () => {
    const db = createMockDb([]);
    const r = await checkQuotaThresholds(db);
    expect(r).toMatchObject({ fired: 0, overQuota: 0 });
    expect(thresholdMock).not.toHaveBeenCalled();
    expect(fleetMock).not.toHaveBeenCalled();
  });
});
