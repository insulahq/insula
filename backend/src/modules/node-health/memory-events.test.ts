import { describe, it, expect } from 'vitest';
import {
  classifyEviction,
  indexProbeKills,
  collectOomKilledContainers,
  normalizeMemoryEvents,
  type RawMemoryEvent,
  type RawPod,
} from './memory-events.js';
import type { OomWitness } from './oom-witness.js';

const NOW = new Date('2026-07-25T12:00:00Z');

function evictedEvent(overrides: Partial<{
  uid: string; count: number; pod: string; ns: string; host: string; when: string; message: string;
}> = {}): RawMemoryEvent {
  return {
    reason: 'Evicted',
    message: overrides.message ?? 'Pod was evicted: memory usage exceeds threshold',
    count: overrides.count,
    involvedObject: { kind: 'Pod', name: overrides.pod ?? 'web-abc123', namespace: overrides.ns ?? 'tenant-tenant1' },
    source: { host: overrides.host ?? 'worker' },
    metadata: { uid: overrides.uid ?? 'uid-evict-1' },
    lastTimestamp: overrides.when ?? '2026-07-25T11:55:00Z',
  };
}

function oomEvent(overrides: Partial<{ uid: string; count: number; node: string; when: string }> = {}): RawMemoryEvent {
  return {
    reason: 'SystemOOM',
    message: 'System OOM encountered, victim process: postgres, pid: 1234',
    count: overrides.count,
    involvedObject: { kind: 'Node', name: overrides.node ?? 'staging1' },
    metadata: { uid: overrides.uid ?? 'uid-oom-1' },
    lastTimestamp: overrides.when ?? '2026-07-25T11:50:00Z',
  };
}

describe('normalizeMemoryEvents', () => {
  it('normalizes tenant evictions and node SystemOOM', () => {
    const out = normalizeMemoryEvents([evictedEvent()], [oomEvent()], NOW);
    expect(out).toHaveLength(2);
    const evict = out.find((e) => e.kind === 'pod-evicted');
    expect(evict).toMatchObject({
      dedupeKey: 'uid-evict-1:1',
      nodeName: 'worker',
      namespace: 'tenant-tenant1',
      podName: 'web-abc123',
      systemWorkload: false,
      // The fixture message names no resource the kubelet uses — so no claim.
      cause: 'other',
    });
    const oom = out.find((e) => e.kind === 'system-oom');
    expect(oom).toMatchObject({
      dedupeKey: 'uid-oom-1:1',
      nodeName: 'staging1',
      namespace: null,
      podName: null,
      systemWorkload: true,
      cause: 'node-oom',
    });
  });

  it('marks evictions in system namespaces as systemWorkload', () => {
    const out = normalizeMemoryEvents([evictedEvent({ ns: 'platform', pod: 'platform-api-x' })], [], NOW);
    expect(out[0]?.systemWorkload).toBe(true);
  });

  it('dedupe key incorporates the aggregation count', () => {
    const [a] = normalizeMemoryEvents([evictedEvent({ count: 3 })], [], NOW);
    expect(a?.dedupeKey).toBe('uid-evict-1:3');
  });

  it('drops events with no uid, no node, wrong reason/kind, or outside retention', () => {
    const noUid: RawMemoryEvent = { ...evictedEvent(), metadata: {} };
    const noNode: RawMemoryEvent = { ...evictedEvent(), source: {}, reportingInstance: undefined };
    const wrongKind: RawMemoryEvent = { ...evictedEvent(), involvedObject: { kind: 'Node' } };
    const ancient = evictedEvent({ when: '2026-05-01T00:00:00Z' });
    const wrongReason: RawMemoryEvent = { ...oomEvent(), reason: 'NodeNotReady' };
    const out = normalizeMemoryEvents([noUid, noNode, wrongKind, ancient], [wrongReason], NOW);
    expect(out).toHaveLength(0);
  });

  it('records the resource the kubelet named on each eviction', () => {
    const out = normalizeMemoryEvents([
      evictedEvent({ uid: 'm', message: 'The node was low on resource: memory. Threshold quantity: 256Mi, available: 101Mi.' }),
      evictedEvent({ uid: 'd', message: 'The node was low on resource: ephemeral-storage. Threshold quantity: 10%.' }),
      evictedEvent({ uid: 's', message: 'Pod ephemeral local storage usage exceeds the total limit of containers 1Mi. ' }),
    ], [], NOW);
    expect(out.map((e) => [e.dedupeKey, e.cause])).toEqual([
      ['m:1', 'node-memory-pressure'],
      ['d:1', 'node-disk-pressure'],
      ['s:1', 'pod-storage-limit'],
    ]);
  });

  it('SystemOOM listed among evictions (and vice versa) is not double-counted', () => {
    // Defensive: each list is reason-filtered independently.
    const out = normalizeMemoryEvents([oomEvent()], [evictedEvent()], NOW);
    expect(out).toHaveLength(0);
  });
});

