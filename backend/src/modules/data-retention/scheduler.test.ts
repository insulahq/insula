import { describe, it, expect, vi, afterEach } from 'vitest';
import { startDataRetention, TABLE_LABELS } from './scheduler.js';
import type { DataRetentionResult } from './service.js';

/**
 * These tests exist because the log line silently drifted.
 *
 * `runOnce` used a HAND-WRITTEN sum of every counter to decide whether to log,
 * with a comment warning that "a table missing from this total is a table whose
 * pruning is invisible in the logs". On 2026-09-11 two new counters
 * (crowdsec_autoban_runs, sftp_audit_log) were added to DataRetentionResult and
 * not to that sum — so a cycle that pruned only those two would have reported
 * NOTHING, which is the exact failure the comment warns about, reintroduced by
 * the change that was fixing unbounded tables.
 *
 * The fix derives the total from the result object. The guard below is what
 * makes that stick: it builds the result from the TYPE's own field list, so a
 * future counter is covered without anyone remembering to update a test.
 */

// Derived from the scheduler's own label map, which is typed
// `Record<keyof DataRetentionResult, string>` — so a counter added to the
// result without a label fails to compile, and this list cannot fall behind.
//
// NOT written as a `const _exhaustive: ... = true` check in this file:
// backend/tsconfig.json excludes **/*.test.ts, so a type-level assertion here
// is never evaluated by `npm run typecheck` and only looks like protection.
const RESULT_FIELDS = Object.keys(TABLE_LABELS) as Array<keyof DataRetentionResult>;

function zeroResult(): DataRetentionResult {
  return Object.fromEntries(RESULT_FIELDS.map((f) => [f, 0])) as unknown as DataRetentionResult;
}

const mocks = vi.hoisted(() => ({ runDataRetention: vi.fn() }));
vi.mock('./service.js', () => ({ runDataRetention: mocks.runDataRetention }));

/** Run one cycle and return whatever was logged. */
async function logsForOneCycle(result: DataRetentionResult): Promise<string[]> {
  mocks.runDataRetention.mockResolvedValueOnce(result);
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  const timer = startDataRetention({} as never); // fires once immediately
  await vi.waitFor(() => expect(mocks.runDataRetention).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0)); // let the await in runOnce settle
  clearInterval(timer);
  spy.mockRestore();
  return lines;
}

afterEach(() => { vi.clearAllMocks(); });

describe('data-retention scheduler logging', () => {
  // The regression, stated per-field: pruning ANY single table must be visible.
  // Written as a loop over the type's fields so a counter added later is
  // covered automatically — the previous drift happened precisely because a
  // hand-maintained list was not updated.
  for (const field of RESULT_FIELDS) {
    it(`reports a cycle that pruned ONLY ${field}`, async () => {
      const result = { ...zeroResult(), [field]: 7 } as DataRetentionResult;
      const lines = await logsForOneCycle(result);
      expect(lines.join('\n')).toContain('[data-retention] pruned');
      expect(lines.join('\n')).toContain('7 ');
    });
  }

  it('stays silent when nothing was pruned', async () => {
    const lines = await logsForOneCycle(zeroResult());
    expect(lines.filter((l) => l.includes('[data-retention]'))).toEqual([]);
  });

  it('names the two tables added 2026-09-11 by their SQL names', async () => {
    const lines = await logsForOneCycle({
      ...zeroResult(), crowdsecAutobanRuns: 3, sftpAuditLogRows: 2,
    } as DataRetentionResult);
    const out = lines.join('\n');
    expect(out).toContain('3 crowdsec_autoban_runs');
    expect(out).toContain('2 sftp_audit_log');
  });
});
