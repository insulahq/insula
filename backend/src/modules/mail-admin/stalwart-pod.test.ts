import { describe, it, expect, vi } from 'vitest';
import { findRunningStalwartPod, pickCurrentPod, type PodLister } from './stalwart-pod.js';

interface FakePod { name: string; phase: string }

/**
 * A pod list that behaves like the API server: pods come back in name order,
 * a field selector on the phase is applied first, a limit is applied last.
 */
function apiServer(pods: FakePod[]) {
  const listNamespacedPod = vi.fn(async (req: { namespace: string; labelSelector?: string; fieldSelector?: string; limit?: number }) => {
    let items = [...pods].sort((a, b) => a.name.localeCompare(b.name));
    const wanted = /^status\.phase=(\w+)$/.exec(req.fieldSelector ?? '')?.[1];
    if (wanted) items = items.filter((p) => p.phase === wanted);
    if (req.limit) items = items.slice(0, req.limit);
    return { items: items.map((p) => ({ metadata: { name: p.name }, status: { phase: p.phase } })) };
  });
  return { core: { listNamespacedPod } as unknown as PodLister, listNamespacedPod };
}

describe('findRunningStalwartPod', () => {
  it('finds the running pod behind finished ones that sort first', async () => {
    // What a node that has been restarted a few times looks like.
    const { core } = apiServer([
      { name: 'stalwart-mail-aaaa-1', phase: 'Succeeded' },
      { name: 'stalwart-mail-aaaa-2', phase: 'Succeeded' },
      { name: 'stalwart-mail-bbbb-1', phase: 'Running' },
      { name: 'stalwart-mail-bbbb-2', phase: 'Succeeded' },
    ]);
    expect(await findRunningStalwartPod(core)).toBe('stalwart-mail-bbbb-1');
  });

  it('asks the API server for running mail pods in the mail namespace', async () => {
    const { core, listNamespacedPod } = apiServer([{ name: 'stalwart-mail-a', phase: 'Running' }]);
    await findRunningStalwartPod(core);
    expect(listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'mail',
      labelSelector: 'app=stalwart-mail',
      fieldSelector: 'status.phase=Running',
    });
  });

  it('returns null when no mail pod is running', async () => {
    expect(await findRunningStalwartPod(apiServer([]).core)).toBeNull();
    expect(await findRunningStalwartPod(apiServer([{ name: 'stalwart-mail-a', phase: 'Pending' }]).core)).toBeNull();
  });

  it('does not take a pod that is not running from a server that ignored the filter', async () => {
    const core = { listNamespacedPod: vi.fn(async () => ({ items: [
      { metadata: { name: 'stalwart-mail-old' }, status: { phase: 'Succeeded' } },
      { metadata: { name: 'stalwart-mail-new' }, status: { phase: 'Running' } },
    ] })) } as unknown as PodLister;
    expect(await findRunningStalwartPod(core)).toBe('stalwart-mail-new');
  });
});

describe('findRunningStalwartPod during a rollout', () => {
  it('prefers the pod that is staying over the one being deleted', async () => {
    const core = { listNamespacedPod: vi.fn(async () => ({ items: [
      { metadata: { name: 'stalwart-mail-leaving', deletionTimestamp: new Date() }, status: { phase: 'Running' } },
      { metadata: { name: 'stalwart-mail-staying' }, status: { phase: 'Running' } },
    ] })) } as unknown as PodLister;
    expect(await findRunningStalwartPod(core)).toBe('stalwart-mail-staying');
  });

  it('still returns a pod that is being deleted when it is the only one running', async () => {
    const core = { listNamespacedPod: vi.fn(async () => ({ items: [
      { metadata: { name: 'stalwart-mail-leaving', deletionTimestamp: new Date() }, status: { phase: 'Running' } },
    ] })) } as unknown as PodLister;
    expect(await findRunningStalwartPod(core)).toBe('stalwart-mail-leaving');
  });
});

describe('pickCurrentPod', () => {
  const pod = (name: string, phase: string, created: string, deleting = false) => ({
    metadata: { name, creationTimestamp: created, ...(deleting ? { deletionTimestamp: '2030-01-01T00:00:00Z' } : {}) },
    status: { phase },
  });

  it('skips finished pods wherever they sort', () => {
    const picked = pickCurrentPod([
      pod('a-old', 'Succeeded', '2030-01-01T00:00:00Z'),
      pod('b-evicted', 'Failed', '2030-01-02T00:00:00Z'),
      pod('c-live', 'Running', '2030-01-03T00:00:00Z'),
      pod('d-old', 'Succeeded', '2030-01-04T00:00:00Z'),
    ]);
    expect(picked?.metadata.name).toBe('c-live');
  });

  it('picks a pod that is not running yet — it reports on the current pod, whatever its state', () => {
    const picked = pickCurrentPod([
      pod('a-old', 'Succeeded', '2030-01-01T00:00:00Z'),
      pod('b-stuck', 'Pending', '2030-01-02T00:00:00Z'),
    ]);
    expect(picked?.metadata.name).toBe('b-stuck');
  });

  it('prefers the pod that is staying, then the newest', () => {
    expect(pickCurrentPod([
      pod('a-leaving', 'Running', '2030-01-03T00:00:00Z', true),
      pod('b-staying', 'Pending', '2030-01-02T00:00:00Z'),
    ])?.metadata.name).toBe('b-staying');
    expect(pickCurrentPod([
      pod('a-older', 'Running', '2030-01-01T00:00:00Z'),
      pod('b-newer', 'Running', '2030-01-02T00:00:00Z'),
    ])?.metadata.name).toBe('b-newer');
  });

  it('falls back to a pod being deleted when nothing else is live', () => {
    expect(pickCurrentPod([
      pod('a-old', 'Succeeded', '2030-01-01T00:00:00Z'),
      pod('b-leaving', 'Running', '2030-01-02T00:00:00Z', true),
    ])?.metadata.name).toBe('b-leaving');
  });

  it('is undefined when every pod is finished, or there is none', () => {
    expect(pickCurrentPod([pod('a', 'Succeeded', '2030-01-01T00:00:00Z'), pod('b', 'Failed', '2030-01-02T00:00:00Z')])).toBeUndefined();
    expect(pickCurrentPod([])).toBeUndefined();
  });
});
