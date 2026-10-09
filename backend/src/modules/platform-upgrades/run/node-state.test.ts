import { describe, it, expect } from 'vitest';
import type { HostMigrationItem, HostMigrationNodeStatus } from '@insula/api-contracts';
import { assessRunNode, cliAtTarget, JOB_FAILURE_THRESHOLD } from './node-state.js';

const TARGET = '2026.10.7-rc.4';
const up = { name: 'sv1', ready: true };

const item = (key: string, state: HostMigrationItem['state'], extra: Partial<HostMigrationItem> = {}): HostMigrationItem =>
  ({ key, state, ...extra });

const status = (cliVersion: string | null, items: HostMigrationItem[] = []): HostMigrationNodeStatus => ({
  node: 'sv1', collectedAt: '2026-10-09T10:00:00Z', mode: 'enforce', source: 'configmap', ok: true,
  appliedCount: 0, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0, invalidCount: 0,
  items, cliVersion,
} as HostMigrationNodeStatus);

describe('cliAtTarget', () => {
  it('compares SemVer — a stable CLI satisfies its own RC; an older one does not', () => {
    expect(cliAtTarget('2026.10.7-rc.4', TARGET)).toBe(true);
    expect(cliAtTarget('2026.10.7', TARGET)).toBe(true);
    expect(cliAtTarget('2026.10.7-rc.3', TARGET)).toBe(false);
    expect(cliAtTarget('2026.10.6', TARGET)).toBe(false);
  });
  it('unknown or garbage is never at target', () => {
    expect(cliAtTarget(null, TARGET)).toBe(false);
    expect(cliAtTarget('dev-build', TARGET)).toBe(false);
  });
});

describe('assessRunNode — prepare-nodes', () => {
  it('excluded beats everything, and says how it catches up', () => {
    const n = assessRunNode('prepare-nodes', { name: 'sv1', ready: false }, undefined, undefined, TARGET, ['sv1']);
    expect(n.state).toBe('excluded');
    expect(n.detail).toMatch(/its own timer/);
  });

  it('a Not Ready node is waited for, with the way out named', () => {
    const n = assessRunNode('prepare-nodes', { name: 'sv1', ready: false }, status('2026.10.6'), undefined, TARGET, []);
    expect(n.state).toBe('waiting');
    expect(n.detail).toMatch(/excluded/);
  });

  it('ready only on the node\'s OWN report — a succeeded job is not enough', () => {
    const job = { active: 0, failed: 0, succeeded: 1 };
    expect(assessRunNode('prepare-nodes', up, status('2026.10.6'), job, TARGET, []).state).not.toBe('ready');
    expect(assessRunNode('prepare-nodes', up, status(TARGET), job, TARGET, []).state).toBe('ready');
  });

  it('deferred after-services scripts do not hold prepare — they wait for the services', () => {
    const s = status(TARGET, [
      item('2026.10.7/0001-a.sh', 'applied', { phase: 'before-services' }),
      item('2026.10.7/0002-b.sh', 'deferred', { phase: 'after-services' }),
    ]);
    const n = assessRunNode('prepare-nodes', up, s, undefined, TARGET, []);
    expect(n.state).toBe('ready');
    expect(n.detail).toMatch(/1 wait for the services/);
  });

  it('a pending before-services script holds prepare', () => {
    const s = status(TARGET, [item('2026.10.7/0001-a.sh', 'would-run', { phase: 'before-services' })]);
    expect(assessRunNode('prepare-nodes', up, s, { active: 1, failed: 0, succeeded: 0 }, TARGET, []).state).toBe('updating');
  });

  it('a script of a LATER release does not count against this target', () => {
    const s = status(TARGET, [item('2026.10.8/0001-a.sh', 'run-failed', { error: 'boom' })]);
    expect(assessRunNode('prepare-nodes', up, s, undefined, TARGET, []).state).toBe('ready');
  });

  it(`fails after ${JOB_FAILURE_THRESHOLD} failed attempts, naming the failed host change`, () => {
    const s = status(TARGET, [item('2026.10.7/0001-a.sh', 'run-failed', { error: 'exit 3' })]);
    const n = assessRunNode('prepare-nodes', up, s, { active: 0, failed: JOB_FAILURE_THRESHOLD, succeeded: 0 }, TARGET, []);
    expect(n.state).toBe('failed');
    expect(n.detail).toMatch(/2026\.10\.7\/0001-a\.sh failed: exit 3/);
  });

  it('a node that converged after failed attempts is ready — the job count only grows', () => {
    const s = status(TARGET, [item('2026.10.7/0001-a.sh', 'applied', { phase: 'before-services' })]);
    const n = assessRunNode('prepare-nodes', up, s, { active: 0, failed: JOB_FAILURE_THRESHOLD + 2, succeeded: 1 }, TARGET, []);
    expect(n.state).toBe('ready');
  });

  it('fewer failed attempts → still updating (the controller retries)', () => {
    const s = status(TARGET, [item('2026.10.7/0001-a.sh', 'run-failed', { error: 'exit 3' })]);
    const n = assessRunNode('prepare-nodes', up, s, { active: 0, failed: 1, succeeded: 0 }, TARGET, []);
    expect(n.state).toBe('updating');
    expect(n.detail).toMatch(/Retrying/);
  });

  it('a job that fails before the node reports anything points at the job log', () => {
    const n = assessRunNode('prepare-nodes', up, status('2026.10.6'), { active: 0, failed: 5, succeeded: 0 }, TARGET, []);
    expect(n.state).toBe('failed');
    expect(n.detail).toMatch(/job log in namespace system-upgrade/);
  });

  it('job done, report not relayed yet → still updating, never back to queued', () => {
    const n = assessRunNode('prepare-nodes', up, status('2026.10.7-rc.3'), { active: 0, failed: 0, succeeded: 1 }, TARGET, []);
    expect(n.state).toBe('updating');
    expect(n.detail).toMatch(/waiting for its report/);
  });

  it('nothing started yet → queued, saying which CLI it is on', () => {
    const n = assessRunNode('prepare-nodes', up, status('2026.10.6'), undefined, TARGET, []);
    expect(n.state).toBe('queued');
    expect(n.detail).toMatch(/On 2026\.10\.6/);
    expect(n.cliVersion).toBe('2026.10.6');
  });
});

