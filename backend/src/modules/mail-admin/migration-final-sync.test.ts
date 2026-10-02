/**
 * Which migrations copy the quiet source volume to the target before the swap
 * (Step 3b, final-sync.ts). Every arm is negative-tested.
 */
import { describe, it, expect } from 'vitest';
import { shouldRunFinalSync } from './migration.js';

const planned = { sourceNodeReachable: true, recoverFromBrokenState: false, restoreSnapshotId: null, sameNode: false };

describe('shouldRunFinalSync', () => {
  it('a planned move of the live store (operator migrate, failback) → yes', () => {
    expect(shouldRunFinalSync(planned)).toBe(true);
  });
  it('source node down (DR failover) → no: nothing to copy from; the standby RPO applies', () => {
    expect(shouldRunFinalSync({ ...planned, sourceNodeReachable: false })).toBe(false);
  });
  it('recovery mode (the source store is what is broken) → no', () => {
    expect(shouldRunFinalSync({ ...planned, recoverFromBrokenState: true })).toBe(false);
  });
  it('restoring a chosen snapshot (deliberately older data) → no', () => {
    expect(shouldRunFinalSync({ ...planned, restoreSnapshotId: 'abc123' })).toBe(false);
  });
  it('same-node restore → no', () => {
    expect(shouldRunFinalSync({ ...planned, sameNode: true })).toBe(false);
  });
});
