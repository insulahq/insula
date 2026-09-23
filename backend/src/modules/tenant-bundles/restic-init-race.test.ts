import { describe, it, expect, vi } from 'vitest';
import {
  isResticInitLostRace,
  retryWhileInitRaceLost,
  ResticCommandError,
} from './restic-driver.js';

/**
 * `restic init` has two distinct "already there" outcomes and they need
 * opposite handling:
 *
 *   - "config file already exists" / "repository master key and config already
 *     initialized" → the repo is ready; success.
 *   - "repository already contains keys" → keys exist but the config is NOT
 *     visible. Either another initialiser is mid-flight (wait), or the repo is
 *     genuinely half-written (report it).
 *
 * Conflating them is what failed Danllet Estate's files component on
 * 2026-09-23: the loser of an init race reported a hard failure.
 */

const lostRace = (): ResticCommandError =>
  new ResticCommandError(
    'restic init',
    1,
    'Fatal: create key in repository at s3:http://shim/tenant/restic/t1 failed: repository already contains keys',
  );

describe('isResticInitLostRace', () => {
  it('recognises restic\'s "already contains keys" guard', () => {
    expect(isResticInitLostRace(lostRace())).toBe(true);
  });

  it('does NOT treat an already-initialised repo as a lost race', () => {
    // These never reach the retry path — execResticInit returns success — but
    // if that ever changes, waiting on them would be pointless.
    expect(isResticInitLostRace(new ResticCommandError('restic init', 1, 'config file already exists'))).toBe(false);
    expect(
      isResticInitLostRace(
        new ResticCommandError('restic init', 1, 'repository master key and config already initialized'),
      ),
    ).toBe(false);
  });

  it('does NOT swallow unrelated failures', () => {
    expect(isResticInitLostRace(new ResticCommandError('restic init', 1, 'Fatal: wrong password'))).toBe(false);
    expect(
      isResticInitLostRace(
        new ResticCommandError('restic init', 1, 'config or key abc is damaged: ciphertext verification failed'),
      ),
    ).toBe(false);
    expect(isResticInitLostRace(new Error('boom'))).toBe(false);
    expect(isResticInitLostRace(undefined)).toBe(false);
  });
});

describe('retryWhileInitRaceLost', () => {
  const noSleep = async (): Promise<void> => undefined;

  it('succeeds once the winner finishes writing its config', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw lostRace();
      return 'initialised';
    });

    await expect(retryWhileInitRaceLost(run, { sleep: noSleep })).resolves.toBe('initialised');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget rather than looping forever', async () => {
    // Keys with no config that never appears is a genuinely broken repo; it
    // must be REPORTED, not retried until the bundle times out.
    const run = vi.fn(async () => {
      throw lostRace();
    });

    await expect(retryWhileInitRaceLost(run, { attempts: 3, sleep: noSleep })).rejects.toThrow(
      'already contains keys',
    );
    expect(run).toHaveBeenCalledTimes(4); // first attempt + 3 retries
  });

  it('does not retry an unrelated failure', async () => {
    const run = vi.fn(async () => {
      throw new ResticCommandError('restic init', 1, 'Fatal: wrong password');
    });

    await expect(retryWhileInitRaceLost(run, { sleep: noSleep })).rejects.toThrow('wrong password');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits between attempts and says so', async () => {
    const sleep = vi.fn(async () => undefined);
    const warn = vi.fn();
    let calls = 0;
    await retryWhileInitRaceLost(
      async () => {
        calls += 1;
        if (calls === 1) throw lostRace();
        return 'ok';
      },
      { sleep, log: { warn }, delayMs: 250 },
    );

    expect(sleep).toHaveBeenCalledWith(250);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('another initialiser');
  });
});
