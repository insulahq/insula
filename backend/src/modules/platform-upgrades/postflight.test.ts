import { describe, it, expect } from 'vitest';
import { evaluatePostflight, advanceStreak, ABORT_THRESHOLD, type PostflightFacts, type PostflightResult } from './postflight.js';

const converged: PostflightFacts = {
  pendingVersion: '2026.6.3',
  runningVersion: '2026.6.3',
  cnpgReady: true,
  cnpgDetail: '1/1 ready',
  deploymentsTotal: 4,
  deploymentsAvailable: 4,
  deploymentsReadable: true,
  crashloopingPods: 0,
};

const gate = (r: PostflightResult, id: string) => r.gates.find((g) => g.id === id)!;

describe('evaluatePostflight', () => {
  it('no upgrade in flight → idle, ok, no gates', () => {
    const r = evaluatePostflight({ ...converged, pendingVersion: null });
    expect(r.phase).toBe('idle');
    expect(r.ok).toBe(true);
    expect(r.gates).toHaveLength(0);
  });

  it('fully converged + clean → healthy', () => {
    const r = evaluatePostflight(converged);
    expect(r.phase).toBe('healthy');
    expect(r.ok).toBe(true);
    expect(r.failures).toBe(0);
    expect(gate(r, 'version-converged').status).toBe('pass');
  });

  it('clean run but still on the OLD version → reconciling (not healthy)', () => {
    const r = evaluatePostflight({ ...converged, runningVersion: '2026.6.2' });
    expect(gate(r, 'version-converged').status).toBe('fail');
    expect(r.phase).toBe('reconciling');
    expect(r.ok).toBe(false);
  });

  it('CNPG unhealthy → fail + reconciling', () => {
    const r = evaluatePostflight({ ...converged, cnpgReady: false, cnpgDetail: 'no primary' });
    expect(gate(r, 'cnpg-healthy').status).toBe('fail');
    expect(r.phase).toBe('reconciling');
  });

  it('a deployment not yet available → fail', () => {
    const r = evaluatePostflight({ ...converged, deploymentsAvailable: 3 });
    expect(gate(r, 'deployments-available').status).toBe('fail');
    expect(r.phase).toBe('reconciling');
  });

  it('a crash-looping pod → fail', () => {
    const r = evaluatePostflight({ ...converged, crashloopingPods: 2 });
    expect(gate(r, 'no-crashloops').status).toBe('fail');
    expect(gate(r, 'no-crashloops').detail).toMatch(/2 pod/);
  });

  it('deployments unreadable (k8s error) → a distinct "unreadable" fail, not "N down"', () => {
    const r = evaluatePostflight({ ...converged, deploymentsReadable: false, deploymentsTotal: 0, deploymentsAvailable: 0 });
    const g = gate(r, 'deployments-available');
    expect(g.status).toBe('fail');
    expect(g.detail).toMatch(/unreadable/);
    expect(g.detail).not.toMatch(/0\/0/);
  });
});

describe('advanceStreak', () => {
  const reconciling: PostflightResult = { gates: [], ok: false, failures: 1, warnings: 0, phase: 'reconciling' };
  const healthy: PostflightResult = { gates: [], ok: true, failures: 0, warnings: 0, phase: 'healthy' };
  const idle: PostflightResult = { gates: [], ok: true, failures: 0, warnings: 0, phase: 'idle' };

  it('idle → reset to 0, verdict idle', () => {
    expect(advanceStreak(2, idle)).toEqual({ consecutiveFailures: 0, verdict: 'idle' });
  });

  it('healthy → reset to 0, verdict healthy (even after prior failures)', () => {
    expect(advanceStreak(2, healthy)).toEqual({ consecutiveFailures: 0, verdict: 'healthy' });
  });

  it('reconciling increments; stays "reconciling" below the threshold', () => {
    expect(advanceStreak(0, reconciling)).toEqual({ consecutiveFailures: 1, verdict: 'reconciling' });
    expect(advanceStreak(1, reconciling)).toEqual({ consecutiveFailures: 2, verdict: 'reconciling' });
  });

  it(`reaches abort-recommended at ${ABORT_THRESHOLD} consecutive failures`, () => {
    const a = advanceStreak(ABORT_THRESHOLD - 1, reconciling);
    expect(a.consecutiveFailures).toBe(ABORT_THRESHOLD);
    expect(a.verdict).toBe('abort-recommended');
  });

  it('a healthy observation clears an abort streak', () => {
    expect(advanceStreak(ABORT_THRESHOLD + 5, healthy)).toEqual({ consecutiveFailures: 0, verdict: 'healthy' });
  });

  it('sanitises a garbage prior count (NaN/negative → 0)', () => {
    expect(advanceStreak(Number.NaN, reconciling).consecutiveFailures).toBe(1);
    expect(advanceStreak(-5, reconciling).consecutiveFailures).toBe(1);
  });
});
