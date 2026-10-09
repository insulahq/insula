import { describe, it, expect } from 'vitest';
import { evaluatePreflight, type PreflightFacts } from './preflight.js';

const healthy: PreflightFacts = {
  environment: 'production',
  cnpgReady: true,
  cnpgDetail: 'primary elected',
  longhornAtRiskVolumes: 0,
  inFlightTransitions: 0,
  maxDiskUsedPct: 40,
  nodesWithDiskPressure: 0,
  freshestBackupAgeHours: 2,
  fluxSuspended: [],
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

  it('Longhorn: at-risk attached volumes → fail; 0 at-risk → pass; null → pass(n/a)', () => {
    // 0 at-risk includes a single-node cluster whose replica=1 volumes are all
    // healthy — the case that used to hard-block single-node upgrades.
    expect(gate(evaluatePreflight({ ...healthy, longhornAtRiskVolumes: 1 }), 'longhorn-replicas').status).toBe('fail');
    expect(gate(evaluatePreflight({ ...healthy, longhornAtRiskVolumes: 0 }), 'longhorn-replicas').status).toBe('pass');
    expect(gate(evaluatePreflight({ ...healthy, longhornAtRiskVolumes: null }), 'longhorn-replicas').status).toBe('pass');
  });

  it('single-node default (replica=1, all healthy → 0 at-risk) does NOT block the upgrade', () => {
    // Regression guard for: the old `< 2` check made every
    // single-node cluster fail this gate with no override, so it could never
    // upgrade. 0 at-risk volumes must be a clean pass in production.
    const r = evaluatePreflight({ ...healthy, environment: 'production', longhornAtRiskVolumes: 0 });
    expect(gate(r, 'longhorn-replicas').status).toBe('pass');
    expect(r.ok).toBe(true);
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
      longhornAtRiskVolumes: 3,
      inFlightTransitions: 3,
      maxDiskUsedPct: 99,
      nodesWithDiskPressure: 2,
      freshestBackupAgeHours: null,
      fluxSuspended: ['Kustomization/platform'],
    });
    expect(r.failures).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.gates.every((g) => g.status !== 'fail')).toBe(true);
  });

  // A suspended platform Kustomization (the documented manual-rollback step) or
  // source makes the re-pin a no-op: the upgrade answered "Flux is reconciling",
  // nothing rolled, and post-flight counted its way to abort-recommended with no
  // gate naming the cause — found driving the upgrade on a VM cluster.
  describe('flux-reconciling', () => {
    it('production: a suspended Kustomization or source → fail (blocking), named', () => {
      const r = evaluatePreflight({ ...healthy, fluxSuspended: ['Kustomization/platform', 'GitRepository/hosting-platform-production'] });
      const g = gate(r, 'flux-reconciling');
      expect(g.status).toBe('fail');
      expect(g.detail).toContain('Kustomization/platform');
      expect(g.detail).toContain('GitRepository/hosting-platform-production');
      expect(g.detail).toContain('flux resume');
      expect(r.ok).toBe(false);
    });

    it('staging: the same condition is a warn', () => {
      expect(gate(evaluatePreflight({ ...healthy, environment: 'staging', fluxSuspended: ['Kustomization/platform'] }), 'flux-reconciling').status).toBe('warn');
    });

    it('nothing suspended → pass', () => {
      expect(gate(evaluatePreflight(healthy), 'flux-reconciling').status).toBe('pass');
    });

    it('unknown (Flux objects unreadable) → warn, never a silent pass', () => {
      const g = gate(evaluatePreflight({ ...healthy, fluxSuspended: null }), 'flux-reconciling');
      expect(g.status).toBe('warn');
      expect(g.detail).toMatch(/could not read/);
    });
  });
});

describe('evaluatePreflight — upgrade-run gates (ADR-064)', () => {
  const nodes = [{ name: 'sv1', ready: true }, { name: 'sv2', ready: false }];

  it('no node facts (a caller that predates runs) → no nodes-ready gate', () => {
    expect(evaluatePreflight(healthy).gates.find((g) => g.id === 'nodes-ready')).toBeUndefined();
  });

  it('a Not Ready node blocks — in every environment, since the run would only wait', () => {
    for (const environment of ['production', 'staging', 'dev']) {
      const r = evaluatePreflight({ ...healthy, environment, nodes });
      expect(gate(r, 'nodes-ready').status).toBe('fail');
      expect(gate(r, 'nodes-ready').detail).toMatch(/sv2 is not Ready.*exclude it/);
      expect(r.ok).toBe(false);
    }
  });

  it('excluding the Not Ready node passes and names it as upgraded without', () => {
    const r = evaluatePreflight({ ...healthy, nodes, excludedNodes: ['sv2'] });
    expect(gate(r, 'nodes-ready').status).toBe('pass');
    expect(gate(r, 'nodes-ready').detail).toMatch(/1 node\(s\) Ready.*without sv2.*hourly timer/);
    expect(r.ok).toBe(true);
  });

  it('every node excluded → fail (at least one must take part)', () => {
    const r = evaluatePreflight({ ...healthy, nodes, excludedNodes: ['sv1', 'sv2'] });
    expect(gate(r, 'nodes-ready').status).toBe('fail');
    expect(gate(r, 'nodes-ready').detail).toMatch(/every node is excluded/);
  });

  it('unreadable nodes → warn, never a silent pass', () => {
    const r = evaluatePreflight({ ...healthy, nodes: null });
    expect(gate(r, 'nodes-ready').status).toBe('warn');
  });

  it('an upgrade already running → fail; not running or unreadable → no gate', () => {
    expect(gate(evaluatePreflight({ ...healthy, upgradeRunning: true }), 'no-upgrade-running').status).toBe('fail');
    expect(evaluatePreflight({ ...healthy, upgradeRunning: false }).gates.find((g) => g.id === 'no-upgrade-running')).toBeUndefined();
    expect(evaluatePreflight({ ...healthy, upgradeRunning: null }).gates.find((g) => g.id === 'no-upgrade-running')).toBeUndefined();
  });
});
