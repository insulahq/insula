import { describe, it, expect, vi } from 'vitest';
import { MAIL_SERVER_MEMORY_WINDOW_HOURS, mailServerMemoryResponseSchema } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import {
  bucketHistory,
  buildMailServerMemory,
  lastOomKill,
  NO_SAMPLES_REASON,
  readMailServerMemory,
} from './stalwart-memory.js';

const HOUR = 3600;
const GiB = 1024 ** 3;
// Deliberately not on an hour boundary.
const NOW = 1795074000;
const NOW_HOUR = Math.floor(NOW / HOUR) * HOUR;
const BUCKETS = MAIL_SERVER_MEMORY_WINDOW_HOURS + 1;

describe('bucketHistory', () => {
  // Buckets are labelled by the END of their hour; the last is the hour in progress.
  const LAST_END = NOW_HOUR + HOUR;

  it('returns one bucket per hour of the window, ending with the hour in progress, oldest first', () => {
    const points = bucketHistory([], NOW);
    expect(points).toHaveLength(BUCKETS);
    expect(points[points.length - 1].t).toBe(LAST_END);
    expect(points[0].t).toBe(LAST_END - MAIL_SERVER_MEMORY_WINDOW_HOURS * HOUR);
    expect(points.every((p) => p.bytes === null)).toBe(true);
  });

  it('puts a sample in the hour it measured, however the store aligned its steps', () => {
    // A sample at T is the maximum over (T - 1h, T]: it belongs to the bucket ending at or after T.
    const points = bucketHistory([{ labels: {}, points: [[NOW_HOUR - 2 * HOUR + 59, 5e8]] }], NOW);
    expect(points[points.length - 3]).toEqual({ t: NOW_HOUR - HOUR, bytes: 5e8 });
  });

  it('keeps the newest samples whether the store ends the range at now or rounds it up to the hour', () => {
    expect(bucketHistory([{ labels: {}, points: [[NOW, 4e8]] }], NOW).at(-1)).toEqual({ t: LAST_END, bytes: 4e8 });
    expect(bucketHistory([{ labels: {}, points: [[LAST_END, 4e8]] }], NOW).at(-1)).toEqual({ t: LAST_END, bytes: 4e8 });
  });

  it('keeps an unmeasured hour null instead of drawing it as zero', () => {
    const points = bucketHistory([{ labels: {}, points: [[NOW_HOUR, 7e8], [NOW_HOUR - 3 * HOUR, 6e8]] }], NOW);
    expect(points.slice(-5).map((p) => p.bytes)).toEqual([6e8, null, null, 7e8, null]);
  });

  it('keeps the higher value when two series land in one bucket (a restart inside the hour)', () => {
    const points = bucketHistory([
      { labels: { pod: 'old' }, points: [[NOW_HOUR, 1.9 * GiB]] },
      { labels: { pod: 'new' }, points: [[NOW_HOUR, 0.4 * GiB]] },
    ], NOW);
    expect(points[points.length - 2].bytes).toBe(1.9 * GiB);
  });

  it('drops samples outside the window and non-finite values', () => {
    const points = bucketHistory([{
      labels: {},
      points: [[LAST_END - (MAIL_SERVER_MEMORY_WINDOW_HOURS + 2) * HOUR, 1], [LAST_END + HOUR, 2], [NOW_HOUR, Number.NaN]],
    }], NOW);
    expect(points.every((p) => p.bytes === null)).toBe(true);
  });
});

describe('buildMailServerMemory', () => {
  const base = { nowEpoch: NOW, currentBytes: null, limitBytes: null, history: [], alertRatio: 0.85, lastOomKill: null };

  it('reports current, limit, peak and the alert ratio, and matches the contract', () => {
    const r = buildMailServerMemory({
      ...base,
      currentBytes: 4.6e8,
      limitBytes: 3 * GiB,
      history: [{ labels: {}, points: [[NOW_HOUR - HOUR, 1.2e9], [NOW_HOUR, 4.7e8]] }],
      lastOomKill: { at: '2026-11-19T04:32:19.000Z', inferred: false },
    });
    expect(r).toMatchObject({
      available: true, reason: null, currentBytes: 4.6e8, limitBytes: 3 * GiB, peakBytes: 1.2e9,
      alertRatio: 0.85, windowHours: MAIL_SERVER_MEMORY_WINDOW_HOURS, stepSeconds: HOUR,
      lastOomKill: { at: '2026-11-19T04:32:19.000Z', inferred: false },
    });
    expect(r.points.at(-1)?.bytes).toBe(4.6e8);
    expect(mailServerMemoryResponseSchema.parse(r)).toEqual(r);
  });

  it('never reads a peak below "now": the current sample counts for the hour in progress', () => {
    const r = buildMailServerMemory({
      ...base,
      currentBytes: 1.9 * GiB,
      history: [{ labels: {}, points: [[NOW_HOUR, 1.5 * GiB]] }],
    });
    expect(r.peakBytes).toBe(1.9 * GiB);
    expect(r.points.at(-1)?.bytes).toBe(1.9 * GiB);
  });

  it('says why when there are no samples, rather than showing zero', () => {
    const r = buildMailServerMemory(base);
    expect(r.available).toBe(false);
    expect(r.reason).toBe(NO_SAMPLES_REASON);
    expect(r.currentBytes).toBeNull();
    expect(r.peakBytes).toBeNull();
    expect(mailServerMemoryResponseSchema.parse(r)).toEqual(r);
  });

  it('is available on history alone (Stalwart down right now, but it ran this week)', () => {
    const r = buildMailServerMemory({ ...base, history: [{ labels: {}, points: [[NOW_HOUR - 5 * HOUR, 9e8]] }] });
    expect(r.available).toBe(true);
    expect(r.currentBytes).toBeNull();
    expect(r.peakBytes).toBe(9e8);
  });
});

