/**
 * Daily mail-snapshot prune — orchestration tests.
 *
 * Every I/O edge is injected, so each branch is driven directly: the order of
 * the gates matters as much as the prune call itself (a frozen or unbound
 * target must not consume the day's claim, and a failure must not wait a day).
 */

import { describe, it, expect, vi } from 'vitest';

import {
  runMailSnapshotPrune,
  PRUNE_INTERVAL_MS,
  PRUNE_LEASE_MS,
  PRUNE_MAX_REPACK_SIZE,
  PRUNE_RETRY_AFTER_FAILURE_MS,
  PRUNE_RETRY_LOCK,
  PRUNE_TIMEOUT_MS,
  type MailSnapshotPruneDeps,
} from './snapshot-prune.js';
import { TargetFrozenError } from '../backup-config/writable-guard.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';

const NOW = new Date('2026-10-01T03:00:00.000Z');
const SHIM_REPO = `s3:${SHIM_S3_ENDPOINT_URL}/mail/mail-snapshots/cluster-1`;

function deps(overrides: Partial<MailSnapshotPruneDeps> = {}): MailSnapshotPruneDeps & {
  [K in 'claim' | 'setNextDue' | 'readLastResult' | 'recordResult' | 'prune' | 'notifyFailure']: ReturnType<typeof vi.fn>
} {
  return {
    disabled: () => false,
    findMailTargetId: vi.fn(async () => 'target-1'),
    requireWritable: vi.fn(async () => 'StorageBox'),
    readRepoEnv: vi.fn(async () => ({
      RESTIC_REPOSITORY: SHIM_REPO,
      RESTIC_PASSWORD: 'repo-password',
      AWS_ACCESS_KEY_ID: 'shim-ak',
      AWS_SECRET_ACCESS_KEY: 'shim-sk',
    })),
    claim: vi.fn(async () => true),
    setNextDue: vi.fn(async () => undefined),
    readLastResult: vi.fn(async () => null),
    recordResult: vi.fn(async () => undefined),
    prune: vi.fn(async () => undefined),
    notifyFailure: vi.fn(async () => undefined),
    now: () => NOW,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as never;
}

describe('runMailSnapshotPrune', () => {
  it('prunes the repo the job writes, through the shim, bounded and waiting out a live lock', async () => {
    const d = deps();
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('pruned');
    expect(d.prune).toHaveBeenCalledTimes(1);
    const args = d.prune.mock.calls[0][0];
    expect(args.repoUri).toBe(SHIM_REPO);
    expect(args.passwordHex).toBe('repo-password');
    expect(args.target).toMatchObject({ kind: 'shim', accessKey: 'shim-ak', secretKey: 'shim-sk' });
    // The snapshot Job may hold a lock when the prune starts — wait, don't fail.
    expect(args.retryLock).toBe(PRUNE_RETRY_LOCK);
    // Bounded, so the exclusive lock the Job waits on stays short.
    expect(args.maxRepackSize).toBe(PRUNE_MAX_REPACK_SIZE);
    expect(args.timeoutMs).toBe(PRUNE_TIMEOUT_MS);
    expect(d.recordResult).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'pruned', error: null }));
  });

  // The claim is a LEASE, not the day's verdict: a replica killed mid-prune
  // (deploy, OOM) must not leave the next attempt a full day away.
  it('claims a lease that outlives the prune timeout, and only a success schedules tomorrow', async () => {
    const d = deps();
    await runMailSnapshotPrune(d);
    expect(d.claim).toHaveBeenCalledWith(
      NOW.toISOString(),
      new Date(NOW.getTime() + PRUNE_LEASE_MS).toISOString(),
    );
    expect(PRUNE_LEASE_MS).toBeGreaterThan(PRUNE_TIMEOUT_MS);
    expect(PRUNE_LEASE_MS).toBeLessThan(PRUNE_INTERVAL_MS);
    expect(d.setNextDue).toHaveBeenCalledWith(new Date(NOW.getTime() + PRUNE_INTERVAL_MS).toISOString());
  });

  it('records a durable running marker BEFORE pruning', async () => {
    const order: string[] = [];
    const d = deps({
      recordResult: vi.fn(async (r: { outcome: string }) => { order.push(`record:${r.outcome}`); }),
      prune: vi.fn(async () => { order.push('prune'); }),
    });
    await runMailSnapshotPrune(d);
    expect(order).toEqual(['record:running', 'prune', 'record:pruned']);
  });

  it('says so when the previous attempt never finished, and prunes anyway', async () => {
    const d = deps({
      readLastResult: vi.fn(async () => ({
        outcome: 'running', at: '2026-09-30T03:00:00.000Z', durationMs: null, error: null,
      })),
    });
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('pruned');
    expect(d.notifyFailure).toHaveBeenCalledTimes(1);
    expect(String(d.notifyFailure.mock.calls[0][0])).toMatch(/never finished/);
  });

  it('a bookkeeping failure after a SUCCESSFUL prune is not reported as a failed prune', async () => {
    const d = deps({
      recordResult: vi.fn(async (r: { outcome: string }) => {
        if (r.outcome === 'pruned') throw new Error('db blip');
      }),
    });
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('pruned');
    expect(d.notifyFailure).not.toHaveBeenCalled();
    expect(d.setNextDue).toHaveBeenCalledWith(new Date(NOW.getTime() + PRUNE_INTERVAL_MS).toISOString());
  });

  it('does nothing when another replica (or an earlier run today) holds the claim', async () => {
    const d = deps({ claim: vi.fn(async () => false) });
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('not-due');
    expect(d.prune).not.toHaveBeenCalled();
    expect(d.recordResult).not.toHaveBeenCalled();
    expect(d.setNextDue).not.toHaveBeenCalled();
  });

  it('a failed prune retries within the hour instead of waiting a day, and says so', async () => {
    const d = deps({ prune: vi.fn(async () => { throw new Error('repository is already locked exclusively'); }) });
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('failed');
    expect(d.setNextDue).toHaveBeenCalledWith(new Date(NOW.getTime() + PRUNE_RETRY_AFTER_FAILURE_MS).toISOString());
    expect(d.setNextDue).not.toHaveBeenCalledWith(new Date(NOW.getTime() + PRUNE_INTERVAL_MS).toISOString());
    expect(d.notifyFailure).toHaveBeenCalledTimes(1);
    expect(d.recordResult).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', error: expect.stringContaining('locked exclusively'),
    }));
  });

  // The gates below run BEFORE the claim: none of them may burn the day's slot.
  it.each([
    ['disabled', { disabled: () => true }],
    ['no-target', { findMailTargetId: vi.fn(async () => null) }],
    ['no-target', { readRepoEnv: vi.fn(async () => null) }],
    ['no-target', { readRepoEnv: vi.fn(async () => ({ RESTIC_REPOSITORY: '' })) }],
    ['unsupported-repo', { readRepoEnv: vi.fn(async () => ({
      RESTIC_REPOSITORY: 's3:https://objects.example.test/bucket/mail',
      RESTIC_PASSWORD: 'p', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's',
    })) }],
    // A prefix match alone must not pass: this host merely STARTS with the shim's.
    ['unsupported-repo', { readRepoEnv: vi.fn(async () => ({
      RESTIC_REPOSITORY: `s3:${SHIM_S3_ENDPOINT_URL}0/mail/x`,
      RESTIC_PASSWORD: 'p', AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's',
    })) }],
    ['incomplete-credentials', { readRepoEnv: vi.fn(async () => ({
      RESTIC_REPOSITORY: SHIM_REPO, RESTIC_PASSWORD: 'p', AWS_ACCESS_KEY_ID: 'a',
    })) }],
  ] as const)('%s: skips without claiming or pruning', async (outcome, override) => {
    const d = deps(override as Partial<MailSnapshotPruneDeps>);
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe(outcome);
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.prune).not.toHaveBeenCalled();
  });

  it('a DR-frozen target is never pruned and does not consume the claim', async () => {
    const d = deps({
      requireWritable: vi.fn(async () => { throw new TargetFrozenError('target-1', 'StorageBox'); }),
    });
    const res = await runMailSnapshotPrune(d);
    expect(res.outcome).toBe('frozen');
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.prune).not.toHaveBeenCalled();
  });

  it('an unexpected error from the writable check propagates (not mistaken for frozen)', async () => {
    const d = deps({ requireWritable: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(runMailSnapshotPrune(d)).rejects.toThrow('db down');
    expect(d.prune).not.toHaveBeenCalled();
  });
});
