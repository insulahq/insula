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

describe('backup split', () => {
  it('produces ONE serving row, not one per direction', async () => {
    // With direction 'both' the split ran twice and the table showed
    // "Serving traffic" twice — seen on DEV before this was fixed.
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'separate',
    }, { db });
    const serving = frame.series.filter((s) => s.name === 'Serving traffic');
    expect(serving).toHaveLength(1);
    expect(new Set(frame.series.map((s) => s.key)).size).toBe(frame.series.length);
  });

  it('asks for serving plus one query per backup class', async () => {
    await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'separate',
    }, { db });
    expect(asked).toHaveLength(5);
    expect(asked.filter((e) => e.includes('pod!~')).length).toBe(1);
  });

  it('asks only for the classes when the mode is "only"', async () => {
    await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'only',
    }, { db });
    expect(asked).toHaveLength(4);
    expect(asked.some((e) => e.includes('pod!~'))).toBe(false);
  });

  it('still draws both directions when backups are included', async () => {
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'included',
    }, { db });
    expect(frame.series.map((s) => s.name).sort()).toEqual(['Inbound', 'Outbound']);
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
