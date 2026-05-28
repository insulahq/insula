/**
 * standby-cleanup.ts unit tests (2026-05-28).
 *
 * When a node is de-elected from the secondary/tertiary placement, the
 * mail-standby DaemonSet pod is evicted (label removed) but the
 * on-disk standby data at /var/lib/mail-stack-standby/ remains. The
 * de-election cleanup helper schedules a one-shot Job pinned to the
 * de-elected node that renames the directory to
 * /var/lib/mail-stack-standby.deelected-<unix-ts>/, giving operators a
 * 48h window to recover (sibling janitor CronJob deletes anything
 * older than 48h).
 *
 * Helper invariants under test:
 *   - Job spec uses hostPath /var/lib (read-write mount) on de-elected node
 *   - Job is name-stable per node (re-running the same de-election is idempotent)
 *   - activeDeadlineSeconds + ttlSecondsAfterFinished are set so the Job
 *     self-cleans within an hour
 *   - 409 Conflict on createJob (concurrent reconciler raced us) is a no-op
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnStandbyDeelectionCleanupJob, STANDBY_CLEANUP_JOB_NAME_PREFIX } from './standby-cleanup.js';

const mockCreateNamespacedJob = vi.fn();

function makeBatch() {
  return { createNamespacedJob: mockCreateNamespacedJob } as unknown as
    import('@kubernetes/client-node').BatchV1Api;
}

describe('spawnStandbyDeelectionCleanupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a Job pinned to the de-elected node via spec.template.spec.nodeName', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1');
    expect(mockCreateNamespacedJob).toHaveBeenCalledTimes(1);
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: {
      spec: { template: { spec: { nodeName?: string; tolerations?: unknown[] } } };
    } };
    expect(arg.body.spec.template.spec.nodeName).toBe('staging1');
  });

  it('mounts /var/lib via hostPath so the rename can reach the standby dir', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1');
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: {
      spec: { template: { spec: { volumes?: Array<{ name: string; hostPath?: { path: string } }> } } };
    } };
    const hp = arg.body.spec.template.spec.volumes?.find((v) => v.hostPath);
    expect(hp).toBeDefined();
    expect(hp!.hostPath!.path).toBe('/var/lib');
  });

  it('runs a mv command renaming to mail-stack-standby.deelected-<ts>', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1');
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: {
      spec: { template: { spec: { containers: Array<{ command?: string[]; args?: string[] }> } } };
    } };
    const cmd = arg.body.spec.template.spec.containers[0];
    const text = (cmd.command ?? []).concat(cmd.args ?? []).join(' ');
    expect(text).toMatch(/mv\s+\/host\/mail-stack-standby\s+\/host\/mail-stack-standby\.deelected-/);
  });

  it('sets activeDeadlineSeconds and ttlSecondsAfterFinished so the Job self-cleans', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1');
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: {
      spec: { activeDeadlineSeconds?: number; ttlSecondsAfterFinished?: number };
    } };
    expect(arg.body.spec.activeDeadlineSeconds).toBeGreaterThan(0);
    expect(arg.body.spec.activeDeadlineSeconds).toBeLessThanOrEqual(300);
    expect(arg.body.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(arg.body.spec.ttlSecondsAfterFinished).toBeLessThanOrEqual(3600);
  });

  it('uses a name-stable per-node Job name (prefix + node hash) so a re-run of the same de-election is idempotent via 409', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1');
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: { metadata: { name: string } } };
    expect(arg.body.metadata.name).toMatch(new RegExp(`^${STANDBY_CLEANUP_JOB_NAME_PREFIX}`));
    expect(arg.body.metadata.name).toContain('staging1');
  });

  it('swallows 409 Conflict (concurrent reconciler raced — Job already exists)', async () => {
    const conflict = Object.assign(new Error('AlreadyExists'), { code: 409, statusCode: 409 });
    mockCreateNamespacedJob.mockRejectedValue(conflict);
    await expect(
      spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1'),
    ).resolves.not.toThrow();
  });

  it('propagates non-409 errors (so caller can log + retry next reconcile)', async () => {
    const boom = Object.assign(new Error('500 Internal'), { code: 500, statusCode: 500 });
    mockCreateNamespacedJob.mockRejectedValue(boom);
    await expect(
      spawnStandbyDeelectionCleanupJob(makeBatch(), 'staging1'),
    ).rejects.toThrow(/500|Internal/);
  });

  it('sanitises an awkward node name into a DNS-1123-safe Job name', async () => {
    mockCreateNamespacedJob.mockResolvedValue({});
    await spawnStandbyDeelectionCleanupJob(makeBatch(), 'Worker.Phoenix-Host.Net');
    const arg = mockCreateNamespacedJob.mock.calls[0][0] as { body: { metadata: { name: string } } };
    // DNS-1123: lowercase, only [a-z0-9-]
    expect(arg.body.metadata.name).toMatch(/^[a-z0-9-]+$/);
    expect(arg.body.metadata.name.length).toBeLessThanOrEqual(63);
  });
});
