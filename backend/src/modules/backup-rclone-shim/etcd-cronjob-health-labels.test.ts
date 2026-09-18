import { describe, it, expect } from 'vitest';
import { desiredJobTemplateMetadata } from './etcd-cronjob.js';

/**
 * The etcd CronJob cannot receive backup-health labels from its manifest.
 *
 * It is seed-then-disown: once the reconciler stamps
 * `kustomize.toolkit.fluxcd.io/reconcile: disabled`, Flux reports "skipped" for
 * it on every apply, forever. Proven on DEV — the committed manifest
 * carried the labels, the live object's `spec.jobTemplate.metadata` was `{}`,
 * and kustomize-controller logged exactly that. The other three watched
 * CronJobs, which are not disowned, picked the labels up normally.
 *
 * So the reconciler has to converge them, and it has to do so without breaking
 * the idempotence contract the rest of the module depends on.
 */

const WATCH = 'insula.host/backup-health-watch';
const CATEGORY = 'insula.host/backup-category';
const SEVERITY = 'insula.host/backup-severity';
const DISPLAY = 'insula.host/backup-display-name';

const CONVERGED = {
  spec: {
    jobTemplate: {
      metadata: {
        labels: { [WATCH]: 'true', [CATEGORY]: 'dr', [SEVERITY]: 'critical' },
        annotations: { [DISPLAY]: 'etcd snapshot via shim' },
      },
    },
  },
};

describe('desiredJobTemplateMetadata', () => {
  it('produces the labels when the job template has none — the DEV shape', () => {
    const out = desiredJobTemplateMetadata({ spec: { jobTemplate: { metadata: {} } } });
    expect(out).not.toBeNull();
    expect(out!.labels[WATCH]).toBe('true');
    expect(out!.labels[CATEGORY]).toBe('dr');
    expect(out!.labels[SEVERITY]).toBe('critical');
    expect(out!.annotations[DISPLAY]).toBeTruthy();
  });

  it('produces them when the metadata key is absent entirely', () => {
    // This is why the op writes /spec/jobTemplate/metadata as one object: a
    // JSON-patch `add` to .../metadata/labels is a 422 when metadata is missing.
    const out = desiredJobTemplateMetadata({ spec: { jobTemplate: {} } });
    expect(out!.labels[WATCH]).toBe('true');
  });

  it('returns null once converged, so a settled CronJob makes no apiserver call', () => {
    // The module's idempotence contract: unchanged inputs → zero ops.
    expect(desiredJobTemplateMetadata(CONVERGED)).toBeNull();
  });

  it('re-converges a single drifted value', () => {
    const drifted = {
      spec: { jobTemplate: { metadata: {
        labels: { ...CONVERGED.spec.jobTemplate.metadata.labels, [SEVERITY]: 'info' },
        annotations: CONVERGED.spec.jobTemplate.metadata.annotations,
      } } },
    };
    expect(desiredJobTemplateMetadata(drifted)!.labels[SEVERITY]).toBe('critical');
  });

  it('keeps labels and annotations an operator added to the job template', () => {
    // Merged, not replaced — the reconciler owns its own keys, not the object.
    const extra = {
      spec: { jobTemplate: { metadata: {
        labels: { 'ops.example.test/owner': 'sre' },
        annotations: { 'ops.example.test/note': 'keep me' },
      } } },
    };
    const out = desiredJobTemplateMetadata(extra)!;
    expect(out.labels['ops.example.test/owner']).toBe('sre');
    expect(out.annotations['ops.example.test/note']).toBe('keep me');
    expect(out.labels[WATCH]).toBe('true');
  });

  it('treats a missing annotation as drift even when every label is right', () => {
    // The display name is what the UI and the notification body call the job;
    // without it they render a bare namespace/name.
    const noAnnotation = {
      spec: { jobTemplate: { metadata: { labels: CONVERGED.spec.jobTemplate.metadata.labels } } },
    };
    expect(desiredJobTemplateMetadata(noAnnotation)).not.toBeNull();
  });
});
