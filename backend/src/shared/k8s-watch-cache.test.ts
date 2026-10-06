import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as k8s from '@kubernetes/client-node';
import { WatchCache, listPodsCached } from './k8s-watch-cache.js';

type OnEvent = (phase: string, obj: unknown) => void;
type OnDone = (err: unknown) => void;

/** A watch we drive by hand: each call to watch() is one stream. */
function fakeWatcher() {
  const streams: Array<{ query: Record<string, unknown>; onEvent: OnEvent; onDone: OnDone; aborted: boolean }> = [];
  return {
    streams,
    watcher: {
      watch: vi.fn(async (_path: string, query: Record<string, unknown>, onEvent: OnEvent, onDone: OnDone) => {
        const s = { query, onEvent, onDone, aborted: false };
        streams.push(s);
        return { abort: () => { s.aborted = true; } };
      }),
    },
  };
}

const rawPod = (name: string, rv: string, phase = 'Running') => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name, namespace: 'tenant-a', resourceVersion: rv, creationTimestamp: '2026-01-02T03:04:05Z' },
  status: { phase },
});

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('WatchCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function make(listImpl?: () => Promise<{ items?: k8s.V1Pod[]; metadata?: { resourceVersion?: string } }>) {
    const w = fakeWatcher();
    const list = vi.fn(listImpl ?? (async () => ({
      items: [{ metadata: { name: 'seed', namespace: 'tenant-a', creationTimestamp: new Date('2026-01-01T00:00:00Z') } } as k8s.V1Pod],
      metadata: { resourceVersion: '10' },
    })));
    const cache = new WatchCache<k8s.V1Pod>({ path: '/api/v1/pods', modelType: 'V1Pod', list, watcher: w.watcher });
    return { cache, list, ...w };
  }

  it('answers nothing until the first list lands, then serves it and watches from its resourceVersion', async () => {
    const { cache, streams } = make();
    expect(cache.list()).toBeNull();
    cache.start();
    await settle();
    expect(cache.list()?.map((p) => p.metadata?.name)).toEqual(['seed']);
    expect(streams).toHaveLength(1);
    expect(streams[0].query.resourceVersion).toBe('10');
  });

  it('deserializes watch events into the same models a LIST returns (Dates, not strings)', async () => {
    const { cache, streams } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ADDED', rawPod('new', '11'));
    const added = cache.list()?.find((p) => p.metadata?.name === 'new');
    expect(added?.metadata?.creationTimestamp).toBeInstanceOf(Date);
    expect(added?.status?.phase).toBe('Running');
  });

  it('applies MODIFIED and DELETED', async () => {
    const { cache, streams } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ADDED', rawPod('p', '11', 'Pending'));
    streams[0].onEvent('MODIFIED', rawPod('p', '12', 'Running'));
    expect(cache.list()?.find((p) => p.metadata?.name === 'p')?.status?.phase).toBe('Running');
    streams[0].onEvent('DELETED', rawPod('p', '13'));
    expect(cache.list()?.some((p) => p.metadata?.name === 'p')).toBe(false);
  });

  it('a normal close resumes from the last resourceVersion without relisting', async () => {
    const { cache, streams, list } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ADDED', rawPod('p', '42'));
    streams[0].onDone(null);
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
    expect(streams[1].query.resourceVersion).toBe('42');
    expect(cache.list()).not.toBeNull();
  });

  it('a watch that ends on a timeout resumes from its resourceVersion — it is not a failure', async () => {
    // client-node's Watch aborts every request on a timer and reports a
    // DOMException named TimeoutError. Treated as a failure, the first deploy
    // relisted every Pod in the cluster every 30 seconds.
    const { cache, streams, list } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ADDED', rawPod('p', '77'));
    streams[0].onDone(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
    expect(streams[1].query.resourceVersion).toBe('77');
    expect(streams[1].query.timeoutSeconds).toBe(300);
    expect(cache.list()).not.toBeNull();
  });

  it('a watch ERROR (410 Gone) stops answering until a relist succeeds', async () => {
    const { cache, streams, list } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ERROR', { kind: 'Status', code: 410 });
    expect(cache.list()).toBeNull();
    streams[0].onDone(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(cache.list()).not.toBeNull();
  });

  it('a failed list keeps it silent and retries with backoff', async () => {
    let fail = true;
    const { cache, list } = make(async () => {
      if (fail) throw new Error('apiserver down');
      return { items: [], metadata: { resourceVersion: '5' } };
    });
    cache.start();
    await settle();
    expect(cache.list()).toBeNull();
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(cache.list()).toEqual([]);
  });

  it('the done callback of a watch it replaced cannot start a relist loop', async () => {
    const { cache, streams, list } = make();
    cache.start();
    await settle();
    streams[0].onEvent('ERROR', { code: 410 });
    streams[0].onDone(new Error('gone'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    // The first stream reports again after being replaced: ignored.
    streams[0].onDone(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(cache.list()).not.toBeNull();
  });
});

describe('listPodsCached', () => {
  it('falls back to a plain LIST for clients without a kubeConfig (test doubles, off-cluster)', async () => {
    const listPodForAllNamespaces = vi.fn(async () => ({ items: [{ metadata: { name: 'x' } }] }));
    const res = await listPodsCached({ core: { listPodForAllNamespaces } } as never);
    expect(listPodForAllNamespaces).toHaveBeenCalledTimes(1);
    expect(res.items.map((p) => p.metadata?.name)).toEqual(['x']);
  });
});