function oomPod(overrides: Partial<{
  uid: string; pod: string; ns: string; node: string; container: string;
  restarts: number; reason: string; exitCode: number; finishedAt: string; terminal: boolean;
  deletionTimestamp: string; podReason: string; labels: Record<string, string>;
}> = {}): RawPod {
  const term = {
    reason: overrides.reason ?? 'OOMKilled',
    exitCode: overrides.exitCode ?? 137,
    finishedAt: overrides.finishedAt ?? '2026-07-25T11:00:00Z',
  };
  return {
    metadata: {
      uid: overrides.uid ?? 'pod-uid-1',
      name: overrides.pod ?? 'web-x',
      namespace: overrides.ns ?? 'tenant-t1',
      ...(overrides.labels ? { labels: overrides.labels } : {}),
      ...(overrides.deletionTimestamp ? { deletionTimestamp: overrides.deletionTimestamp } : {}),
    },
    spec: { nodeName: overrides.node ?? 'worker' },
    status: {
      ...(overrides.podReason ? { reason: overrides.podReason } : {}),
      containerStatuses: [{
        name: overrides.container ?? 'app',
        restartCount: overrides.restarts ?? 1,
        ...(overrides.terminal
          ? { state: { terminated: term } }
          : { lastState: { terminated: term } }),
      }],
    },
  };
}

describe('collectOomKilledContainers', () => {
  it('records an OOMKilled lastState with a stable dedupe key', () => {
    const [e] = collectOomKilledContainers([oomPod()], NOW);
    expect(e).toMatchObject({
      kind: 'container-oom',
      nodeName: 'worker',
      namespace: 'tenant-t1',
      podName: 'web-x',
      systemWorkload: false,
    });
    expect(e?.dedupeKey).toBe(`oomk:pod-uid-1:app:1:${new Date('2026-07-25T11:00:00Z').getTime()}`);
    // The kubelet's OOMKilled alone cannot say whether the pod's own limit or
    // a node-wide OOM did it — so the record does not claim "at its limit".
    expect(e?.cause).toBe('oom');
    expect(e?.message).toContain('OOM-killed');
    expect(e?.message).not.toContain('at its memory limit');
  });

  it('records a terminal-state kill (restartPolicy Never)', () => {
    const out = collectOomKilledContainers([oomPod({ terminal: true })], NOW);
    expect(out).toHaveLength(1);
  });

  it('classifies system namespaces as systemWorkload', () => {
    const [e] = collectOomKilledContainers([oomPod({ ns: 'platform', pod: 'platform-api-x' })], NOW);
    expect(e?.systemWorkload).toBe(true);
  });

  it('counts a platform-sized pod in a TENANT namespace as platform', () => {
    // The file manager lives in the tenant namespace but is sized by the
    // platform — "raise the tenant's plan" would be wrong advice for it.
    const [e] = collectOomKilledContainers(
      [oomPod({ ns: 'tenant-t1', pod: 'file-manager-x', labels: { 'platform.io/system': 'true' } })], NOW);
    expect(e).toMatchObject({ systemWorkload: true, platformManaged: true });
  });

  it('includes Error/137 but marks it unconfirmed, never as an OOM', () => {
    const [e] = collectOomKilledContainers([oomPod({ reason: 'Error', exitCode: 137 })], NOW);
    expect(e?.kind).toBe('container-oom');
    expect(e?.cause).toBe('unconfirmed');
    expect(e?.message).toContain('cause unconfirmed');
    // The old wording asserted an OOM it could not prove, which is how an
    // admin came to be told to raise a limit on a container at 13% of it.
    expect(e?.message).not.toContain('OOM-killed at its memory limit');
  });

  it("takes an explicit OOMKilled at the kubelet's word", () => {
    const [e] = collectOomKilledContainers([oomPod({ reason: 'OOMKilled' })], NOW);
    expect(e?.cause).toBe('oom');
  });

  it('DROPS an unconfirmed exit-137 on a TERMINATING pod (rollout SIGKILL, not an OOM)', () => {
    // The production false positive: the modsec-crs audit-redactor ignored the
    // image's STOPSIGNAL, sat out the 30s grace period and was SIGKILLed on
    // every rollout, while its cgroup reported oom_kill=0 and an 8.5 MB peak
    // against a 64 MiB limit.
    const events = collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, deletionTimestamp: '2026-07-25T10:59:30Z' })],
      NOW,
    );
    expect(events).toHaveLength(0);
  });

  it('KEEPS an explicit OOMKilled even on a terminating pod', () => {
    // kubelet saying OOMKilled is authoritative regardless of pod lifecycle;
    // only the exit-code guess is suppressed.
    const events = collectOomKilledContainers(
      [oomPod({ reason: 'OOMKilled', deletionTimestamp: '2026-07-25T10:59:30Z' })],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.cause).toBe('oom');
  });

  it('ignores non-OOM terminations and stale kills', () => {
    const cleanExit = oomPod({ reason: 'Completed', exitCode: 0 });
    const crash = oomPod({ reason: 'Error', exitCode: 1 });
    const ancient = oomPod({ finishedAt: '2026-05-01T00:00:00Z' });
    expect(collectOomKilledContainers([cleanExit, crash, ancient], NOW)).toHaveLength(0);
  });

  it('same termination in state AND lastState yields one record', () => {
    const p = oomPod({ terminal: true });
    const both: RawPod = {
      ...p,
      status: {
        containerStatuses: [{
          ...p.status!.containerStatuses![0],
          lastState: p.status!.containerStatuses![0].state,
        }],
      },
    };
    expect(collectOomKilledContainers([both], NOW)).toHaveLength(1);
  });

});

