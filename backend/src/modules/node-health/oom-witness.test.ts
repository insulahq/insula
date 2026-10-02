import { describe, it, expect, vi } from 'vitest';
import { judgeKill, judgeKills, parseOomWitness, readOomWitnesses, type OomWitness, type OomWitnessPod } from './oom-witness.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// The kubelet serializes finishedAt to whole seconds.
const T = Date.parse('2026-10-02T13:14:28Z');
const UID = '6229e6b8-ebdb-4dcf-bd72-0425d5d9afbb';

function pod(over: Partial<OomWitnessPod> = {}): OomWitnessPod {
  return { firstSeenMs: T - 3_600_000, lastReadMs: T + 300_000, watched: true, ...over };
}
function witness(p: OomWitnessPod | undefined, over: Partial<OomWitness> = {}): OomWitness {
  return {
    version: 1, available: true, reason: null, inotify: true,
    startedAtMs: T - 86_400_000, rescannedAtMs: T + 300_000, overflowsMs: [],
    pods: p ? { [UID]: p } : {},
    ...over,
  };
}
const inc = (afterMs: number, atMs: number, oom: number, oomKill = 1, oomGroupKill = 1, containerIds?: string[]) =>
  ({ afterMs, atMs, oom, oomKill, oomGroupKill, ...(containerIds ? { containerIds } : {}) });
const APP = 'a1'.repeat(32);
const SIDECAR = 'b2'.repeat(32);
const APP_RESTARTED = 'c3'.repeat(32);

describe('judgeKill — no usable evidence falls back to the kubelet', () => {
  it.each([
    ['no witness for the node', undefined],
    ['witness unavailable (cgroup v1)', witness(pod(), { available: false, reason: 'cgroup v2 not mounted' })],
    ['pod not in the witness', witness(undefined)],
  ])('%s', (_label, w) => {
    expect(judgeKill('explicit', new Date(T), UID, w)).toBe('oom');
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });
});

// Found on DEV: the reconciler judged three kills against a snapshot the
// probe had published 7 s BEFORE them. The witness cannot speak to a death
// its snapshot predates — in either direction.
describe('judgeKill — a snapshot older than the death', () => {
  const stale = { snapshotAtMs: T - 7_000, rescannedAtMs: T - 20_000 };

  it('a watched pod OOM-killed after the snapshot is pending, NOT "not-oom"', () => {
    // "watched, no rise recorded" in a snapshot from before the kill would
    // have dropped a real OOM alert.
    expect(judgeKill('inferred', new Date(T), UID, witness(pod(), stale))).toBe('pending');
    expect(judgeKill('explicit', new Date(T), UID, witness(pod(), stale))).toBe('pending');
  });

  it('a pod born and killed since the snapshot is pending, not "unknown pod"', () => {
    expect(judgeKill('inferred', new Date(T), UID, witness(undefined, stale))).toBe('pending');
  });

  it('the snapshot must clear the 1 s resolution of finishedAt', () => {
    expect(judgeKill('inferred', new Date(T), UID, witness(pod(), { snapshotAtMs: T + 900 }))).toBe('pending');
    expect(judgeKill('inferred', new Date(T), UID, witness(pod(), { snapshotAtMs: T + 5_000 }))).toBe('not-oom');
  });

  it('an older probe without snapshotAtMs is timed by its last rescan', () => {
    expect(judgeKill('inferred', new Date(T), UID, witness(pod(), { rescannedAtMs: T - 1_000 }))).toBe('pending');
  });

  it('an unavailable witness is never waited for', () => {
    expect(judgeKill('inferred', new Date(T), UID, witness(pod(), { ...stale, available: false }))).toBe('unconfirmed');
  });
});

