/**
 * Every scheduled job that must not run on two platform-api replicas at once
 * stays behind its lease. HA runs three replicas and every in-process
 * scheduler starts on each; these were found running three times (restic
 * prunes colliding on the repository lock, a bandwidth window billed twice, an
 * expired tenant suspended twice, an app upgraded by two replicas at once).
 * Dropping a lease here is a regression this test names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

const LEASED: ReadonlyArray<{ file: string; job: string }> = [
  { file: 'modules/tenant-bundles/restic-retention.ts', job: 'restic-retention' },
  { file: 'modules/system-backup/footprint-scheduler.ts', job: 'system-backup-footprint' },
  { file: 'modules/tenant-bundles/retention.ts', job: 'bundle-retention' },
  { file: 'modules/bandwidth/meter.ts', job: 'bandwidth-meter' },
  { file: 'modules/tenant-lifecycle/scheduler.ts', job: 'lifecycle-hook-retry' },
  { file: 'server.ts', job: 'subscription-expiry' },
  { file: 'server.ts', job: 'deployment-auto-upgrade' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'storage-auto-archive' },
  { file: 'modules/custom-deployments/auto-update-scheduler.ts', job: 'custom-deployment-auto-update' },
  { file: 'modules/notifications/digest/scheduler.ts', job: 'notification-digest' },
  { file: 'modules/notifications/queue/scanner.ts', job: 'notification-reenqueue-scan' },
  { file: 'modules/mail-imapsync/scheduler.ts', job: 'mail-imapsync-reconciler' },
  { file: 'app.ts', job: 'mail-self-heal' },
  { file: 'app.ts', job: 'multihost-remediation-boot' },
  { file: 'modules/mail-admin/stalwart-domain-reconciler.ts', job: 'stalwart-domain-reconciler' },
  { file: 'modules/storage/image-pressure-watcher.ts', job: 'image-pressure-watcher' },
  { file: 'modules/storage/image-prune-scheduler.ts', job: 'daily-image-prune' },
  { file: 'modules/crowdsec-autoban/scheduler.ts', job: 'crowdsec-autoban' },
  { file: 'modules/domains/verification-cron.ts', job: 'domain-verification' },
  { file: 'modules/dns-apex-drift/scheduler.ts', job: 'dns-route-drift-scan' },
  // Pollers of the Kubernetes API. Not unsafe to run three times, but three
  // replicas each listing every pod/Deployment/Node/Certificate on a short
  // cadence was most of the apiserver traffic crossing between the nodes.
  { file: 'app.ts', job: 'deployment-status-reconcile' },
  { file: 'app.ts', job: 'certificate-status-reconcile' },
  { file: 'modules/file-manager/idle-cleanup.ts', job: 'file-manager-idle-cleanup' },
  { file: 'modules/ingress-routes/waf-log-scraper.ts', job: 'waf-log-scraper' },
  { file: 'modules/nodes/scheduler.ts', job: 'node-sync' },
  { file: 'modules/tenant-health/scheduler.ts', job: 'tenant-auto-repin' },
  { file: 'modules/tenant-placement/reconciler.ts', job: 'tenant-placement' },
  { file: 'modules/cluster-health/scheduler.ts', job: 'node-subsystem-health' },
  { file: 'modules/node-health/scheduler.ts', job: 'node-health-monitor' },
  { file: 'modules/cluster-settings/kubelet-gc-reconciler.ts', job: 'kubelet-gc-reconciler' },
  { file: 'modules/system-pod-placement/scheduler.ts', job: 'system-pod-placement' },
  { file: 'modules/storage-lifecycle/scheduler.ts', job: 'tenant-workload-health' },
  { file: 'modules/mail-admin/proxy-networks-reconciler.ts', job: 'mail-proxy-networks' },
  { file: 'modules/mcp/reaper.ts', job: 'mcp-token-reaper' },
];

/**
 * Deliberately NOT leased — each depends on WHERE it runs, so one holder is
 * the wrong shape:
 *  - mail DR watcher: a replica on the failed mail node sits the failover out
 *    so one on a healthy node does it. A single lease holder stuck on the dead
 *    node would keep renewing and no failover would ever happen.
 *  - fast node-down watch: if the holder dies WITH its node, the replica taking
 *    over starts without a baseline and never announces that very node.
 */
const DELIBERATELY_UNLEASED: ReadonlyArray<string> = [
  'modules/mail-admin/dr-watcher.ts',
  'modules/node-health/fast-down-watch.ts',
];

describe('scheduled jobs that must run on one replica', () => {
  it.each(LEASED)('$job ($file) runs behind its lease', ({ file, job }) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src).toMatch(/withSchedulerLease\(/);
    expect(src).toContain(`'${job}'`);
  });

  it.each(DELIBERATELY_UNLEASED)('%s stays on every replica', (file) => {
    expect(readFileSync(join(SRC, file), 'utf8')).not.toMatch(/withSchedulerLease\(/);
  });

  it('the job names are distinct — two jobs sharing a lease would starve each other', () => {
    expect(new Set(LEASED.map((l) => l.job)).size).toBe(LEASED.length);
  });

  it('a graceful shutdown hands every lease to the remaining replicas', () => {
    expect(readFileSync(join(SRC, 'server.ts'), 'utf8')).toMatch(/releaseAllSchedulerLeases\(db\)/);
  });
});