// ── node-shutdown exclusion ──
//
// The deletionTimestamp guard below was correct for rollout SIGKILLs and blind
// to the far bigger source: a node reboot. Graceful node shutdown marks a pod
// Failed IN PLACE — it never deletes it — so deletionTimestamp is absent while
// status.reason carries kubelet's own explanation.
describe('collectOomKilledContainers — node shutdown', () => {
  it('drops an inferred kill on a pod terminated by node shutdown', () => {
    const events = collectOomKilledContainers(
      [oomPod({ podReason: 'Terminated', reason: 'Error', exitCode: 137, terminal: true, restarts: 0 })],
      NOW,
    );
    expect(events).toEqual([]);
  });

  it('drops an inferred kill on a pod rejected by a shutting-down node', () => {
    const events = collectOomKilledContainers(
      [oomPod({ podReason: 'NodeShutdown', reason: 'ContainerStatusUnknown', exitCode: 137, terminal: true, restarts: 0 })],
      NOW,
    );
    expect(events).toEqual([]);
  });

  it('KEEPS an explicit OOMKilled even during a node shutdown', () => {
    const events = collectOomKilledContainers(
      [oomPod({ podReason: 'Terminated', reason: 'OOMKilled', exitCode: 137, terminal: true })],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe('oom');
  });

  it('KEEPS an inferred kill on a pod that is NOT shutting down', () => {
    const events = collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, restarts: 3 })],
      NOW,
    );
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe('unconfirmed');
  });
});