describe('judgeKill — a kill bracketing the exit', () => {
  it('oom and oom_kill both rose: the pod hit its own limit', () => {
    // The production tenant nginx kill: pod slice memory.events oom 1,
    // oom_kill 3, oom_group_kill 1, read ~instantly by inotify.
    const w = witness(pod({ oom: 1, oomKill: 3, oomGroupKill: 1, increases: [inc(T - 25_000, T + 50, 1, 3, 1)] }));
    expect(judgeKill('explicit', new Date(T), UID, w)).toBe('memory-limit');
    // And the vmsingle case: the kubelet only said Error/137.
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('memory-limit');
  });

  it('a limit hit read separately, just before the kill, is still a limit kill (the DEV sequence)', () => {
    // Recorded verbatim on DEV: inotify read between the kernel counting
    // `oom` and counting the kill, ~100 ms apart.
    const w = witness(pod({
      oom: 1, oomKill: 2, oomGroupKill: 1,
      increases: [inc(T - 3_000, T - 2_900, 1, 0, 0), inc(T - 2_900, T - 2_800, 0, 2, 1, [APP])],
    }));
    expect(judgeKill('explicit', new Date(T), UID, w, APP)).toBe('memory-limit');
  });

  it('an old limit hit, long before the kill, does not make a node-wide OOM a limit kill', () => {
    const w = witness(pod({
      increases: [inc(T - 900_000, T - 899_000, 1, 0, 0), inc(T - 25_000, T + 50, 0, 1, 1, [APP])],
    }));
    expect(judgeKill('explicit', new Date(T), UID, w, APP)).toBe('node-oom');
  });

  it('oom_kill rose without oom: the NODE ran out of memory', () => {
    const w = witness(pod({ oomKill: 1, increases: [inc(T - 25_000, T + 50, 0)] }));
    expect(judgeKill('explicit', new Date(T), UID, w)).toBe('node-oom');
  });

  it('a process stuck in I/O that exits 45 s after the kill is still the OOM', () => {
    // a production node has measured 8–48 s storage stalls; a short exit window would call
    // this real OOM "not-oom" and drop its alert.
    const w = witness(pod({ increases: [inc(T - 50_000, T - 45_000, 1)] }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('memory-limit');
  });

  it('only `oom` rising (limit hit, nothing killed) does not explain a SIGKILL', () => {
    const w = witness(pod({ increases: [inc(T - 25_000, T + 50, 1, 0, 0)] }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });
});

describe('judgeKill — proving it was NOT memory', () => {
  it('watched live, no rise anywhere near the exit', () => {
    // The DEV negative control: a container that ran `exit 137`. Kernel counters zero.
    expect(judgeKill('inferred', new Date(T), UID, witness(pod()))).toBe('not-oom');
  });

  it('an OOM long before the exit does not explain it', () => {
    const w = witness(pod({ increases: [inc(T - 3_000_000, T - 2_900_000, 1)] }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });

  it('an explicit OOMKilled is never denied — conflicting evidence keeps the kubelet word', () => {
    expect(judgeKill('explicit', new Date(T), UID, witness(pod()))).toBe('oom');
  });

  it('first read AFTER the exit with all counters zero (cumulative = never)', () => {
    const w = witness(pod({ firstSeenMs: T + 20_000, lastReadMs: T + 20_000, watched: false }), { inotify: false });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });

  it('rescans only: a read after the exit with no rise in between', () => {
    const w = witness(pod({ watched: false, lastReadMs: T + 30_000 }), { inotify: false });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });
});

describe('judgeKill — absence is NOT proof when the witness could not have seen', () => {
  it('rescans only, and the last read was before the exit', () => {
    const w = witness(pod({ watched: false, lastReadMs: T - 10_000 }), { inotify: false });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });

  it('the last read lands inside the 1 s resolution of finishedAt', () => {
    const w = witness(pod({ watched: false, lastReadMs: T + 900 }), { inotify: false });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });

  it('inotify events were lost around the exit', () => {
    const w = witness(pod({ lastReadMs: T - 10_000 }), { overflowsMs: [T + 5_000] });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });

  it('an overflow far from the exit does not matter', () => {
    const w = witness(pod({ lastReadMs: T - 10_000 }), { overflowsMs: [T - 3_000_000] });
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });

  it('a baseline (counters already up when first seen) after the exit', () => {
    const w = witness(pod({
      firstSeenMs: T + 20_000, oomKill: 2, increases: [inc(0, T + 20_000, 2, 2, 1)],
    }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });

  it('first seen after the exit but counters already non-zero', () => {
    // Not a baseline (the pod was born after the previous rescan), but the
    // first read could not separate before from after.
    const w = witness(pod({
      firstSeenMs: T + 20_000, oomKill: 1, increases: [inc(T + 5_000, T + 20_000, 1)],
    }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('unconfirmed');
  });

  it('a baseline long before the exit is fine — the record spans it', () => {
    const w = witness(pod({ oomKill: 2, increases: [inc(0, T - 3_600_000, 2, 2, 1)] }));
    expect(judgeKill('inferred', new Date(T), UID, w)).toBe('not-oom');
  });
});

// The pod counters aggregate every container in the pod. One real kill must
// never be pinned on a sibling — or on the same container's next restart —
// that died of something else in the same window.
describe('judgeKills — one kill explains one death', () => {
  const at = (ms: number) => new Date(T + ms);

  it('the rise names the killed container: its sibling dying 60 s later is not an OOM', () => {
    const w = witness(pod({ oom: 1, oomKill: 1, oomGroupKill: 1, increases: [inc(T - 20_000, T + 50, 1, 1, 1, [APP])] }));
    const out = judgeKills([
      { key: 'app', kubelet: 'explicit', finishedAt: at(0), containerId: APP },
      { key: 'sidecar', kubelet: 'inferred', finishedAt: at(60_000), containerId: SIDECAR },
    ], UID, w);
    expect(out.get('app')).toBe('memory-limit');
    expect(out.get('sidecar')).toBe('not-oom');
  });

  it("the same container's NEXT restart is a different container id, so it is not explained either", () => {
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 1, 1, [APP])] }));
    expect(judgeKill('inferred', at(90_000), UID, w, APP_RESTARTED)).toBe('not-oom');
    expect(judgeKill('inferred', at(0), UID, w, APP)).toBe('memory-limit');
  });

  it('a rise naming nobody explains at most as many deaths as it counted — the rest stay open', () => {
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 2, 1)] }));
    const out = judgeKills([
      { key: 'near', kubelet: 'inferred', finishedAt: at(0), containerId: APP },
      { key: 'far', kubelet: 'inferred', finishedAt: at(40_000), containerId: SIDECAR },
    ], UID, w);
    expect(out.get('near')).toBe('memory-limit');
    // An OOM did happen in this pod right then; it is just not provably this
    // one. Never "not-oom", never "memory-limit".
    expect(out.get('far')).toBe('unconfirmed');
  });

  it('two group kills in one rise explain two deaths', () => {
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 4, 2)] }));
    const out = judgeKills([
      { key: 'a', kubelet: 'inferred', finishedAt: at(0), containerId: APP },
      { key: 'b', kubelet: 'inferred', finishedAt: at(1_000), containerId: SIDECAR },
    ], UID, w);
    expect([out.get('a'), out.get('b')]).toEqual(['memory-limit', 'memory-limit']);
  });

  it('an INCOMPLETE rise (fewer names than group kills) can still explain an unnamed death', () => {
    // The sidecar's cgroup was gone before the witness could read it.
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 4, 2, [APP])] }));
    const out = judgeKills([
      { key: 'app', kubelet: 'inferred', finishedAt: at(0), containerId: APP },
      { key: 'sidecar', kubelet: 'inferred', finishedAt: at(500), containerId: SIDECAR },
    ], UID, w);
    expect(out.get('app')).toBe('memory-limit');
    expect(out.get('sidecar')).toBe('memory-limit');
  });

  it('an incomplete rise never rules a death out', () => {
    // Spent on the named container, but it counted two group kills: the
    // unnamed one may have been the sidecar. Open, not "not-oom".
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 2, 2, [APP])] }));
    const out = judgeKills([
      { key: 'app', kubelet: 'inferred', finishedAt: at(0), containerId: APP },
      { key: 'x', kubelet: 'inferred', finishedAt: at(500), containerId: SIDECAR },
      { key: 'y', kubelet: 'inferred', finishedAt: at(700), containerId: APP_RESTARTED },
    ], UID, w);
    expect(out.get('app')).toBe('memory-limit');
    expect([out.get('x'), out.get('y')].sort()).toEqual(['memory-limit', 'unconfirmed']);
  });

  it('a death with no container id can take a named rise only up to its count', () => {
    const w = witness(pod({ increases: [inc(T - 20_000, T + 50, 1, 1, 1, [APP])] }));
    const out = judgeKills([
      { key: 'a', kubelet: 'inferred', finishedAt: at(0) },
      { key: 'b', kubelet: 'inferred', finishedAt: at(2_000) },
    ], UID, w);
    expect(out.get('a')).toBe('memory-limit');
    expect(out.get('b')).toBe('unconfirmed');
  });
});

