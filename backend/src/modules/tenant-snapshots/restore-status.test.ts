import { describe, it, expect } from 'vitest';
import { buildRestoreStatusView, restoreStatusAudience, type RestoreOpRow } from './restore-status.js';
import {
  EMPTY_TIMELINE,
  applyRevertStep,
  beginStep,
  endStep,
  failInFlight,
  type StepTimeline,
} from '../storage-lifecycle/restore-timeline.js';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const at = (s: number): Date => new Date(t0.getTime() + s * 1000);

// What a Longhorn failure really looks like: it names the in-cluster manager
// endpoint and a node. Neither may reach a tenant.
const RAW_ENGINE_ERROR = 'Longhorn snapshotRevert failed: HTTP 500 {"message":"failed to revert on node-a via http://longhorn-backend.longhorn-system:9500"}';

function row(over: Partial<RestoreOpRow> = {}): RestoreOpRow {
  return {
    id: 'op-1',
    state: 'restoring',
    progressPct: 58,
    progressMessage: 'Restoring — Attach the volume for the restore',
    lastError: null,
    params: { mode: 'snapshot_revert', label: 'before plugin update', volumeName: 'pvc-internal' },
    progressSteps: null,
    createdAt: t0,
    completedAt: null,
    ...over,
  };
}

function quiesced(): StepTimeline {
  let t = beginStep(EMPTY_TIMELINE, 'quiesce', at(0));
  t = endStep(t, 'quiesce', true, null, at(10));
  t = beginStep(t, 'wait-detach', at(10));
  t = applyRevertStep(t, { step: 'wait-detach', ok: true, detail: 'final=detached' }, at(14));
  return applyRevertStep(t, { step: 'attach-maintenance', ok: true, detail: 'node=node-a' }, at(15));
}

describe('restore-status view — running', () => {
  const view = buildRestoreStatusView(row({ progressSteps: quiesced() }), 'tenant');

  it('lists every step of the run, in order, with the running one marked', () => {
    expect(view.outcome).toBe('running');
    expect(view.steps.map((s) => [s.key, s.state])).toEqual([
      ['quiesce', 'succeeded'],
      ['wait-detach', 'succeeded'],
      ['attach-maintenance', 'succeeded'],
      ['wait-maintenance', 'running'],
      ['revert', 'pending'],
      ['detach-maintenance', 'pending'],
      ['unquiesce', 'pending'],
    ]);
  });

  it('gives finished steps a duration and the running step a start time', () => {
    expect(view.steps[0]!.elapsedMs).toBe(10_000);
    const running = view.steps.find((s) => s.state === 'running')!;
    expect(running.startedAt).toBe(at(15).toISOString());
    expect(running.elapsedMs).toBeNull();
  });

  it('describes progress with the running step label', () => {
    expect(view.progressMessage).toBe('Wait for the volume to be ready…');
    expect(view.snapshotLabel).toBe('before plugin update');
    expect(view.error).toBeNull();
  });
});

