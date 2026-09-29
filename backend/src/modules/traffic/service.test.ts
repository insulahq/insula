/**
 * Frame assembly — the parts an end-to-end run on DEV caught.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let asked: string[] = [];
vi.mock('../monitoring/vm-client.js', () => ({
  queryRange: (expr: string) => {
    asked.push(expr);
    // One flat series per query, labelled so grouping can be observed.
    const now = Math.floor(Date.now() / 1000);
    return Promise.resolve([{ labels: {}, points: [[now - 600, 1], [now - 300, 1]] }]);
  },
  queryInstant: () => Promise.resolve([]),
}));

const { fetchTrafficFrame } = await import('./service.js');

const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]), then: (r: (v: unknown) => void) => r([]) }) }) } as never;
const range = { from: new Date(Date.now() - 3_600_000), to: new Date() };

beforeEach(() => { asked = []; });

describe('the cluster frame is two measurements, labelled', () => {
  it('reports the wire, its subsets, and the workload view — never blended', async () => {
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    const groups = new Map<string, string[]>();
    for (const s of frame.series) {
      const g = s.group ?? 'none';
      groups.set(g, [...(groups.get(g) ?? []), s.name]);
    }
    // The wire is the ground truth, in both directions.
    expect(groups.get('wire')).toEqual(['Outbound (wire)', 'Inbound (wire)']);
    // Subsets of that same total — present, and marked so nothing adds them in.
    expect(groups.get('wire-subset')).toContain('Node-to-node (out)');
    expect(groups.get('wire-subset')).toContain('Off-site backup upload');
    // What each workload sent: double-counts through the shim, so it is a
    // separate group rather than a decomposition of the wire.
    expect(groups.get('workload')).toContain('Tenant workloads sent');
    expect(groups.get('workload')).toContain('Backup · tenant bundles');
    expect(groups.get('workload')).toContain('Backup · mail server snapshots');
  });

  it('never repeats a series key OR a series NAME', async () => {
    // Unique keys are not enough: the table shows names, and the first
    // build put five rows called "Tenant workloads sent" and two called
    // "Node-to-node" in front of the operator. Only looking at it caught
    // that — every assertion passed.
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    const keys = frame.series.map((s) => s.key);
    const names = frame.series.map((s) => s.name);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(names).size, `duplicate name in: ${names.join(', ')}`).toBe(names.length);
  });

  it('sums tenant serving into ONE line rather than one per namespace', async () => {
    await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db });
    const serving = asked.filter((e) => e.includes('pod!~'));
    expect(serving).toHaveLength(1);
    expect(serving[0]).not.toContain('sum by (namespace)');
  });

  it('asks for the off-site and workload rows once, not once per direction', async () => {
    // They are egress by nature; running them for inbound too produced
    // duplicate identically-named rows the first time round.
    await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    // Match the SELECTOR, not any mention: the "tenant workloads" query also
    // names these pods, in its exclusion.
    expect(asked.filter((e) => e.includes('pod=~"backup-rclone'))).toHaveLength(1);
    expect(asked.filter((e) => e.includes('pod=~"bk-(files|mbox)'))).toHaveLength(1);
    expect(asked.filter((e) => e.includes('pod!~'))).toHaveLength(1);
  });

  it('leaves non-cluster scopes as a plain single measurement', async () => {
    const frame = await fetchTrafficFrame({
      ...range, scope: 'node', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    expect(frame.series.every((s) => s.group === undefined)).toBe(true);
  });
});

describe('a namespace with no tenant record', () => {
  it('is named for what it is, not printed as somebody’s name', async () => {
    const orphanDb = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([]), then: (r: (v: unknown) => void) => r([]) }),
      }),
    } as never;
    vi.doMock('../monitoring/vm-client.js', () => ({
      queryRange: () => Promise.resolve([{ labels: { namespace: 'tenant-gone-ns' }, points: [[Math.floor(Date.now() / 1000), 5]] }]),
      queryInstant: () => Promise.resolve([]),
    }));
    vi.resetModules();
    const { fetchTrafficFrame: fresh } = await import('./service.js');
    const frame = await fresh({
      ...range, scope: 'tenant', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db: orphanDb });
    expect(frame.series[0]?.name).toContain('no tenant record');
    vi.doUnmock('../monitoring/vm-client.js');
    vi.resetModules();
  });
});

describe('a subject breakdown across both directions', () => {
  it('never lists two rows with the same name', async () => {
    // Keys differed but names did not, so the table showed the same tenant
    // twice with no way to tell the rows apart — seen on DEV as "SYSTEM,
    // SYSTEM" — and the top-N fold then ranked LINES rather than subjects.
    vi.resetModules();
    vi.doMock('../monitoring/vm-client.js', () => ({
      queryRange: () => Promise.resolve([
        { labels: { namespace: 'tenant-one-ns' }, points: [[Math.floor(Date.now() / 1000), 5]] },
        { labels: { namespace: 'tenant-two-ns' }, points: [[Math.floor(Date.now() / 1000), 3]] },
      ]),
      queryInstant: () => Promise.resolve([]),
    }));
    const { fetchTrafficFrame: fresh } = await import('./service.js');
    const frame = await fresh({
      ...range, scope: 'tenant', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    const names = frame.series.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => / · (in|out)$/.test(n))).toBe(true);
    vi.doUnmock('../monitoring/vm-client.js');
    vi.resetModules();
  });

  it('leaves a single-direction breakdown unlabelled — there is nothing to tell apart', async () => {
    vi.resetModules();
    vi.doMock('../monitoring/vm-client.js', () => ({
      queryRange: () => Promise.resolve([
        { labels: { namespace: 'tenant-one-ns' }, points: [[Math.floor(Date.now() / 1000), 5]] },
      ]),
      queryInstant: () => Promise.resolve([]),
    }));
    const { fetchTrafficFrame: fresh } = await import('./service.js');
    const frame = await fresh({
      ...range, scope: 'tenant', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db });
    expect(frame.series[0].name).not.toMatch(/ · (in|out)$/);
    vi.doUnmock('../monitoring/vm-client.js');
    vi.resetModules();
  });
});
