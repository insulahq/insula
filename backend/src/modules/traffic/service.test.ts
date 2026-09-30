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

const { fetchTrafficFrame, disambiguateNames, prettyServiceName, prettyPodName, aggregateByName } = await import('./service.js');
const { podMatcher } = await import('./promql.js');

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

describe('the cluster view keeps both directions', () => {
  it('returns Inbound at the wire even when backups are separated', async () => {
    // The panel forces `separate` for cluster traffic, and the
    // egress-only rule for backup splits then removed Inbound from the
    // wire — on every cluster view, while an API call with the default
    // `included` still looked correct.
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'separate',
    }, { db });
    const wire = frame.series.filter((s) => s.group === 'wire').map((s) => s.name);
    expect(wire).toEqual(['Outbound (wire)', 'Inbound (wire)']);
  });

  it('still collapses to one direction for a backup split OFF the cluster view', async () => {
    await fetchTrafficFrame({
      ...range, scope: 'tenant', metric: 'traffic', direction: 'both', backups: 'separate',
    }, { db });
    expect(asked.filter((e) => e.includes('receive'))).toHaveLength(0);
  });
});

describe('row order', () => {
  it('keeps a measurement’s two directions adjacent', async () => {
    // Gathered direction-major, Node-to-node (in) landed after an unrelated
    // row instead of beside its own (out).
    const frame = await fetchTrafficFrame({
      ...range, scope: 'cluster', metric: 'traffic', direction: 'both', backups: 'separate',
    }, { db });
    const names = frame.series.map((s) => s.name);
    const n2nOut = names.indexOf('Node-to-node (out)');
    const n2nIn = names.indexOf('Node-to-node (in)');
    expect(n2nOut).toBeGreaterThanOrEqual(0);
    expect(n2nIn).toBe(n2nOut + 1);
    expect(names.indexOf('Outbound (wire)')).toBeLessThan(names.indexOf('Inbound (wire)'));
  });
});

describe('disambiguateNames', () => {
  it('leaves unique names untouched', () => {
    const rows = [{ key: 'a', name: 'Alpha' }, { key: 'b', name: 'Beta' }];
    expect(disambiguateNames(rows).map((r) => r.name)).toEqual(['Alpha', 'Beta']);
  });

  it('separates colliding names by number, without showing a hash', () => {
    // Real case: two routes inside one ingress object differ only by the
    // hash Traefik derives from the match rule. They have to be told apart,
    // but eight characters of that hash names a row after an implementation
    // detail nobody can look up — so they are numbered instead.
    const rows = [
      { key: 'out:platform-platform-ingress-dfcb3e698c83816be48f@kubernetescrd', name: 'platform-ingress' },
      { key: 'out:platform-platform-ingress-bd9f21e8c15075f5f289@kubernetescrd', name: 'platform-ingress' },
    ];
    const out = disambiguateNames(rows).map((r) => r.name);
    expect(new Set(out).size).toBe(2);
    expect(out).toEqual(['platform-ingress #1', 'platform-ingress #2']);
    expect(out.join(' ')).not.toMatch(/[0-9a-f]{8}/);
  });

  it('strips the hash and the doubled namespace from a platform route', () => {
    // `platform-platform-ingress-dfcb3e698c83816be48f@kubernetescrd` is the
    // namespace, the object named after the namespace, and a rule hash. None
    // of those three things is worth showing an operator.
    expect(prettyServiceName('platform-platform-ingress-dfcb3e698c83816be48f@kubernetescrd', new Map()))
      .toBe('platform');
    expect(prettyServiceName('mail-platform-webmail-ingress-92a47957fdd54f9cc8d4@kubernetescrd', new Map()))
      .toBe('mail-platform-webmail');
  });

  it('numbers collisions even when the keys share no hash', () => {
    const rows = [{ key: 'x:one', name: 'Same' }, { key: 'x:two', name: 'Same' }];
    expect(new Set(disambiguateNames(rows).map((r) => r.name)).size).toBe(2);
  });

  it('is applied to the frame, so no route view can repeat a name', async () => {
    vi.resetModules();
    vi.doMock('../monitoring/vm-client.js', () => ({
      queryRange: () => Promise.resolve([
        { labels: { service: 'platform-a-ingress-dfcb3e698c83816be48f@kubernetescrd' }, points: [[Math.floor(Date.now() / 1000), 1]] },
        { labels: { service: 'platform-a-ingress-bd9f21e8c15075f5f289@kubernetescrd' }, points: [[Math.floor(Date.now() / 1000), 2]] },
      ]),
      queryInstant: () => Promise.resolve([]),
    }));
    const { fetchTrafficFrame: fresh } = await import('./service.js');
    const frame = await fresh({
      ...range, scope: 'route', metric: 'traffic', direction: 'out', backups: 'included',
    }, { db });
    const names = frame.series.map((s) => s.name);
    expect(new Set(names).size, names.join(', ')).toBe(names.length);
    vi.doUnmock('../monitoring/vm-client.js');
    vi.resetModules();
  });
});

