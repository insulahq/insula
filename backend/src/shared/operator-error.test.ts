import { describe, it, expect } from 'vitest';
import { translateOperatorError } from './operator-error.js';

describe('translateOperatorError — admission-webhook vs image-pull disambiguation', () => {
  it('classifies admission-webhook denials as ADMISSION_WEBHOOK_DENIED, not image pull', () => {
    // The shape that used to be swallowed by the image-pull branch via
    // its bare /denied/ alternative (testing 2026-06-11: grow_online
    // failures reported "Image pull failed" at the PVC patch step,
    // where no image is ever pulled). NB: denials whose message also
    // matches a MORE specific PVC pattern (e.g. "not ready for
    // workloads" → PVC_FAULTED) keep the more actionable PVC code —
    // the PVC section deliberately runs first.
    const r = translateOperatorError(
      'admission webhook "validator.longhorn.io" denied the request: ' +
      'cannot do size expansion while volume is attached in maintenance mode',
    );
    expect(r.code).toBe('ADMISSION_WEBHOOK_DENIED');
    expect(r.retryable).toBe(true);
    expect(r.diagnostics?.raw).toContain('validator.longhorn.io');
  });

  it('still classifies real registry denials as WORKLOAD_IMAGE_PULL', () => {
    const r = translateOperatorError(
      'Failed to pull image "docker.io/example/app:latest": ' +
      'pull access denied for example/app, repository does not exist or may require authorization',
    );
    expect(r.code).toBe('WORKLOAD_IMAGE_PULL');
  });

  it('still classifies ErrImagePull pod states as WORKLOAD_IMAGE_PULL', () => {
    const r = translateOperatorError('container app in pod x is waiting: ErrImagePull');
    expect(r.code).toBe('WORKLOAD_IMAGE_PULL');
  });

  it('CNPG webhook denial is admission, not image pull', () => {
    const r = translateOperatorError(
      'admission webhook "vcluster.cnpg.io" denied the request: ' +
      'Cluster.cluster.cnpg.io "system-db" is invalid: spec.bootstrap: ' +
      'Forbidden: Only one bootstrap method can be specified at a time',
    );
    expect(r.code).toBe('ADMISSION_WEBHOOK_DENIED');
  });
});
