import { describe, it, expect } from 'vitest';
import { desiredPriorityClass, ETCD_CRONJOB_PRIORITY_CLASS } from './etcd-cronjob.js';

/**
 * ADR-062 moved every platform CronJob to `platform-maintenance` (9000) with a
 * blanket kustomize patch, so a routine maintenance Job can no longer outrank
 * the platform's own services under kubelet eviction.
 *
 * This CronJob is the one the patch cannot reach. It is seed-then-disown: the
 * reconciler stamps `kustomize.toolkit.fluxcd.io/reconcile: disabled` on the
 * live object, Flux reports `skipped` for it forever, and the manifest only
 * ever lands on a FRESH install.
 *
 * Caught on DEV rather than reasoned about: the rendered overlay showed
 * `platform-maintenance` for this CronJob while the live object still read
 * `platform-critical`, alone among the eight. Without the convergence below,
 * the change would have been a silent no-op on every existing cluster — which
 * is exactly the population it was written for.
 */
describe('desiredPriorityClass', () => {
  it('writes the maintenance class when the live object has none', () => {
    expect(desiredPriorityClass({})).toBe(ETCD_CRONJOB_PRIORITY_CLASS);
  });

  it('writes it when the live object still carries the old platform-critical', () => {
    // The state every existing cluster is in before this reconciler runs.
    const live = {
      spec: { jobTemplate: { spec: { template: { spec: { priorityClassName: 'platform-critical' } } } } },
    };
    expect(desiredPriorityClass(live)).toBe('platform-maintenance');
  });

  it('returns null once converged, so a settled CronJob issues no apiserver call', () => {
    // The reconciler's idempotence contract: zero drift must mean zero ops.
    const live = {
      spec: { jobTemplate: { spec: { template: { spec: { priorityClassName: 'platform-maintenance' } } } } },
    };
    expect(desiredPriorityClass(live)).toBeNull();
  });

  it('targets maintenance, not critical — the point of the change', () => {
    // Guards against someone "restoring" the old value to silence a diff.
    expect(ETCD_CRONJOB_PRIORITY_CLASS).toBe('platform-maintenance');
    expect(ETCD_CRONJOB_PRIORITY_CLASS).not.toBe('platform-critical');
  });
});