// ── probe-restart exclusion(found by a real DEV reboot) ──
//
// A failed liveness/startup probe SIGKILLs the container: exit 137, pod stays
// RUNNING, container restarts. None of the pod-level shutdown markers apply, so
// isExpectedSigkill() correctly does not fire — but the kubelet has already
// named the cause in a Killing event. Believe it.
describe('probe-restart exclusion', () => {
  // Verbatim from the DEV cluster: crowdsec is slow to answer /health after a
  // cold boot, and this was raised as a CRITICAL node memory event.
  const probeEvent = {
    reason: 'Killing',
    message: 'Container crowdsec failed liveness probe, will be restarted',
    involvedObject: { kind: 'Pod', namespace: 'crowdsec', name: 'crowdsec-cf64d6d77-hl4sr' },
    eventTime: '2026-07-25T11:00:00Z',
  };

  it('indexes a probe kill by namespace/pod/container', () => {
    const idx = indexProbeKills([probeEvent]);
    expect([...idx.keys()]).toEqual(['crowdsec/crowdsec-cf64d6d77-hl4sr/crowdsec']);
  });

  it('indexes a STARTUP probe kill too', () => {
    const idx = indexProbeKills([{ ...probeEvent, message: 'Container crowdsec failed startup probe, will be restarted' }]);
    expect(idx.size).toBe(1);
  });

  it('ignores Killing events that are not probe failures', () => {
    // A plain rollout kill names no probe and must not mute anything.
    expect(indexProbeKills([{ ...probeEvent, message: 'Stopping container crowdsec' }]).size).toBe(0);
    expect(indexProbeKills([{ ...probeEvent, reason: 'Evicted' }]).size).toBe(0);
  });

  it('DROPS an inferred kill the kubelet blamed on a probe', () => {
    const events = collectOomKilledContainers(
      [oomPod({ ns: 'crowdsec', pod: 'crowdsec-cf64d6d77-hl4sr', container: 'crowdsec',
                reason: 'Error', exitCode: 137, restarts: 1, finishedAt: '2026-07-25T11:00:00Z' })],
      NOW,
      indexProbeKills([probeEvent]),
    );
    expect(events).toEqual([]);
  });

  it('KEEPS an explicit OOMKilled even when a probe also failed', () => {
    // A container CAN hit its limit and fail a probe; the kubelet's explicit
    // OOMKilled is authoritative and must survive.
    const events = collectOomKilledContainers(
      [oomPod({ ns: 'crowdsec', pod: 'crowdsec-cf64d6d77-hl4sr', container: 'crowdsec',
                reason: 'OOMKilled', exitCode: 137, restarts: 1, finishedAt: '2026-07-25T11:00:00Z' })],
      NOW,
      indexProbeKills([probeEvent]),
    );
    expect(events).toHaveLength(1);
    expect(events[0].cause).toBe('oom');
  });

  it('KEEPS an inferred kill when the probe event is for a DIFFERENT container', () => {
    const events = collectOomKilledContainers(
      [oomPod({ ns: 'crowdsec', pod: 'crowdsec-cf64d6d77-hl4sr', container: 'sidecar',
                reason: 'Error', exitCode: 137, restarts: 1, finishedAt: '2026-07-25T11:00:00Z' })],
      NOW,
      indexProbeKills([probeEvent]),
    );
    expect(events).toHaveLength(1);
  });

  it('KEEPS an inferred kill that happened FAR from the probe event', () => {
    // A real OOM hours later must not be muted by an old probe restart.
    const events = collectOomKilledContainers(
      [oomPod({ ns: 'crowdsec', pod: 'crowdsec-cf64d6d77-hl4sr', container: 'crowdsec',
                reason: 'Error', exitCode: 137, restarts: 1, finishedAt: '2026-07-25T11:40:00Z' })],
      NOW,
      indexProbeKills([probeEvent]),
    );
    expect(events).toHaveLength(1);
  });

  it('KEEPS everything when no probe events were supplied', () => {
    const events = collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, restarts: 1 })],
      NOW,
    );
    expect(events).toHaveLength(1);
  });
});

