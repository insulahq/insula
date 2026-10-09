import { describe, it, expect } from 'vitest';
import { pickNewestPerTenant, type ScannedBundle } from './bundle-pick.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function scanned(bundleId: string, tenantId: string, capturedAt: string): ScannedBundle {
  return { bundleId, meta: { tenantId, capturedAt } };
}

describe('pickNewestPerTenant', () => {
  // The bug this replaces: the scan compared `meta.createdAt`, a field the
  // meta schema does not have (it is `capturedAt`; Zod strips unknown keys),
  // so every comparison tied and whichever bundle the store listed FIRST won.
  // Bundle ids are random (`bkp-<uuid>`), so a fleet migration imported an
  // arbitrary — often older — copy of each tenant.
  it('keeps the newest bundle whatever order the store lists them in', () => {
    const older = scanned('bkp-aaaa', T1, '2026-10-01T02:00:00.000Z');
    const newest = scanned('bkp-0000', T1, '2026-10-05T02:00:00.000Z');
    const middle = scanned('bkp-ffff', T1, '2026-10-03T02:00:00.000Z');
    for (const order of [[older, newest, middle], [newest, middle, older], [middle, older, newest]]) {
      const picked = pickNewestPerTenant(order).get(T1);
      expect(picked?.bundleId).toBe('bkp-0000');
      expect(picked?.capturedAt).toBe('2026-10-05T02:00:00.000Z');
      expect(picked?.count).toBe(3);
    }
  });

  it('compares instants, not strings — mixed sub-second precision', () => {
    // Lexicographically "…00Z" sorts AFTER "…00.500Z" ('Z' > '.'), which is
    // the wrong answer: the .500 capture is half a second later.
    const whole = scanned('bkp-a', T1, '2026-10-05T02:00:00Z');
    const later = scanned('bkp-b', T1, '2026-10-05T02:00:00.500Z');
    expect(pickNewestPerTenant([whole, later]).get(T1)?.bundleId).toBe('bkp-b');
    expect(pickNewestPerTenant([later, whole]).get(T1)?.bundleId).toBe('bkp-b');
  });

  it('breaks an exact tie deterministically', () => {
    const a = scanned('bkp-a', T1, '2026-10-05T02:00:00.000Z');
    const b = scanned('bkp-b', T1, '2026-10-05T02:00:00.000Z');
    expect(pickNewestPerTenant([a, b]).get(T1)?.bundleId).toBe('bkp-b');
    expect(pickNewestPerTenant([b, a]).get(T1)?.bundleId).toBe('bkp-b');
  });

  it('groups per tenant', () => {
    const out = pickNewestPerTenant([
      scanned('bkp-1', T1, '2026-10-01T00:00:00.000Z'),
      scanned('bkp-2', T2, '2026-10-02T00:00:00.000Z'),
      scanned('bkp-3', T1, '2026-10-03T00:00:00.000Z'),
    ]);
    expect(out.get(T1)).toMatchObject({ bundleId: 'bkp-3', count: 2 });
    expect(out.get(T2)).toMatchObject({ bundleId: 'bkp-2', count: 1 });
  });

  it('never prefers a bundle whose capture time does not parse', () => {
    const good = scanned('bkp-good', T1, '2026-10-01T00:00:00.000Z');
    const bad = scanned('bkp-bad', T1, 'not-a-date');
    expect(pickNewestPerTenant([bad, good]).get(T1)?.bundleId).toBe('bkp-good');
    expect(pickNewestPerTenant([good, bad]).get(T1)?.bundleId).toBe('bkp-good');
  });
});
