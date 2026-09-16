import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { renderManualSnapshotJobForTest } from './snapshot.js';

/**
 * Backup-health discovery for mail snapshots, across BOTH firing paths.
 *
 * NATIVE mode fires via the Kubernetes CronJob controller, which stamps
 * `spec.jobTemplate.metadata` onto each Job. PLATFORM mode (operator cadence !=
 * the manifest default) bypasses that controller entirely: platform-api builds
 * the Job itself in `renderManualSnapshotJob`, so anything the controller would
 * have copied has to be copied here too.
 *
 * Miss that and the failure is silent in the worst way — the label selector
 * matches nothing, the scheduler lists an empty set every tick, and every
 * surface keeps reporting healthy. DEV lost 3 days 17 hours of mail snapshots
 * with exactly that shape of blindness.
 */

const MANIFEST = join(
  import.meta.dirname,
  '../../../../k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml',
);

const WATCH = 'insula.host/backup-health-watch';

function loadCronJob(): Record<string, unknown> {
  const docs = readFileSync(MANIFEST, 'utf8')
    .split(/^---$/m)
    .map((d) => parse(d) as Record<string, unknown> | null)
    .filter((d): d is Record<string, unknown> => !!d);
  const cj = docs.find((d) => d.kind === 'CronJob');
  if (!cj) throw new Error('no CronJob in snapshot-cronjob.yaml');
  return cj;
}

describe('mail snapshot: backup-health labels', () => {
  it('the manifest labels the JOB TEMPLATE, which is what the controller copies', () => {
    const cj = loadCronJob();
    const jt = (cj.spec as Record<string, unknown>).jobTemplate as Record<string, unknown>;
    const meta = jt.metadata as { labels?: Record<string, string>; annotations?: Record<string, string> };

    // Labels on the CronJob's own metadata are NOT copied onto its Jobs.
    expect(meta?.labels?.[WATCH]).toBe('true');
    expect(meta?.labels?.['insula.host/backup-category']).toBe('dr');
    expect(meta?.annotations?.['insula.host/backup-display-name']).toBeTruthy();
  });

  it('a platform-fired Job carries the same labels the controller would have set', () => {
    const cj = loadCronJob();
    const job = renderManualSnapshotJobForTest('stalwart-snapshot-cron-202609151300', cj) as {
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
    };

    expect(job.metadata.labels[WATCH]).toBe('true');
    expect(job.metadata.labels['insula.host/backup-category']).toBe('dr');
    expect(job.metadata.annotations?.['insula.host/backup-display-name']).toBeTruthy();
  });

  it('does not let the manifest override the identity labels this path owns', () => {
    // Propagation must not clobber the snapshot-job label the mail module
    // selects on, or trigger provenance.
    const cj = {
      spec: {
        jobTemplate: {
          metadata: { labels: { [WATCH]: 'true', 'stalwart-snapshot-trigger': 'wrong' } },
          spec: { template: { metadata: {}, spec: { containers: [] } } },
        },
      },
    };
    const job = renderManualSnapshotJobForTest('j', cj) as {
      metadata: { labels: Record<string, string> };
    };
    expect(job.metadata.labels['stalwart-snapshot-trigger']).toBe('manual');
    expect(job.metadata.labels[WATCH]).toBe('true');
  });

  it('is a no-op on a template with no metadata (older manifests)', () => {
    const cj = { spec: { jobTemplate: { spec: { template: { metadata: {}, spec: { containers: [] } } } } } };
    const job = renderManualSnapshotJobForTest('j', cj) as {
      metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
    };
    expect(job.metadata.labels[WATCH]).toBeUndefined();
    expect(job.metadata.annotations).toBeUndefined();
  });
});
