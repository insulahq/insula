import { describe, it, expect } from 'vitest';
import {
  evaluatePostflight,
  advanceStreak,
  ABORT_THRESHOLD,
  MAX_DATABASE_RESTART_HOLDS,
  type PostflightFacts,
  type PostflightResult,
} from './postflight.js';

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
  const dbRestarting: PostflightResult = { ...reconciling, databaseRestarting: true };

  it('idle → reset to 0, verdict idle', () => {
    expect(advanceStreak(2, idle, 1)).toEqual({ consecutiveFailures: 0, verdict: 'idle', databaseRestartHolds: 0 });
  });

  it('healthy → reset to 0, verdict healthy (even after prior failures)', () => {
    expect(advanceStreak(2, healthy, 2)).toEqual({ consecutiveFailures: 0, verdict: 'healthy', databaseRestartHolds: 0 });
  });

  it('reconciling increments; stays "reconciling" below the threshold', () => {
    expect(advanceStreak(0, reconciling, 0)).toEqual({ consecutiveFailures: 1, verdict: 'reconciling', databaseRestartHolds: 0 });
    expect(advanceStreak(1, reconciling, 0)).toEqual({ consecutiveFailures: 2, verdict: 'reconciling', databaseRestartHolds: 0 });
  });

  it(`reaches abort-recommended at ${ABORT_THRESHOLD} consecutive failures`, () => {
    const a = advanceStreak(ABORT_THRESHOLD - 1, reconciling, 0);
    expect(a.consecutiveFailures).toBe(ABORT_THRESHOLD);
    expect(a.verdict).toBe('abort-recommended');
  });

  it('a healthy observation clears an abort streak', () => {
    expect(advanceStreak(ABORT_THRESHOLD + 5, healthy, 0)).toEqual({ consecutiveFailures: 0, verdict: 'healthy', databaseRestartHolds: 0 });
  });

  it('sanitises a garbage prior count (NaN/negative → 0)', () => {
    expect(advanceStreak(Number.NaN, reconciling, 0).consecutiveFailures).toBe(1);
    expect(advanceStreak(-5, reconciling, 0).consecutiveFailures).toBe(1);
    expect(advanceStreak(0, dbRestarting, Number.NaN).databaseRestartHolds).toBe(1);
  });

  it('a planned database restart holds the streak instead of advancing it', () => {
    // The staging case: two checks already failed while the services rolled, then
    // the database restarted for its new spec. That check must not be the third.
    expect(advanceStreak(ABORT_THRESHOLD - 1, dbRestarting, 0))
      .toEqual({ consecutiveFailures: ABORT_THRESHOLD - 1, verdict: 'reconciling', databaseRestartHolds: 1 });
  });

  it(`holds for at most ${MAX_DATABASE_RESTART_HOLDS} checks per upgrade, then counts again`, () => {
    // A restart that never finishes (an instance that cannot be scheduled) must still escalate.
    const a = advanceStreak(ABORT_THRESHOLD - 1, dbRestarting, MAX_DATABASE_RESTART_HOLDS);
    expect(a).toEqual({ consecutiveFailures: ABORT_THRESHOLD, verdict: 'abort-recommended', databaseRestartHolds: MAX_DATABASE_RESTART_HOLDS });
  });

  it('a hold keeps an abort that was already recommended', () => {
    expect(advanceStreak(ABORT_THRESHOLD, dbRestarting, 0).verdict).toBe('abort-recommended');
  });

  it('holds left unused carry through ordinary failures until the upgrade ends', () => {
    expect(advanceStreak(1, reconciling, 2)).toEqual({ consecutiveFailures: 2, verdict: 'reconciling', databaseRestartHolds: 2 });
  });
});

describe('evaluatePostflight — a planned database restart', () => {
  const rolling: PostflightFacts = { ...converged, runningVersion: '2026.6.2', cnpgReady: false, cnpgDetail: '0/1 instances ready' };

  it.each([
    'Upgrading cluster',
    'Waiting for the instances to become active',
    'Primary instance is being restarted in-place',
    'Primary instance is being restarted without a switchover',
    'Switchover in progress',
    'Online upgrade in progress',
    'Applying configuration',
  ])('"%s" while reconciling is a planned restart', (cnpgPhase) => {
    expect(evaluatePostflight({ ...rolling, cnpgPhase }).databaseRestarting).toBe(true);
  });

  it.each([
    'Failing over',
    'Cluster upgrade delayed',
    'Waiting for user action',
    'Cluster is unrecoverable and needs manual intervention',
    'Cluster in healthy state',
  ])('"%s" is not', (cnpgPhase) => {
    expect(evaluatePostflight({ ...rolling, cnpgPhase }).databaseRestarting).toBe(false);
  });

  it('is not a restart when the phase was not read', () => {
    expect(evaluatePostflight(rolling).databaseRestarting).toBe(false);
  });

  it('a healthy upgrade is healthy even while CNPG still rolls a replica', () => {
    const r = evaluatePostflight({ ...converged, cnpgPhase: 'Upgrading cluster' });
    expect(r.phase).toBe('healthy');
    expect(r.databaseRestarting).toBe(false);
  });
});

