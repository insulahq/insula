import { describe, it, expect } from 'vitest';
import {
  parseUnlockOutput,
  UNLOCK_BEFORE_SENTINEL,
  UNLOCK_OUTPUT_SENTINEL,
  UNLOCK_AFTER_SENTINEL,
} from './backups.js';

/**
 * Clearing stale locks from the product instead of kubectl.
 *
 * The count is taken BEFORE and AFTER rather than read off restic's own
 * "successfully removed N locks" line, because the case that matters most is the
 * one where a lock SURVIVES: plain `unlock` leaves locks whose owner is still
 * alive, and that is exactly when an operator must stop pulling the lever rather
 * than escalate to `--remove-all`, which would corrupt a backup in flight.
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function out(before: string[], unlockOut: string, after: string[]): string {
  return [
    ...before,
    UNLOCK_BEFORE_SENTINEL,
    unlockOut,
    UNLOCK_OUTPUT_SENTINEL,
    UNLOCK_AFTER_SENTINEL,
    ...after,
  ].join('\n');
}

describe('parseUnlockOutput', () => {
  it('reports the DEV case: two stale locks cleared', () => {
    const r = parseUnlockOutput(out([A, B], 'successfully removed 2 locks', []));
    expect(r.locksBefore).toBe(2);
    expect(r.locksAfter).toBe(0);
    expect(r.removed).toBe(2);
    expect(r.message).toMatch(/Cleared 2 stale lock/);
    expect(r.output).toBe('successfully removed 2 locks');
  });

  it('says plainly when there was nothing to clear', () => {
    const r = parseUnlockOutput(out([], 'successfully removed 0 locks', []));
    expect(r.locksBefore).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.message).toMatch(/was not locked/);
  });

  it('tells the operator to WAIT when a lock survives, not to force', () => {
    // A surviving lock is held by a live process. This message is the whole
    // reason the counts are taken twice.
    const r = parseUnlockOutput(out([A, B], 'successfully removed 1 locks', [B]));
    expect(r.locksBefore).toBe(2);
    expect(r.locksAfter).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.message).toMatch(/still running/);
    expect(r.message).toMatch(/in flight/);
  });

  it('never reports a negative removal if locks appear mid-run', () => {
    // A snapshot starting between the two counts is normal, not an error.
    const r = parseUnlockOutput(out([A], 'successfully removed 0 locks', [A, B]));
    expect(r.removed).toBe(0);
    expect(r.locksAfter).toBe(2);
  });

  it('ignores restic warnings that are not lock ids', () => {
    const r = parseUnlockOutput(
      out(['Warning: old repo format', A], 'removed', ['Warning: old repo format']),
    );
    expect(r.locksBefore).toBe(1);
    expect(r.locksAfter).toBe(0);
  });

  it('fails loudly on unrecognised output rather than reporting a clean repo', () => {
    // An older image emits no sentinels. Reading that as "0 locks, all good"
    // would be the same false-green this work exists to remove.
    expect(() => parseUnlockOutput('some totally different output')).toThrow(/unrecognised output/);
  });

  it('surfaces restic errors verbatim for the operator', () => {
    const r = parseUnlockOutput(out([A], 'Fatal: unable to open repository: Access Denied', [A]));
    expect(r.output).toMatch(/Access Denied/);
    expect(r.locksAfter).toBe(1);
  });
});
