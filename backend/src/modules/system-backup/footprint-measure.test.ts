import { describe, it, expect, vi } from 'vitest';

vi.mock('../system-settings/cluster-id.js', () => ({ getClusterId: async () => 'c1' }));
const { walkPrefixes, summarise, systemPrefixes } = await import('./footprint-measure.js');
type ListPage = import('./footprint-measure.js').ListPage;

const T = [
  { name: 'postgres', bucket: 'system', prefix: 'c1/postgres/' },
  { name: 'etcd', bucket: 'system', prefix: 'etcd/c1/' },
];

/** Pages of `n` objects of `size` bytes; `pages` pages per prefix. */
const pager = (pages: number, n: number, size: number, failFor?: string): ListPage => async (_b, prefix, token) => {
  if (prefix === failFor) throw new Error('NoSuchBucket');
  const i = token ? Number(token) : 0;
  return { contents: Array.from({ length: n }, () => ({ Size: size })), next: i + 1 < pages ? String(i + 1) : undefined };
};

describe('walkPrefixes', () => {
  it('sums every page of every prefix', async () => {
    const parts = await walkPrefixes(T, pager(3, 1000, 10), { deadlineAt: Date.now() + 60_000 });
    expect(parts.map((p) => [p.name, p.bytes, p.objects, p.truncated])).toEqual([
      ['postgres', 30_000, 3000, false],
      ['etcd', 30_000, 3000, false],
    ]);
  });

  it('a page cap makes the figure a floor, not a silent undercount', async () => {
    const parts = await walkPrefixes(T, pager(5, 10, 1), { deadlineAt: Date.now() + 60_000, maxPages: 2 });
    expect(parts[0]).toMatchObject({ objects: 20, truncated: true });
  });

  it('the deadline stops the walk and marks it truncated', async () => {
    let t = 0;
    const parts = await walkPrefixes(T, pager(5, 10, 1), { deadlineAt: 2, now: () => t++ });
    expect(parts.every((p) => p.truncated)).toBe(true);
  });

  it('one unlistable prefix does not hide the others', async () => {
    const parts = await walkPrefixes(T, pager(1, 2, 7, 'etcd/c1/'), { deadlineAt: Date.now() + 60_000 });
    expect(parts[0]).toMatchObject({ bytes: 14, error: null });
    expect(parts[1]).toMatchObject({ bytes: 0, error: 'NoSuchBucket' });
    // …but the total is then only a floor, and says so.
    const sum = summarise(parts, new Date('2026-10-04T12:00:00Z'));
    expect(sum).toMatchObject({ totalBytes: 14, error: null, truncated: true });
  });

  it('nothing listable at all is an error, not a size of 0', async () => {
    const parts = await walkPrefixes(T, async () => { throw new Error('connection refused'); }, { deadlineAt: Date.now() + 60_000 });
    const sum = summarise(parts, new Date());
    expect(sum.error).toMatch(/could not be listed: postgres: connection refused; etcd: connection refused/);
  });
});

describe('systemPrefixes', () => {
  const custom = (behaviour: 'ok' | 404 | 500) => ({
    getNamespacedCustomObject: async () => {
      if (behaviour === 'ok') return { spec: { configuration: { destinationPath: 's3://system/wal-archive/platform-system-db' } } };
      throw Object.assign(new Error(behaviour === 404 ? 'not found' : 'apiserver timeout'), { code: behaviour });
    },
  }) as unknown as Parameters<typeof systemPrefixes>[1];

  it('measures the object store prefix, etcd for this cluster, and the DR bundles', async () => {
    const { targets, failed } = await systemPrefixes({} as never, custom('ok'));
    expect(targets.map((t) => `${t.name}=${t.bucket}/${t.prefix}`)).toEqual([
      'postgres=system/wal-archive/platform-system-db/', 'etcd=system/etcd/c1/', 'dr=system/dr/',
    ]);
    expect(failed).toEqual([]);
  });

  it('no object store (404): database backups were never configured — nothing missing', async () => {
    const { targets, failed } = await systemPrefixes({} as never, custom(404));
    expect(targets.map((t) => t.name)).toEqual(['etcd', 'dr']);
    expect(failed).toEqual([]);
  });

  it('an unreadable object store is a FAILED part, so the total becomes a floor', async () => {
    const { failed } = await systemPrefixes({} as never, custom(500));
    expect(failed).toEqual([expect.objectContaining({ name: 'postgres', error: expect.stringMatching(/apiserver timeout/) })]);
    expect(summarise([...failed, { name: 'etcd', prefix: 'system/etcd/c1/', bytes: 5, objects: 1, truncated: false, error: null }], new Date()).truncated).toBe(true);
  });
});