// ── the kernel's word (security-probe OOM witness) ──
//
// Exit 137 cannot tell an OOM from any other SIGKILL, in either direction. The
// witness's memory.events counters can. These are the two real cases that
// motivated it.
describe('collectOomKilledContainers — kernel witness', () => {
  const FINISHED = '2026-07-25T11:00:00Z';
  const T = Date.parse(FINISHED);

  function witness(pods: OomWitness['pods']): Map<string, OomWitness> {
    return new Map([['worker', {
      version: 1, available: true, reason: null, inotify: true,
      startedAtMs: T - 86_400_000, rescannedAtMs: T + 600_000, overflowsMs: [], pods,
    }]]);
  }
  const killedAt = (oom: number) => ({
    firstSeenMs: T - 3_600_000, lastReadMs: T + 600_000, watched: true, oom, oomKill: 1, oomGroupKill: 1,
    increases: [{ afterMs: T - 30_000, atMs: T - 200, oom, oomKill: 1, oomGroupKill: 1 }],
  });

  it("confirms a cgroup OOM the kubelet only reported as Error/137 (production's vmsingle)", () => {
    const [e] = collectOomKilledContainers(
      [oomPod({ ns: 'monitoring', pod: 'vmsingle-x', reason: 'Error', exitCode: 137, finishedAt: FINISHED })],
      NOW, new Map(), witness({ 'pod-uid-1': killedAt(1) }));
    expect(e?.cause).toBe('memory-limit');
    expect(e?.message).toContain('OOM-killed at its memory limit (kernel-confirmed)');
  });

  it('records nothing for an exit 137 the kernel shows was not memory (DEV exit-137 pod)', () => {
    const quiet = { firstSeenMs: T - 3_600_000, lastReadMs: T + 600_000, watched: true };
    expect(collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, terminal: true, restarts: 0, finishedAt: FINISHED })],
      NOW, new Map(), witness({ 'pod-uid-1': quiet }))).toEqual([]);
  });

  it('says the node did it when oom_kill rose without oom', () => {
    const [e] = collectOomKilledContainers([oomPod({ finishedAt: FINISHED })],
      NOW, new Map(), witness({ 'pod-uid-1': killedAt(0) }));
    expect(e?.cause).toBe('node-oom');
    expect(e?.message).toContain('not the container');
  });

  it('KEEPS a kernel-confirmed OOM on a draining pod and on a probe-killed one', () => {
    // A container can genuinely hit its limit while being drained or while
    // failing a probe; the kernel's word beats both exclusions.
    const probe = indexProbeKills([{
      reason: 'Killing', message: 'Container app failed liveness probe, will be restarted',
      involvedObject: { kind: 'Pod', namespace: 'tenant-t1', name: 'web-x' }, eventTime: FINISHED,
    }]);
    const w = witness({ 'pod-uid-1': killedAt(1) });
    expect(collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, deletionTimestamp: FINISHED, finishedAt: FINISHED })], NOW, new Map(), w,
    )[0]?.cause).toBe('memory-limit');
    expect(collectOomKilledContainers(
      [oomPod({ reason: 'Error', exitCode: 137, finishedAt: FINISHED })], NOW, probe, w,
    )[0]?.cause).toBe('memory-limit');
  });

  it("one container's kernel-confirmed kill is not pinned on its sibling (multi-container pod)", () => {
    const APP = 'a1'.repeat(32);
    const SIDE = 'b2'.repeat(32);
    const p: RawPod = {
      metadata: { uid: 'pod-uid-1', name: 'web-x', namespace: 'tenant-t1' },
      spec: { nodeName: 'worker' },
      status: {
        containerStatuses: [
          { name: 'app', restartCount: 1, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: FINISHED, containerID: `containerd://${APP}` } } },
          { name: 'sidecar', restartCount: 1, lastState: { terminated: { reason: 'Error', exitCode: 137, finishedAt: '2026-07-25T11:01:00Z', containerID: `containerd://${SIDE}` } } },
        ],
      },
    };
    const w = witness({ 'pod-uid-1': {
      ...killedAt(1), increases: [{ afterMs: T - 30_000, atMs: T - 200, oom: 1, oomKill: 1, oomGroupKill: 1, containerIds: [APP] }],
    } });
    const out = collectOomKilledContainers([p], NOW, new Map(), w);
    expect(out.map((e) => [e.containerName, e.cause])).toEqual([['app', 'memory-limit']]);
  });

  it('waits for a witness snapshot that covers the death, then falls back after 10 min', () => {
    const staleWitness = new Map([['worker', {
      ...witness({ 'pod-uid-1': killedAt(1) }).get('worker')!, snapshotAtMs: T - 7_000, rescannedAtMs: T - 20_000,
    }]]);
    const pod = [oomPod({ reason: 'Error', exitCode: 137, finishedAt: FINISHED })];
    // Two minutes after the death: no record — the first record is final.
    expect(collectOomKilledContainers(pod, new Date(T + 120_000), new Map(), staleWitness)).toEqual([]);
    // A witness that never catches up must not swallow the kill for ever.
    const [late] = collectOomKilledContainers(pod, new Date(T + 11 * 60_000), new Map(), staleWitness);
    expect(late?.cause).toBe('unconfirmed');
  });

  it("uses the witness of the pod's own node only", () => {
    const [e] = collectOomKilledContainers([oomPod({ node: 'other-node', reason: 'Error', exitCode: 137, finishedAt: FINISHED })],
      NOW, new Map(), witness({ 'pod-uid-1': killedAt(1) }));
    expect(e?.cause).toBe('unconfirmed');
  });
});

describe('classifyEviction', () => {
  it.each([
    ['The node was low on resource: memory. Threshold quantity: 256Mi, available: 101Mi. ', 'node-memory-pressure'],
    ['The node had condition: [MemoryPressure]. ', 'node-memory-pressure'],
    ['The node was low on resource: ephemeral-storage. Threshold quantity: 10%. ', 'node-disk-pressure'],
    ['The node was low on resource: inodes. ', 'node-disk-pressure'],
    ['The node had condition: [DiskPressure]. ', 'node-disk-pressure'],
    ['The node was low on resource: pids. ', 'node-pid-pressure'],
    ['Pod ephemeral local storage usage exceeds the total limit of containers 1Mi. ', 'pod-storage-limit'],
    ['Container app exceeded its local ephemeral storage limit "1Mi". ', 'pod-storage-limit'],
    ['Usage of EmptyDir volume "cache" exceeds the limit "1Mi". ', 'pod-storage-limit'],
    ['Pod was evicted: something new', 'other'],
  ])('%s -> %s', (message, cause) => {
    expect(classifyEviction(message)).toBe(cause);
  });
});