describe('prettyPodName', () => {
  it('shows the application, not the pod', () => {
    // The two the operator reported, verbatim.
    expect(prettyPodName('website-589bc77f7-q2hrk')).toBe('website');
    expect(prettyPodName('file-manager-655bc877b9-przdh')).toBe('file-manager');
  });

  it('keeps a name that is not a Deployment pod', () => {
    // A StatefulSet ordinal IS the identity — `system-db-1` and
    // `system-db-2` are different pods and must not both read `system-db`.
    expect(prettyPodName('system-db-1')).toBe('system-db-1');
    // A bare Job pod: one generated segment, not two. Folding it would risk
    // merging two different jobs into one row.
    expect(prettyPodName('bk-files-bkp-1a2b-wvh4t')).toBe('bk-files-bkp-1a2b-wvh4t');
    // Nothing generated at all.
    expect(prettyPodName('nginx')).toBe('nginx');
  });

  it('does not eat a real name that merely looks generated', () => {
    // Five-char last segment but a too-short middle: not the Deployment
    // shape, so it survives.
    expect(prettyPodName('api-v2-alpha')).toBe('api-v2-alpha');
  });
});

describe('pod rows are per application', () => {
  it('folds replicas of one Deployment into a single series', () => {
    const rows = [
      { key: 'out:file-manager-655bc877b9-przdh', name: 'file-manager', points: [1, 2, 3] },
      { key: 'out:file-manager-655bc877b9-k2r8p', name: 'file-manager', points: [10, 20, 30] },
      { key: 'out:website-589bc77f7-q2hrk', name: 'website', points: [5, 5, 5] },
    ];
    const out = aggregateByName(rows);
    expect(out).toHaveLength(2);
    const fm = out.find((r) => r.name === 'file-manager');
    expect(fm?.points).toEqual([11, 22, 33]);
    // The key becomes the application, because that is what the picker
    // sends back as `pod=` now.
    expect(fm?.key).toBe('file-manager');
  });

  it('a gap in ONE replica does not blank the application', () => {
    const rows = [
      { key: 'a', name: 'app', points: [null, 2, null] },
      { key: 'b', name: 'app', points: [10, null, null] },
    ];
    // Unmeasured in every replica stays unmeasured — a break, not a zero.
    expect(aggregateByName(rows)[0].points).toEqual([10, 2, null]);
  });
});

describe('podMatcher', () => {
  it('selects every pod of an application', () => {
    expect(podMatcher('file-manager')).toBe('pod=~"file-manager-[a-z0-9]{6,10}-[a-z0-9]{5}"');
  });

  it('still accepts one exact pod', () => {
    expect(podMatcher('website-589bc77f7-q2hrk')).toBe('pod="website-589bc77f7-q2hrk"');
  });

  it('cannot reach across an application boundary', () => {
    // `website` must not select `website-admin`'s pods. Neither generated
    // segment may contain a hyphen, and PromQL anchors =~ at both ends.
    const m = podMatcher('website');
    const re = new RegExp(`^${m.slice('pod=~"'.length, -1)}$`);
    expect(re.test('website-589bc77f7-q2hrk')).toBe(true);
    expect(re.test('website-admin-655bc877b9-przdh')).toBe(false);
  });
});