describe('parseOomWitness', () => {
  it('decodes the probe wire format', () => {
    const raw = JSON.stringify(witness(pod({ oom: 1, increases: [inc(T - 1, T, 1)] })));
    expect(parseOomWitness(raw)?.pods[UID]?.increases?.[0]?.oom).toBe(1);
  });

  it.each([
    ['absent (an older probe without the witness)', undefined],
    ['not JSON', '{nope'],
    ['an unknown version', JSON.stringify({ ...witness(pod()), version: 2 })],
    ['a missing field', JSON.stringify({ ...witness(pod()), pods: undefined })],
  ])('rejects %s', (_label, raw) => {
    expect(parseOomWitness(raw)).toBeNull();
  });
});

describe('readOomWitnesses', () => {
  function clients(list: () => Promise<unknown>): K8sClients {
    return { core: { listNamespacedConfigMap: vi.fn(list) } } as unknown as K8sClients;
  }

  it('maps each probe ConfigMap to its node and skips the unusable ones', async () => {
    const good = JSON.stringify(witness(pod()));
    const k8s = clients(async () => ({
      items: [
        { metadata: { name: 'security-probe-node-a' }, data: { snapshot: '{}', memcg: good } },
        { metadata: { name: 'security-probe-node-b.example.test' }, data: { snapshot: '{}', memcg: good } },
        { metadata: { name: 'security-probe-old' }, data: { snapshot: '{}' } },
        { metadata: { name: 'something-else' }, data: { memcg: good } },
      ],
    }));
    const out = await readOomWitnesses(k8s);
    expect([...out.keys()].sort()).toEqual(['node-a', 'node-b.example.test']);
    expect(k8s.core.listNamespacedConfigMap).toHaveBeenCalledWith({
      namespace: 'platform-system', labelSelector: 'app=security-probe',
    });
  });

  it('reports a failed LIST instead of passing it off as "no evidence found"', async () => {
    const onError = vi.fn();
    const out = await readOomWitnesses(clients(async () => { throw new Error('forbidden'); }), onError);
    expect(out.size).toBe(0);
    expect(onError).toHaveBeenCalledWith('forbidden');
  });
});