describe('convergence gates — an upgrade is not done when its images are', () => {
  /**
   * version-converged, cnpg-healthy, deployments-available and
   * no-crashloops ALL passed on three clusters whose platform-migration
   * registry had halted at 0008. The upgrade reported healthy while the
   * wildcard ClusterIssuer it needed had never been created.
   */
  const rolled = {
    pendingVersion: '2026.8.7',
    runningVersion: '2026.8.7',
    cnpgReady: true,
    cnpgDetail: 'primary elected',
    deploymentsTotal: 8,
    deploymentsAvailable: 8,
    deploymentsReadable: true,
    crashloopingPods: 0,
  };
  const gate = (r: ReturnType<typeof evaluatePostflight>, id: string) => r.gates.find((g) => g.id === id);

  it('is NOT healthy when a platform migration is still pending', () => {
    const r = evaluatePostflight({ ...rolled, migrationsReadable: true, migrationsPending: 1 });
    expect(r.phase).toBe('reconciling');
    expect(gate(r, 'migrations-converged')?.status).toBe('fail');
  });

  it('names the failing migration rather than saying "a migration failed"', () => {
    const r = evaluatePostflight({
      ...rolled, migrationsReadable: true, migrationsPending: 3,
      migrationsFailed: ['0009_seed_wildcard_dns01_issuers'],
    });
    expect(gate(r, 'migrations-converged')?.detail).toContain('0009_seed_wildcard_dns01_issuers');
    expect(gate(r, 'migrations-converged')?.detail).toMatch(/blocked|HALTED/i);
  });

  it('treats an UNREADABLE registry as not-converged, never as converged', () => {
    // Fail-open here is what let the halt ride three tiers.
    const r = evaluatePostflight({ ...rolled, migrationsReadable: false });
    expect(gate(r, 'migrations-converged')?.status).toBe('fail');
    expect(gate(r, 'migrations-converged')?.detail).toMatch(/unreadable/i);
  });

  it('IS healthy once images and migrations converged, with every node on the release', () => {
    const r = evaluatePostflight({
      ...rolled, migrationsReadable: true, migrationsPending: 0,
      hostMigrations: { status: 'pass', scheduled: false, detail: 'All 1 node(s) on CLI 2026.8.7; host changes applied' },
    });
    expect(r.phase).toBe('healthy');
    expect(r.ok).toBe(true);
    expect(gate(r, 'host-migrations-converged')?.status).toBe('pass');
  });

  it('reports nodes still catching up as scheduled, and does NOT hold the services back', () => {
    // A node the run left out applies the release's host changes on its own
    // hourly timer, after the services. That is the normal state right after an upgrade; holding
    // the run open on it made every upgrade "not converging".
    const r = evaluatePostflight({
      ...rolled, migrationsReadable: true, migrationsPending: 0,
      hostMigrations: { status: 'warn', scheduled: true, detail: '2 of 3 node(s) still on an older CLI (s2, s3)' },
    });
    expect(r.phase).toBe('healthy');
    expect(gate(r, 'host-migrations-converged')).toMatchObject({ status: 'warn', scheduled: true });
  });

  it('names a node that needs attention without failing the services', () => {
    // During the upgrade window a host failure can only be an OLD one (the
    // release's own migrations land hours later); it must be visible, but it
    // must not turn the upgrade into one that never finishes.
    const r = evaluatePostflight({
      ...rolled, migrationsReadable: true, migrationsPending: 0,
      hostMigrations: { status: 'warn', scheduled: false, detail: 'needs attention on sv2 — see Host migrations' },
    });
    expect(r.phase).toBe('healthy');
    expect(gate(r, 'host-migrations-converged')?.detail).toContain('sv2');
    expect(gate(r, 'host-migrations-converged')?.scheduled).toBe(false);
  });

  it('omits the host gate only when host state was not collected at all', () => {
    const r = evaluatePostflight({ ...rolled, migrationsReadable: true, migrationsPending: 0 });
    expect(gate(r, 'host-migrations-converged')).toBeUndefined();
    expect(r.phase).toBe('healthy');
  });

  it('keeps the pre-existing gates working when migration facts are absent', () => {
    // A caller with no db handle degrades to the original four gates rather
    // than failing shut on every upgrade.
    const r = evaluatePostflight(rolled);
    expect(r.gates.map((g) => g.id)).toEqual(
      expect.arrayContaining(['version-converged', 'cnpg-healthy', 'deployments-available', 'no-crashloops']),
    );
    expect(r.phase).toBe('healthy');
  });
});