describe('restore-status view — what each audience sees', () => {
  it('★ a tenant never sees step detail (node names, volume state)', () => {
    const view = buildRestoreStatusView(row({ progressSteps: quiesced() }), 'tenant');
    expect(view.steps.every((s) => s.detail === null)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('node-a');
    expect(JSON.stringify(view)).not.toContain('pvc-internal');
  });

  it('an operator does', () => {
    const view = buildRestoreStatusView(row({ progressSteps: quiesced() }), 'operator');
    expect(view.steps.find((s) => s.key === 'attach-maintenance')!.detail).toBe('node=node-a');
  });

  it('★ a tenant never sees the raw engine error — an operator gets it in full', () => {
    let t = quiesced();
    t = applyRevertStep(t, { step: 'wait-maintenance', ok: true }, at(20));
    t = failInFlight(t, at(25));
    t = endStep(beginStep(t, 'recover', at(25)), 'recover', true, null, at(40));
    const failed = row({ state: 'failed', lastError: RAW_ENGINE_ERROR, progressSteps: t, completedAt: at(40) });

    const tenant = buildRestoreStatusView(failed, 'tenant');
    expect(JSON.stringify(tenant)).not.toContain('longhorn-backend');
    expect(JSON.stringify(tenant)).not.toContain('node-a');
    expect(tenant.lastError).toBe(tenant.error?.detail);
    expect(tenant.error?.diagnostics).toEqual({ operationId: 'op-1', failedStep: 'Revert the volume to the snapshot' });

    const operator = buildRestoreStatusView(failed, 'operator');
    expect(operator.lastError).toBe(RAW_ENGINE_ERROR);
    expect(operator.error?.diagnostics).toMatchObject({ raw: RAW_ENGINE_ERROR, failedStep: 'revert', operationId: 'op-1' });
  });

  it('an operator gets a translated OperatorError envelope as-is, plus where it failed', () => {
    const envelope = {
      code: 'PVC_FAULTED', title: 'PVC volume is faulted', detail: 'Longhorn marked this volume faulted.',
      remediation: ['Inspect the replicas.'], retryable: true, diagnostics: { raw: 'faulted' },
    };
    const t = failInFlight(beginStep(EMPTY_TIMELINE, 'quiesce', at(0)), at(5));
    const view = buildRestoreStatusView(
      row({ state: 'failed', lastError: JSON.stringify(envelope), progressSteps: t }),
      'operator',
    );
    expect(view.error).toMatchObject({ code: 'PVC_FAULTED', title: 'PVC volume is faulted' });
    expect(view.error?.diagnostics).toMatchObject({ raw: 'faulted', failedStep: 'quiesce' });
  });
});

describe('restore-status view — what a failure tells the tenant about their files', () => {
  it('a failure before the revert says the files were not changed', () => {
    let t = beginStep(EMPTY_TIMELINE, 'quiesce', at(0));
    t = failInFlight(t, at(120));
    t = endStep(beginStep(t, 'recover', at(120)), 'recover', true, null, at(130));
    const view = buildRestoreStatusView(row({ state: 'failed', lastError: 'pods still running', progressSteps: t }), 'tenant');
    expect(view.outcome).toBe('failed');
    expect(view.error?.code).toBe('SNAPSHOT_RESTORE_FAILED');
    expect(view.error?.detail).toMatch(/files were not changed/);
    expect(view.error?.detail).toMatch(/Stop workloads/);
    expect(view.error?.detail).toMatch(/site was started again/);
    expect(view.error?.retryable).toBe(true);
    // Steps the run never reached read as skipped, not as still pending.
    expect(view.steps.find((s) => s.key === 'revert')!.state).toBe('skipped');
    expect(view.steps[view.steps.length - 1]).toMatchObject({ key: 'recover', state: 'succeeded' });
  });

  it('a failure after the revert landed says the files WERE restored', () => {
    let t = quiesced();
    t = applyRevertStep(t, { step: 'wait-maintenance', ok: true }, at(20));
    t = applyRevertStep(t, { step: 'longhorn-revert', ok: true }, at(21));
    t = applyRevertStep(t, { step: 'detach-maintenance', ok: true }, at(22));
    t = failInFlight(beginStep(t, 'unquiesce', at(22)), at(322));
    t = endStep(beginStep(t, 'recover', at(322)), 'recover', false, null, at(622));
    const view = buildRestoreStatusView(row({ state: 'failed', lastError: 'x', progressSteps: t }), 'tenant');
    expect(view.error?.detail).toMatch(/files were restored to the snapshot/);
    expect(view.error?.detail).toMatch(/could not be started again/);
    // Nothing to retry until support has started the site again.
    expect(view.error?.retryable).toBe(false);
    expect(view.error?.remediation[0]).toMatch(/contact support/i);
  });

  it('a failure ON the revert does not claim either way', () => {
    let t = quiesced();
    t = applyRevertStep(t, { step: 'wait-maintenance', ok: true }, at(20));
    t = applyRevertStep(t, { step: 'detach-maintenance', ok: true, detail: 'after-failure' }, at(80));
    const view = buildRestoreStatusView(row({ state: 'failed', lastError: 'timeout', progressSteps: t }), 'tenant');
    expect(view.error?.detail).toMatch(/may still be in their previous state/);
  });
});

describe('restore-status view — edges', () => {
  it('a restore from before step tracking has no steps (the UI falls back to the bar)', () => {
    const view = buildRestoreStatusView(row({ state: 'idle', progressPct: 100, progressSteps: null, completedAt: at(60) }), 'tenant');
    expect(view.steps).toEqual([]);
    expect(view.outcome).toBe('succeeded');
    expect(view.completedAt).toBe(at(60).toISOString());
  });

  it('an op closed while a step was in flight (orchestrator died) shows that step failed, not spinning', () => {
    const t = beginStep(endStep(beginStep(EMPTY_TIMELINE, 'quiesce', at(0)), 'quiesce', true, null, at(5)), 'wait-detach', at(5));
    const view = buildRestoreStatusView(row({ state: 'failed', lastError: 'abandoned', progressSteps: t }), 'tenant');
    expect(view.steps.find((s) => s.key === 'wait-detach')!.state).toBe('failed');
    expect(view.steps.some((s) => s.state === 'running')).toBe(false);
  });

  it('recovery after a failure keeps the restore "running" until it finishes', () => {
    let t = failInFlight(beginStep(EMPTY_TIMELINE, 'quiesce', at(0)), at(5));
    t = beginStep(t, 'recover', at(5));
    // The orchestrator marks the op failed only AFTER recovery, so the state
    // is still non-terminal here and the modal keeps polling.
    const view = buildRestoreStatusView(row({ state: 'quiescing', progressSteps: t }), 'tenant');
    expect(view.outcome).toBe('running');
    expect(view.steps[view.steps.length - 1]).toMatchObject({ key: 'recover', state: 'running' });
  });

  it('strips an old-format step detail from the message for a tenant, keeps it for an operator', () => {
    const legacy = row({ progressSteps: null, progressMessage: 'Restoring — attach-maintenance (node=node-a)' });
    expect(buildRestoreStatusView(legacy, 'tenant').progressMessage).toBe('Restoring — attach-maintenance');
    expect(buildRestoreStatusView(legacy, 'operator').progressMessage).toBe('Restoring — attach-maintenance (node=node-a)');
  });

  it('a success reports 100% even if the last progress write was earlier', () => {
    const view = buildRestoreStatusView(row({ state: 'idle', progressPct: 90 }), 'operator');
    expect(view.progressPct).toBe(100);
  });
});

describe('restoreStatusAudience', () => {
  it('fails closed to the tenant view', () => {
    expect(restoreStatusAudience({ panel: 'tenant', role: 'tenant_admin' })).toBe('tenant');
    // A tenant-panel token with a staff role is still a tenant-panel token.
    expect(restoreStatusAudience({ panel: 'tenant', role: 'super_admin' })).toBe('tenant');
    expect(restoreStatusAudience({ panel: 'admin', role: 'tenant_admin' })).toBe('tenant');
    expect(restoreStatusAudience({ panel: 'admin' })).toBe('tenant');
    expect(restoreStatusAudience(undefined)).toBe('tenant');
  });

  it('gives staff on the admin panel the operator view', () => {
    expect(restoreStatusAudience({ panel: 'admin', role: 'super_admin' })).toBe('operator');
    expect(restoreStatusAudience({ panel: 'admin', role: 'admin' })).toBe('operator');
    expect(restoreStatusAudience({ panel: 'admin', role: 'support' })).toBe('operator');
  });
});
