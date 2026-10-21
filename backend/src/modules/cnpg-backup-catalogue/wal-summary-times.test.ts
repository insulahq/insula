/**
 * WAL times must be upload times, never the shim's placeholder.
 *
 * The shim (`rclone serve s3 --no-modtime`) lists every object with one fixed
 * time at the start of the year 2000. The WAL summary took it as each
 * segment's upload time, so on a chain with a gap "continuous until" — the
 * ceiling the restore wizard holds a point-in-time restore to — was the year
 * 2000, and every real target time read as unreachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PLACEHOLDER = new Date(Date.UTC(2000, 0, 1));
const KEYS = [1, 2, 3, 4, 6].map((n) => `postgres/system-db/wals/0000000100000000/0000000100000000000000${String(n).padStart(2, '0')}.gz`);

vi.mock('../backup-rclone-shim/service.js', () => ({
  loadBackupTargetKey: async () => ({ rawKey: Buffer.alloc(32, 1) }),
  SHIM_NAMESPACE: 'platform',
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send() {
      return { Contents: KEYS.map((Key) => ({ Key, Size: 16, LastModified: PLACEHOLDER })), IsTruncated: false };
    }
    destroy() { /* */ }
  },
  ListObjectsV2Command: class { constructor(readonly input: unknown) {} },
}));

const { getWalSummary, __clearWalSummaryCache } = await import('./wal-summary.js');

const custom = {
  getNamespacedCustomObject: async () => ({ spec: { configuration: { destinationPath: 's3://system/postgres' } } }),
} as never;

async function summary(opts: Parameters<typeof getWalSummary>[4]) {
  __clearWalSummaryCache();
  getWalSummary({} as never, custom, 'platform', 'store', { clusterName: 'system-db', ...opts });
  for (let i = 0; i < 50; i++) {
    const r = getWalSummary({} as never, custom, 'platform', 'store', { clusterName: 'system-db', ...opts });
    if (r.state !== 'measuring') return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('walk did not finish');
}

beforeEach(() => __clearWalSummaryCache());

describe('WAL summary times', () => {
  it('without the target\'s own times, a time is unknown — never the year 2000', async () => {
    const r = await summary({});
    expect(r.state).toBe('ready');
    expect(r.segmentCount).toBe(5);
    expect(r.gaps.length).toBeGreaterThan(0);
    for (const t of [r.oldestAt, r.newestAt, r.continuousUntil, r.continuousSince]) {
      expect(t === null || !t.startsWith('2000')).toBe(true);
    }
    expect(r.oldestAt).toBeNull();
    expect(r.newestAt).toBeNull();
  });

  it('takes each segment\'s time from the target, keyed by object key', async () => {
    const times = new Map(KEYS.map((k, i) => [k, new Date(Date.UTC(2026, 9, 19, 1 + i)).toISOString()]));
    const fileTimes = vi.fn(async (bucket: string, walPrefix: string) => {
      expect(bucket).toBe('system');
      expect(walPrefix).toBe('postgres/system-db/wals/');
      return times;
    });
    const r = await summary({ fileTimes });
    expect(fileTimes).toHaveBeenCalledOnce();
    expect(r.oldestAt).toBe('2026-10-19T01:00:00.000Z');
    expect(r.newestAt).toBe('2026-10-19T05:00:00.000Z');
    // The ceiling a restore is held to is a real upload time.
    expect([...times.values()]).toContain(r.continuousUntil);
  });

  it('a failed target listing falls back to unknown, not to the placeholder', async () => {
    const r = await summary({ fileTimes: async () => { throw new Error('smb down'); } });
    expect(r.state).toBe('ready');
    expect(r.segmentCount).toBe(5);
    expect(r.newestAt).toBeNull();
  });
});
