import { describe, it, expect, vi } from 'vitest';
import { assessWorkloads, waitForHealthy, type WorkloadReadiness } from './health-gate.js';

const w = (o: Partial<WorkloadReadiness> = {}): WorkloadReadiness =>
  ({ name: 'app', desiredReplicas: 1, readyReplicas: 1, failureMessage: null, ...o });

describe('assessWorkloads', () => {
  it('is healthy when every workload has its replicas', () => {
    expect(assessWorkloads([w(), w({ name: 'db' })]).state).toBe('healthy');
  });

  it('is settling mid-rollout, and names what it waits on', () => {
    const v = assessWorkloads([w(), w({ name: 'slow', readyReplicas: 0 })]);
    expect(v).toEqual({ state: 'settling', waitingOn: ['slow'] });
  });

  /**
   * ★ A quota rejection is the failure THIS migration can cause. It must stop
   * the run immediately rather than time out into a stop 10 minutes later —
   * by which point the operator has no idea which step did it.
   */
  it('is broken, not settling, when a ReplicaSet reports a failure', () => {
    const v = assessWorkloads([w({ name: 'web', readyReplicas: 0, failureMessage: 'exceeded quota' })]);
    expect(v).toEqual({ state: 'broken', reason: 'exceeded quota', workload: 'web' });
  });

  // Broken outranks settling: a tenant with one failing and one still-rolling
  // workload must report the failure, which is the actionable half.
  it('reports the failure even when another workload is merely settling', () => {
    const v = assessWorkloads([
      w({ name: 'rolling', readyReplicas: 0 }),
      w({ name: 'dead', readyReplicas: 0, failureMessage: 'unschedulable' }),
    ]);
    expect(v.state).toBe('broken');
  });

  /**
   * A deliberately stopped workload is 0 desired / 0 ready. Calling that
   * unhealthy would block migration for every tenant with a paused app.
   */
  it('treats a deliberately scaled-to-zero workload as healthy', () => {
    expect(assessWorkloads([w({ desiredReplicas: 0, readyReplicas: 0 })]).state).toBe('healthy');
  });

  it('is healthy for a tenant with no workloads', () => {
    expect(assessWorkloads([]).state).toBe('healthy');
  });
});

describe('waitForHealthy', () => {
  const clock = (start = 0) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

  it('returns as soon as the tenant settles', async () => {
    const c = clock();
    const read = vi.fn()
      .mockResolvedValueOnce([w({ readyReplicas: 0 })])
      .mockResolvedValueOnce([w()]);
    const r = await waitForHealthy(read, {
      timeoutMs: 10_000, pollMs: 100, now: c.now,
      sleep: async (ms) => { c.advance(ms); },
    });
    expect(r.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops immediately on a failure without waiting out the timeout', async () => {
    const c = clock();
    const r = await waitForHealthy(
      async () => [w({ readyReplicas: 0, failureMessage: 'exceeded quota' })],
      { timeoutMs: 600_000, pollMs: 100, now: c.now, sleep: async (ms) => { c.advance(ms); } },
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(c.now()).toBe(0); // never slept
  });

  /**
   * ★ A timeout is NOT success. Reporting ok here would mean a migration
   * declaring a tenant healthy that it never actually observed healthy —
   * green over a tenant that is still down.
   */
  it('gives up as a FAILURE, distinguishable from a real fault', async () => {
    const c = clock();
    const r = await waitForHealthy(
      async () => [w({ readyReplicas: 0 })],
      { timeoutMs: 500, pollMs: 100, now: c.now, sleep: async (ms) => { c.advance(ms); } },
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.verdict.state).toBe('settling');
  });

  // The stop button has to interrupt the WAIT, not only the gaps between
  // steps — most of a migration's wall-clock is spent inside this loop.
  it('aborts mid-wait when a stop is requested', async () => {
    const c = clock();
    const r = await waitForHealthy(
      async () => [w({ readyReplicas: 0 })],
      {
        timeoutMs: 600_000, pollMs: 100, now: c.now,
        sleep: async (ms) => { c.advance(ms); },
        stopRequested: async () => true,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
  });
});