describe('lastOomKill', () => {
  const pod = (name: string, terminated: Record<string, unknown>) => ({
    status: { containerStatuses: [{ name, lastState: { terminated } }] },
  });

  it('returns the latest memory kill of the Stalwart container', () => {
    expect(lastOomKill([
      pod('stalwart', { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-10T01:00:00Z' }),
      pod('stalwart', { reason: 'OOMKilled', exitCode: 137, finishedAt: new Date('2026-11-19T04:32:19Z') }),
    ])).toEqual({ at: '2026-11-19T04:32:19.000Z', inferred: false });
  });

  it('counts a bare SIGKILL as a kill for memory, marked as inferred', () => {
    // The kubelet does not always label a cgroup group-kill OOMKilled.
    expect(lastOomKill([pod('stalwart', { reason: 'Error', exitCode: 137, finishedAt: '2026-11-19T04:00:00Z' })]))
      .toEqual({ at: '2026-11-19T04:00:00.000Z', inferred: true });
  });

  it('ignores other containers and terminations that are not kills', () => {
    expect(lastOomKill([
      pod('rsyncd', { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-19T04:00:00Z' }),
      pod('stalwart', { reason: 'Error', exitCode: 1, finishedAt: '2026-11-19T04:00:00Z' }),
      pod('stalwart', { reason: 'Completed', exitCode: 0, finishedAt: '2026-11-19T04:00:00Z' }),
      { status: { containerStatuses: [{ name: 'stalwart' }] } },
      {},
    ])).toBeNull();
  });
});

describe('readMailServerMemory', () => {
  function vmResponse(url: string): unknown {
    const query = new URL(url).searchParams.get('query') ?? '';
    if (url.includes('/query_range')) {
      expect(query).toBe('max(max_over_time(container_memory_rss{namespace="mail",container="stalwart"}[1h]))');
      expect(Number(new URL(url).searchParams.get('start'))).toBe(NOW_HOUR + HOUR - MAIL_SERVER_MEMORY_WINDOW_HOURS * HOUR);
      return { status: 'success', data: { result: [{ metric: {}, values: [[NOW_HOUR, '470000000']] }] } };
    }
    if (query.startsWith('max(last_over_time(container_spec_memory_limit_bytes')) {
      return { status: 'success', data: { result: [{ metric: {}, value: [NOW, String(3 * GiB)] }] } };
    }
    expect(query).toBe('max(last_over_time(container_memory_rss{namespace="mail",container="stalwart"}[2m]))');
    return { status: 'success', data: { result: [{ metric: {}, value: [NOW, '466000000'] }] } };
  }

  const fetchFn = vi.fn(async (url: string | URL | Request) => ({
    ok: true,
    status: 200,
    json: async () => vmResponse(String(url)),
  })) as unknown as typeof fetch;

  function dbWith(rows: unknown[]): Database {
    return { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Database;
  }

  const core = (items: unknown[] | Error) => ({
    listNamespacedPod: vi.fn(async () => {
      if (items instanceof Error) throw items;
      return { items };
    }),
  }) as never;

  it('combines the metrics store, the rule threshold and the pod status', async () => {
    const r = await readMailServerMemory({
      db: dbWith([]),
      core: core([{ status: { containerStatuses: [{ name: 'stalwart', lastState: { terminated: { reason: 'OOMKilled', finishedAt: '2026-11-19T04:32:19Z' } } }] } }]),
      vm: { baseUrl: 'http://vm.test/metrics', fetchFn },
      now: () => NOW * 1000,
    });
    expect(r).toMatchObject({
      available: true, currentBytes: 466000000, limitBytes: 3 * GiB, peakBytes: 470000000,
      alertRatio: 0.85, lastOomKill: { at: '2026-11-19T04:32:19.000Z', inferred: false },
    });
  });

  it('draws the operator override, and no threshold when the rule is disabled', async () => {
    const opts = { core: core([]), vm: { baseUrl: 'http://vm.test/metrics', fetchFn }, now: () => NOW * 1000 };
    expect((await readMailServerMemory({ ...opts, db: dbWith([{ enabled: true, threshold: 0.75 }]) })).alertRatio).toBe(0.75);
    expect((await readMailServerMemory({ ...opts, db: dbWith([{ enabled: false, threshold: 0.75 }]) })).alertRatio).toBeNull();
  });

  it('still answers when the pod read fails, and logs it', async () => {
    const warn = vi.fn();
    const r = await readMailServerMemory({
      db: dbWith([]),
      core: core(new Error('forbidden')),
      vm: { baseUrl: 'http://vm.test/metrics', fetchFn },
      now: () => NOW * 1000,
      logger: { warn },
    });
    expect(r.currentBytes).toBe(466000000);
    expect(r.lastOomKill).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('throws when the metrics store fails: "could not read" is not "no samples"', async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(readMailServerMemory({
      db: dbWith([]),
      core: core([]),
      vm: { baseUrl: 'http://vm.test/metrics', fetchFn: failing },
      now: () => NOW * 1000,
    })).rejects.toThrow(/HTTP 502/);
  });
});
