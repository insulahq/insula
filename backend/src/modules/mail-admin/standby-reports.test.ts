import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCurrentStandbyReports, getStandbyReports, recordStandbyReport } from './standby-reports.js';

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

describe('getCurrentStandbyReports — the nodes that are standbys now', () => {
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  const r = (reportedAt: string) => ({ sizeBytes: 1, fileCount: 1, durationSeconds: 0, reportedAt });
  const STANDBY = { 'insula.host/mail-standby': 'true' };
  const SINCE = 'insula.host/mail-standby-since';
  const running = (node: string) => ({ spec: { nodeName: node }, status: { phase: 'Running', containerStatuses: [{ state: { running: {} } }] } });
  // Every labelled node's copier runs unless a test says otherwise.
  const cluster = (nodes: Array<{ metadata: Record<string, unknown> }>, pods = nodes.map((n) => running(n.metadata.name as string))) => ({
    listNodes: async () => nodes as never,
    listCopierPods: async () => pods,
  });

  it('leaves out a node that is no longer a standby, and lists one still on its first copy', async () => {
    // Production after moving the standby from one node to another: the old one kept its last
    // report and showed red for good.
    const { stub } = buildDbStub({ old: r(at(6 * 3600)), current: r(at(60)) });
    const view = await getCurrentStandbyReports(stub as never, cluster([
      { metadata: { name: 'old', labels: {} } },
      { metadata: { name: 'current', labels: STANDBY } },
      { metadata: { name: 'new', labels: STANDBY, annotations: { [SINCE]: at(300) } } },
    ]));
    expect(view.reports.map((x) => x.node)).toEqual(['current']);
    expect(view.preparing).toEqual([{ node: 'new', since: expect.any(String), state: 'preparing' }]);
  });

  it('a report from before a node became a standby again leaves it preparing', async () => {
    const { stub } = buildDbStub({ back: r(at(86_400)) });
    const view = await getCurrentStandbyReports(stub as never, cluster([
      { metadata: { name: 'back', labels: STANDBY, annotations: { [SINCE]: at(120) } } },
    ]));
    expect(view.reports).toEqual([]);
    expect(view.preparing.map((p) => p.node)).toEqual(['back']);
  });

  it('says a first copy whose copier is not running is not preparing', async () => {
    const { stub } = buildDbStub({});
    const view = await getCurrentStandbyReports(stub as never, cluster([
      { metadata: { name: 'stuck', labels: STANDBY, annotations: { [SINCE]: at(15 * 60) } } },
      { metadata: { name: 'starting', labels: STANDBY, annotations: { [SINCE]: at(60) } } },
    ], []));
    expect(view.preparing).toEqual([
      { node: 'starting', since: expect.any(String), state: 'preparing' },
      { node: 'stuck', since: expect.any(String), state: 'not_running' },
    ]);
  });

  it('finds a report filed under the hostname label', async () => {
    const { stub } = buildDbStub({ 'sb-host': r(at(30)) });
    const view = await getCurrentStandbyReports(stub as never, cluster([
      { metadata: { name: 'sb-node.example.test', labels: { ...STANDBY, 'kubernetes.io/hostname': 'sb-host' } } },
    ]));
    expect(view.reports.map((x) => x.node)).toEqual(['sb-host']);
  });

  it('returns every report when the nodes cannot be listed — not an empty tile', async () => {
    const { stub } = buildDbStub({ a: r(at(10)), b: r(at(20)) });
    const view = await getCurrentStandbyReports(stub as never, {
      listNodes: async () => { throw new Error('apiserver unavailable'); },
      listCopierPods: async () => [],
    });
    expect(view.reports.map((x) => x.node)).toEqual(['a', 'b']);
    expect(view.preparing).toEqual([]);
  });
});
