import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  buildSweepScript,
  parseSweepOutput,
  reapIngressSpool,
  makeExecOnce,
  DEFAULT_MIN_AGE_MINUTES,
  type ExecOnce,
} from './reaper.js';

afterEach(() => { vi.useRealTimers(); });

const silent = { info: () => {}, warn: () => {} };

/** A CoreV1Api stub that returns the given pods from listNamespacedPod. */
function coreWith(pods: Array<{ name: string; phase: string }>) {
  return {
    listNamespacedPod: vi.fn().mockResolvedValue({
      items: pods.map((p) => ({ metadata: { name: p.name }, status: { phase: p.phase } })),
    }),
  } as unknown as Parameters<typeof reapIngressSpool>[0]['core'];
}

const execStub = {} as Parameters<typeof reapIngressSpool>[0]['exec'];

describe('buildSweepScript', () => {
  it('never deletes a file younger than the age threshold', () => {
    // -mmin is the ONLY thing standing between this sweep and deleting the
    // spool of a transfer that is still running.
    expect(buildSweepScript(60)).toContain('-mmin +60');
  });

  it('quotes the glob so find expands it, not the shell', () => {
    // Unquoted, a shell that matched one file would pass only that filename to
    // find and the sweep would silently under-reap.
    expect(buildSweepScript(60)).toContain("-name 'temp-multibuf-*'");
  });

  it('only ever targets the oxy spool prefix', () => {
    const script = buildSweepScript(60);
    // The sweep runs as root inside the ingress pod. Anything that widens this
    // to a bare /tmp/* is a foot-gun aimed at the ingress.
    expect(script).not.toMatch(/-name\s+'\*'/);
    expect(script.match(/-delete/g)).toHaveLength(1);
  });

  it('measures the glob, never the whole of /tmp', () => {
    // `du -sk /tmp` would count whatever else Traefik writes there, so a spool
    // file created mid-sweep pollutes the reclaim figure — which decides
    // whether the tick logs at warn or info.
    expect(buildSweepScript(60)).not.toMatch(/du -sk \/tmp/);
  });
});

