import { describe, it, expect } from 'vitest';
import { isResticLockError, isResticRepoMissingError } from './restic-driver.js';

/**
 * Lock-vs-broken classification.
 *
 * Getting this wrong in either direction is costly: treat a lock as "broken"
 * and the repo stays stuck forever (DEV lost 3 days 17 hours of mail snapshots
 * that way); treat a real corruption as "locked" and we unlock-and-retry into
 * the same failure.
 */
describe('isResticLockError', () => {
  it('recognises restic >= 0.17 exit code 11', () => {
    expect(isResticLockError(11, '')).toBe(true);
  });

  it('recognises the message on older builds that exit 1', () => {
    // The image has historically carried older restic; the exit code alone is
    // not enough there.
    expect(isResticLockError(1, 'Fatal: unable to create lock in backend')).toBe(true);
    expect(isResticLockError(1, 'repository is already locked by PID 12 on host x')).toBe(true);
  });

  it('does NOT classify unrelated failures as locks', () => {
    // Unlocking and retrying these would just fail again, having hidden the
    // real cause a second time.
    expect(isResticLockError(1, 'Fatal: wrong password')).toBe(false);
    expect(isResticLockError(12, 'Fatal: wrong password')).toBe(false);
    expect(isResticLockError(10, 'Fatal: unable to open config file')).toBe(false);
    expect(isResticLockError(1, 'Get "http://shim:9000": connection refused')).toBe(false);
    expect(isResticLockError(1, 'Fatal: repository contains errors')).toBe(false);
  });

  it('treats success as not-a-lock', () => {
    expect(isResticLockError(0, '')).toBe(false);
  });
});

/**
 * "No repository here" vs every other failure. The DR layout probe reads the
 * first as "this bundle predates the per-tenant merge"; reading a wrong
 * password or an unreachable shim the same way would point the restore at the
 * wrong repository.
 */
describe('isResticRepoMissingError', () => {
  it('recognises the missing-repository message restic prints (exit 10)', () => {
    expect(isResticRepoMissingError(new Error(
      'restic snapshots exited 10: Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.',
    ))).toBe(true);
  });

  it('does not treat a wrong password as a missing repository', () => {
    expect(isResticRepoMissingError(new Error('restic snapshots exited 12: Fatal: wrong password or no key found'))).toBe(false);
  });

  it('does not treat an unreachable backend as a missing repository', () => {
    expect(isResticRepoMissingError(new Error('restic snapshots exited 1: Fatal: unable to open repository: dial tcp: connection refused'))).toBe(false);
  });

  it('accepts a non-Error throw', () => {
    expect(isResticRepoMissingError('repository does not exist')).toBe(true);
  });
});
