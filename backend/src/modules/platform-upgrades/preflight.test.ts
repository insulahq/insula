import { describe, it, expect } from 'vitest';
import { evaluatePreflight, type PreflightFacts } from './preflight.js';

const healthy: PreflightFacts = {
  environment: 'production',
  cnpgReady: true,
  cnpgDetail: 'primary elected',
  longhornMinReplicas: 3,
  inFlightTransitions: 0,
  maxDiskUsedPct: 40,
  nodesWithDiskPressure: 0,
  freshestBackupAgeHours: 2,
};

const gate = (r: ReturnType<typeof evaluatePreflight>, id: string) => r.gates.find((g) => g.id === id)!;

describe('evaluatePreflight', () => {
  it('all green → ok, zero failures', () => {
    const r = evaluatePreflight(healthy);
    expect(r.ok).toBe(true);
    expect(r.failures).toBe(0);
    expect(gate(r, 'cnpg-healthy').status).toBe('pass');
  });

  it('production: CNPG down → fail (blocking)', () => {
    const r = evaluatePreflight({ ...healthy, cnpgReady: false, cnpgDetail: 'no primary' });
    expect(gate(r, 'cnpg-healthy').status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('staging: the SAME CNPG-down condition is a soft warn (not blocking)', () => {
    const r = evaluatePreflight({ ...healthy, environment: 'staging', cnpgReady: false });
    expect(gate(r, 'cnpg-healthy').status).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('production: <2 Longhorn replicas → fail; ≥2 → pass; null → pass(n/a)', () => {
    expect(gate(evaluatePreflight({ ...healthy, longhornMinReplicas: 1 }), 'longhorn-replicas').status).toBe('fail');
    expect(gate(evaluatePreflight({ ...healthy, longhornMinReplicas: 2 }), 'longhorn-replicas').status).toBe('pass');
    expect(gate(evaluatePreflight({ ...healthy, longhornMinReplicas: null }), 'longhorn-replicas').status).toBe('pass');
  });

  it('production: in-flight tenant transitions → fail', () => {
    const r = evaluatePreflight({ ...healthy, inFlightTransitions: 2 });
    expect(gate(r, 'no-in-flight-migrations').status).toBe('fail');
  });

  it('in-flight count unknown (DB unreachable) → warn, NEVER a fail-open pass', () => {
    const r = evaluatePreflight({ ...healthy, inFlightTransitions: null });
    expect(gate(r, 'no-in-flight-migrations').status).toBe('warn'); // not 'pass'
    expect(r.ok).toBe(true); // a warn doesn't block, but it's visible
  });

  it('disk %: <80 pass, 80–89 warn, ≥90 fail(prod)', () => {
    expect(gate(evaluatePreflight({ ...healthy, maxDiskUsedPct: 79 }), 'disk-headroom').status).toBe('pass');
    expect(gate(evaluatePreflight({ ...healthy, maxDiskUsedPct: 85 }), 'disk-headroom').status).toBe('warn');
    expect(gate(evaluatePreflight({ ...healthy, maxDiskUsedPct: 95 }), 'disk-headroom').status).toBe('fail');
  });

  it('disk: node-health reported, no pressure, no % → PASS (the cry-wolf fix)', () => {
    // Phase-1 leaves maxDiskUsedPct null but the reconciler reports DiskPressure=0.
    const r = evaluatePreflight({ ...healthy, maxDiskUsedPct: null, nodesWithDiskPressure: 0 });
    expect(gate(r, 'disk-headroom').status).toBe('pass');
    expect(gate(r, 'disk-headroom').detail).toMatch(/no node under disk pressure/);
  });

  it('disk: a node under kubelet DiskPressure → fail(prod), even with % unknown', () => {
    expect(gate(evaluatePreflight({ ...healthy, maxDiskUsedPct: null, nodesWithDiskPressure: 1 }), 'disk-headroom').status).toBe('fail');
    // …and a soft warn on staging
    expect(gate(evaluatePreflight({ ...healthy, environment: 'staging', maxDiskUsedPct: null, nodesWithDiskPressure: 2 }), 'disk-headroom').status).toBe('warn');
  });

  it('disk: BOTH signals unknown (node-health has no data) → warn', () => {
    const r = evaluatePreflight({ ...healthy, maxDiskUsedPct: null, nodesWithDiskPressure: null });
    expect(gate(r, 'disk-headroom').status).toBe('warn');
    expect(gate(r, 'disk-headroom').detail).toMatch(/has not reported yet/);
  });

  it('backup: fresh pass, stale warn, none warn — never blocks', () => {
    expect(gate(evaluatePreflight({ ...healthy, freshestBackupAgeHours: 5 }), 'recent-backup').status).toBe('pass');
    expect(gate(evaluatePreflight({ ...healthy, freshestBackupAgeHours: 48 }), 'recent-backup').status).toBe('warn');
    expect(gate(evaluatePreflight({ ...healthy, freshestBackupAgeHours: null }), 'recent-backup').status).toBe('warn');
    // a stale backup alone never makes the run not-ok
    expect(evaluatePreflight({ ...healthy, freshestBackupAgeHours: 48 }).ok).toBe(true);
  });

  it('counts warnings + failures', () => {
    const r = evaluatePreflight({ ...healthy, cnpgReady: false, maxDiskUsedPct: 85, freshestBackupAgeHours: 48 });
    expect(r.failures).toBe(1); // cnpg
    expect(r.warnings).toBe(2); // disk + backup
  });

  it('staging: EVERY prod-blocking condition degrades to warn → ok stays true (the #18 contract)', () => {
    const r = evaluatePreflight({
      environment: 'staging',
      cnpgReady: false, cnpgDetail: 'down',
      longhornMinReplicas: 0,
      inFlightTransitions: 3,
      maxDiskUsedPct: 99,
      nodesWithDiskPressure: 2,
      freshestBackupAgeHours: null,
    });
    expect(r.failures).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.gates.every((g) => g.status !== 'fail')).toBe(true);
  });
});