describe('assessRunNode — host-change counts', () => {
  const s = status(TARGET, [
    item('2026.10.7/0001-a.sh', 'applied', { phase: 'before-services' }),
    item('2026.10.7/0002-b.sh', 'would-run', { phase: 'before-services' }),
    item('2026.10.7/0003-c.sh', 'deferred', { phase: 'after-services' }),
    item('2026.10.6/0001-old.sh', 'already-applied'),
  ]);

  it('preparing: the release\'s before-services changes only', () => {
    expect(assessRunNode('prepare-nodes', up, s, undefined, TARGET, []).hostChanges).toEqual({ done: 1, total: 2 });
  });

  it('finishing: all of the release\'s changes', () => {
    expect(assessRunNode('finish', up, s, undefined, TARGET, []).hostChanges).toEqual({ done: 1, total: 3 });
  });

  it('a node still on an older CLI does not know the release\'s scripts — no count, not 0/0', () => {
    expect(assessRunNode('prepare-nodes', up, status('2026.10.7-rc.3', []), undefined, TARGET, []).hostChanges).toBeNull();
  });
});

describe('assessRunNode — finish', () => {
  it('a deferred script holds finish until the node reports it applied', () => {
    const waiting = status(TARGET, [item('2026.10.7/0002-b.sh', 'deferred', { phase: 'after-services' })]);
    expect(assessRunNode('finish', up, waiting, undefined, TARGET, []).state).toBe('queued');
    const done = status(TARGET, [item('2026.10.7/0002-b.sh', 'applied', { phase: 'after-services' })]);
    const n = assessRunNode('finish', up, done, undefined, TARGET, []);
    expect(n.state).toBe('ready');
    expect(n.detail).toMatch(/all host changes applied/);
  });
});
