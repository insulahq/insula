/**
 * An undeclared CronJob schedule is NOT in UTC.
 *
 * Kubernetes interprets a schedule with no `spec.timeZone` in the
 * kube-controller-manager's OWN zone, which on a k3s node is the host's. A
 * comment in `freshness.ts` used to claim the opposite — "Null/absent = UTC,
 * which is the k8s default" — and that one wrong word is enough to break the
 * freshness evaluator on any cluster whose host clock is not UTC: a nightly
 * `15 3 * * *` job fires at 03:15 LOCAL, the evaluator looks for it at 03:15
 * UTC, finds nothing there, and counts a missed fire every single day.
 *
 * Which is worse than noise, and the reason these cases exist:
 * `notified_verdict` latches once a stale verdict has been sent, so a standing
 * false alarm SILENCES the genuine stoppage that comes after it.
 */
import { describe, it, expect } from 'vitest';

import { resolveScheduleZone, evaluateFreshness } from './freshness.js';

describe('resolveScheduleZone', () => {
  it('prefers the zone the CronJob declares', () => {
    expect(resolveScheduleZone('Europe/Berlin', 'Africa/Windhoek')).toBe('Europe/Berlin');
  });

  it('falls back to the platform clock, NOT to UTC', () => {
    // This is the whole fix: an undeclared schedule is read in the
    // controller's zone, and the platform clock is the closest thing the API
    // can see to it.
    expect(resolveScheduleZone(null, 'Africa/Windhoek')).toBe('Africa/Windhoek');
    expect(resolveScheduleZone(undefined, 'Africa/Windhoek')).toBe('Africa/Windhoek');
    expect(resolveScheduleZone('  ', 'Africa/Windhoek')).toBe('Africa/Windhoek');
  });

  it('only reaches UTC when nothing else is known', () => {
    expect(resolveScheduleZone(null, null)).toBe('UTC');
  });
});

describe('the production false-stale, reproduced', () => {
  // 15 3 * * * in Africa/Windhoek == 01:15 UTC.
  const schedule = '15 3 * * *';
  const lastSuccess = new Date('2026-09-18T01:15:00Z'); // the run that DID happen
  const now = new Date('2026-09-18T12:59:00Z');         // when the sweep looked

  it('reports fresh when counted in the zone the job actually fires in', () => {
    const r = evaluateFreshness({
      lastSuccessAt: lastSuccess,
      cronExpression: schedule,
      now,
      timeZone: 'Africa/Windhoek',
    });
    expect(r.missedFires).toBe(0);
    expect(r.verdict).toBe('fresh');
  });

  it('reports a missed fire when wrongly counted in UTC — the bug', () => {
    // The control. If this ever stops differing from the case above, the two
    // zones have stopped mattering and the test above proves nothing.
    const r = evaluateFreshness({
      lastSuccessAt: lastSuccess,
      cronExpression: schedule,
      now,
      timeZone: 'UTC',
    });
    expect(r.missedFires).toBeGreaterThan(0);
  });
});
