import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStandbyReports, recordStandbyReport } from './standby-reports.js';

// Lightweight stub of the Drizzle chain used by the module. Captures
// the SET value we'd push to UPDATE so the test can assert what the
// SQL snippet looks like without spinning up Postgres.
function buildDbStub(initialReports: Record<string, unknown> | null) {
  const calls: { setArg?: unknown } = {};
  let updateState: Record<string, unknown> | null = initialReports;
  const stub = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ reports: updateState }],
        }),
      }),
    }),
    update: () => ({
      set: (arg: { mailStandbyReports: unknown }) => {
        calls.setArg = arg.mailStandbyReports;
        // Smoke: the SQL snippet should reference jsonb_set
        // and the input node key. We don't execute it.
        return { where: async () => undefined };
      },
    }),
  };
  return { stub, calls, setReports: (r: typeof initialReports) => { updateState = r; } };
}

describe('mail-admin standby-reports', () => {
  beforeEach(() => vi.useRealTimers());

  it('getStandbyReports returns empty list when column is NULL', async () => {
    const { stub } = buildDbStub(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getStandbyReports(stub as any);
    expect(out).toEqual([]);
  });

  it('getStandbyReports adds ageSeconds + sorts by node', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T00:10:00Z'));
    const { stub } = buildDbStub({
      'staging3': {
        sizeBytes: 20_000_000,
        fileCount: 60,
        durationSeconds: 1,
        reportedAt: '2026-05-26T00:08:00Z',
      },
      'staging1': {
        sizeBytes: 18_000_000,
        fileCount: 59,
        durationSeconds: 1,
        reportedAt: '2026-05-26T00:09:00Z',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getStandbyReports(stub as any);
    expect(out.map((r) => r.node)).toEqual(['staging1', 'staging3']);
    expect(out[0].ageSeconds).toBe(60);
    expect(out[1].ageSeconds).toBe(120);
  });

  it('getStandbyReports clamps negative age to 0 if clock skew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T00:00:00Z'));
    const { stub } = buildDbStub({
      'staging1': {
        sizeBytes: 1,
        fileCount: 1,
        durationSeconds: 1,
        // Reported "in the future" — e.g. node clock ahead
        reportedAt: '2026-05-26T00:05:00Z',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await getStandbyReports(stub as any);
    expect(out[0].ageSeconds).toBe(0);
  });

  it('recordStandbyReport invokes set() with mailStandbyReports SQL snippet', async () => {
    const { stub, calls } = buildDbStub({});
    await recordStandbyReport(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stub as any,
      { node: 'staging2', sizeBytes: 1234, fileCount: 5, durationSeconds: 2 },
    );
    // The set argument is a Drizzle SQL object; just smoke-check
    // that something was passed.
    expect(calls.setArg).toBeDefined();
  });
});