describe('parseSweepOutput', () => {
  it('reads count, reclaimed and remaining from the REAP line', () => {
    const r = parseSweepOutput('REAP 3 2048 512\n')!;
    expect(r.deleted).toBe(3);
    expect(r.reclaimedBytes).toBe((2048 - 512) * 1024);
    // Remaining is the post-sweep glob total, not a separate measurement.
    expect(r.remainingBytes).toBe(512 * 1024);
  });

  it('returns null for output that is not the exact shape', () => {
    // A pod whose shell differs, or whose du is missing, must read as "could
    // not measure" — never as a successful zero, or the gauge reports an
    // all-clear for a pod that was never swept.
    for (const bad of ['', 'sh: du: not found', 'REAP', 'REAP 1 2', 'REAP a b c', 'REAP 1 2 3 4']) {
      expect(parseSweepOutput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('never reports negative reclaim when traffic lands mid-measurement', () => {
    // `after` can legitimately exceed `before`: a response started spooling
    // between the two du calls.
    expect(parseSweepOutput('REAP 0 100 900')!.reclaimedBytes).toBe(0);
  });

  it('distinguishes a measured zero from an unmeasured one', () => {
    expect(parseSweepOutput('REAP 0 0 0')).toEqual({ deleted: 0, reclaimedBytes: 0, remainingBytes: 0 });
    expect(parseSweepOutput('no output at all')).toBeNull();
  });
});

describe('reapIngressSpool', () => {
  it('sweeps every running pod and aggregates the result', async () => {
    const calls: string[] = [];
    const execOnce: ExecOnce = async (_ns, pod) => {
      calls.push(pod);
      return pod === 'traefik-a' ? 'REAP 2 5000 1000\n' : 'REAP 1 3000 2512\n';
    };
    const res = await reapIngressSpool({
      core: coreWith([{ name: 'traefik-a', phase: 'Running' }, { name: 'traefik-b', phase: 'Running' }]),
      exec: execStub, logger: silent, execOnce,
    });
    expect(calls).toEqual(['traefik-a', 'traefik-b']);
    expect(res.podsScanned).toBe(2);
    expect(res.deleted).toBe(3);
    expect(res.reclaimedBytes).toBe((4000 + 488) * 1024);
    // remaining is the MAX across pods — one node's exposure, not a sum.
    expect(res.remainingBytes).toBe(2512 * 1024);
    expect(res.podsAnswered).toBe(2);
  });

  it('skips pods that are not Running', async () => {
    const execOnce = vi.fn<ExecOnce>().mockResolvedValue('REAP 0 0 0');
    const res = await reapIngressSpool({
      core: coreWith([
        { name: 'traefik-live', phase: 'Running' },
        { name: 'traefik-evicted', phase: 'Failed' },
        { name: 'traefik-starting', phase: 'Pending' },
      ]),
      exec: execStub, logger: silent, execOnce,
    });
    expect(execOnce).toHaveBeenCalledTimes(1);
    expect(res.podsScanned).toBe(1);
  });

  it('one unreachable pod does not stop the others or throw', async () => {
    // The scheduler must survive a Traefik that is mid-roll; throwing here
    // would kill the tick and every tick after it.
    const execOnce: ExecOnce = async (_ns, pod) => {
      if (pod === 'traefik-bad') throw new Error('container not found');
      return 'REAP 1 2000 1000\n';
    };
    const res = await reapIngressSpool({
      core: coreWith([{ name: 'traefik-bad', phase: 'Running' }, { name: 'traefik-ok', phase: 'Running' }]),
      exec: execStub, logger: silent, execOnce,
    });
    expect(res.deleted).toBe(1);
    expect(res.perPod.find((p) => p.pod === 'traefik-bad')?.error).toContain('container not found');
    expect(res.perPod.find((p) => p.pod === 'traefik-ok')?.deleted).toBe(1);
  });

  it('reports podsAnswered=0 when every pod fails, so a zero is not mistaken for an all-clear', async () => {
    // ★ The aggregates ARE all zero here — that is unavoidable, there is nothing
    // to aggregate. What must not happen is a caller reading that zero as a
    // measurement. `podsAnswered` is the field that says nobody answered, and
    // the scheduler keys the gauge on it. An earlier version of this test
    // asserted the zeros and called that "excluded", which pinned the bug: the
    // per-pod layer refused to turn a failure into a measured zero and the
    // aggregate layer did it anyway.
    const execOnce: ExecOnce = async () => { throw new Error('exec timed out'); };
    const res = await reapIngressSpool({
      core: coreWith([{ name: 'traefik-a', phase: 'Running' }, { name: 'traefik-b', phase: 'Running' }]),
      exec: execStub, logger: silent, execOnce,
    });
    expect(res.podsScanned).toBe(2);
    expect(res.podsAnswered).toBe(0);
    expect(res.remainingBytes).toBe(0);
    expect(res.perPod.every((p) => p.error === 'exec timed out')).toBe(true);
  });

  it('podsAnswered counts only pods that returned a parseable measurement', async () => {
    const execOnce: ExecOnce = async (_ns, pod) =>
      (pod === 'traefik-ok' ? 'REAP 0 0 0' : 'sh: du: not found');
    const res = await reapIngressSpool({
      core: coreWith([{ name: 'traefik-ok', phase: 'Running' }, { name: 'traefik-garbled', phase: 'Running' }]),
      exec: execStub, logger: silent, execOnce,
    });
    // Unparseable output is not an exception, but it is not an answer either.
    expect(res.podsScanned).toBe(2);
    expect(res.podsAnswered).toBe(1);
  });

  it('returns an empty result instead of throwing when the pod list fails', async () => {
    const core = { listNamespacedPod: vi.fn().mockRejectedValue(new Error('apiserver down')) } as unknown as
      Parameters<typeof reapIngressSpool>[0]['core'];
    const res = await reapIngressSpool({ core, exec: execStub, logger: silent, execOnce: async () => 'REAP 0 0 0 0' });
    expect(res.podsScanned).toBe(0);
    expect(res.perPod).toEqual([]);
  });

  it('defaults to the conservative age threshold', async () => {
    let seen = '';
    await reapIngressSpool({
      core: coreWith([{ name: 'traefik-a', phase: 'Running' }]),
      exec: execStub, logger: silent,
      execOnce: async (_ns, _p, _c, argv) => { seen = argv.join(' '); return 'REAP 0 0 0'; },
    });
    expect(seen).toContain(`-mmin +${DEFAULT_MIN_AGE_MINUTES}`);
    expect(DEFAULT_MIN_AGE_MINUTES).toBeGreaterThanOrEqual(60);
  });
});

describe('makeExecOnce', () => {
  it('closes a websocket that resolves AFTER the timeout already fired', async () => {
    // The timeout handler runs while `ws` is still undefined, so its
    // `ws?.close()` is a no-op. Without closing it on arrival the socket is
    // leaked for the life of the process — one per slow pod, every tick, most
    // likely exactly when the node is under the I/O pressure this reaper exists
    // to relieve.
    vi.useFakeTimers();
    let closed = false;
    let resolveSocket!: (s: unknown) => void;
    const exec = {
      exec: vi.fn().mockReturnValue(new Promise((res) => { resolveSocket = res; })),
    } as unknown as Parameters<typeof makeExecOnce>[0];

    const p = makeExecOnce(exec)('traefik', 'pod-a', 'traefik', ['sh', '-c', 'true']);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // Socket arrives late, after the promise already rejected.
    resolveSocket({ close: () => { closed = true; } });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
  });
});
