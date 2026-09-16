import { describe, it, expect, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  runResticForget,
  runResticBackup,
  ResticCommandError,
  __setResticSpawnForTest,
  __resetResticSpawnForTest,
  type BackupTarget,
} from './restic-driver.js';

/**
 * Stale-lock RECOVERY, as opposed to classification (restic-lock.test.ts).
 *
 * The behaviour under test is what stops a single killed pod from wedging a repo
 * forever — DEV lost 3 days 17 hours of mail snapshots to exactly that, and
 * staging lost 3 hours to it in May. Both were patched inside the mail image;
 * this driver serves every tenant/bundle repo and needed the same thing.
 *
 * Three properties matter, and each can fail silently:
 *   - a stale lock is cleared and the operation retried;
 *   - the retry happens ONCE, because a lock that survives `unlock` is held by
 *     a live process and looping past it is the trampling we are avoiding;
 *   - a non-lock failure is never unlocked, because unlocking a wrong password
 *     just retries into the same error having hidden the cause a second time.
 */

const TARGET: BackupTarget = {
  kind: 'shim',
  endpoint: 'http://shim.platform.svc:9000',
  bucket: 'tenant',
  accessKey: 'ak',
  secretKey: 'sk',
};
const PW = 'a'.repeat(64);
const REPO = 's3:http://shim.platform.svc:9000/tenant/restic-files/t1';
const SNAP = '1'.repeat(64);

/** Which restic subcommand an argv represents. */
function subcommand(argv: ReadonlyArray<string>): string {
  for (const a of argv) {
    if (['backup', 'forget', 'prune', 'init', 'unlock', 'snapshots', 'stats'].includes(a)) return a;
  }
  return '?';
}

/**
 * Spawn stub driven by a per-subcommand queue of outcomes, so a test can say
 * "forget fails locked, then succeeds" without reaching into the driver.
 */
type Outcome = { code: number; stderr?: string };

function stubSpawn(plan: Record<string, Outcome[]>): { seen: string[] } {
  const queues: Record<string, Outcome[]> = {};
  for (const [k, v] of Object.entries(plan)) queues[k] = [...v];
  return stubSpawnBy((cmd) => queues[cmd]?.shift() ?? { code: 0 });
}

/** Full control: decide each outcome from the subcommand and its argv. */
function stubSpawnBy(decide: (cmd: string, argv: ReadonlyArray<string>) => Outcome): {
  seen: string[];
} {
  const seen: string[] = [];
  __setResticSpawnForTest((_bin, args) => {
    const cmd = subcommand(args);
    seen.push(cmd);
    const outcome = decide(cmd, args);
    return {
      stdout: Readable.from([]),
      stderr: Readable.from(outcome.stderr ? [outcome.stderr] : []),
      stdin: { write: () => true, end: () => undefined, on: () => undefined },
      on(evt: string, cb: (c: number | null) => void) {
        if (evt === 'exit') setImmediate(() => cb(outcome.code));
        return this;
      },
      kill: () => undefined,
    } as never;
  });
  return { seen };
}

afterEach(() => __resetResticSpawnForTest());

describe('stale-lock recovery on retryable operations', () => {
  it('clears the lock and retries forget once, then succeeds', async () => {
    const { seen } = stubSpawn({
      forget: [{ code: 11, stderr: 'Fatal: unable to create lock in backend' }, { code: 0 }],
    });
    await runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [SNAP] });
    expect(seen).toEqual(['forget', 'unlock', 'forget']);
  });

  it('gives up after ONE retry when the lock survives the unlock', async () => {
    // A lock still present after a plain `unlock` is held by a LIVE process.
    // Looping here is what `--remove-all` would do to a running backup.
    const locked = { code: 11, stderr: 'Fatal: unable to create lock in backend' };
    const { seen } = stubSpawn({ forget: [locked, locked, locked, locked] });

    await expect(
      runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [SNAP] }),
    ).rejects.toThrow(/lock survived unlock/);

    expect(seen).toEqual(['forget', 'unlock', 'forget']);
  });

  it('never unlocks a failure that is not a lock', async () => {
    const { seen } = stubSpawn({ forget: [{ code: 12, stderr: 'Fatal: wrong password' }] });

    await expect(
      runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [SNAP] }),
    ).rejects.toThrow(/wrong password/);

    expect(seen).toEqual(['forget']);
  });

  it('surfaces the unlock failure alongside the original when unlock itself fails', async () => {
    const { seen } = stubSpawn({
      forget: [{ code: 11, stderr: 'Fatal: unable to create lock in backend' }],
      unlock: [{ code: 1, stderr: 'Fatal: Access Denied' }],
    });

    await expect(
      runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [SNAP] }),
    ).rejects.toThrow(/Access Denied/);

    expect(seen).toEqual(['forget', 'unlock']);
  });

  it('does not deadlock when every concurrent operation hits a lock at once', async () => {
    // Recovery runs INSIDE a held concurrency slot. If the unlock re-acquired
    // one, a full semaphore (cap 4) of locked forgets would each wait for a slot
    // that only the unlock they are blocked on can free. This hangs rather than
    // fails if that regresses, so it is bounded by the test timeout.
    // Each op gets its own repo so the stub can track it independently —
    // a single shared queue would interleave unpredictably across 8 callers.
    const unlocked = new Set<string>();
    const repoOf = (argv: ReadonlyArray<string>) => argv[argv.indexOf('--repo') + 1] ?? '';
    const { seen } = stubSpawnBy((cmd, argv) => {
      const repo = repoOf(argv);
      if (cmd === 'unlock') {
        unlocked.add(repo);
        return { code: 0 };
      }
      if (cmd === 'forget' && !unlocked.has(repo)) {
        return { code: 11, stderr: 'unable to create lock' };
      }
      return { code: 0 };
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runResticForget({
          target: TARGET,
          passwordHex: PW,
          repoUri: `${REPO}-${i}`,
          snapshotIds: [SNAP],
        }),
      ),
    );

    expect(seen.filter((c) => c === 'unlock')).toHaveLength(8);
  }, 10_000);
});

describe('stale-lock handling on backup (not retryable)', () => {
  it('clears the lock but does NOT re-run backup, because stdin is one-shot', async () => {
    const { seen } = stubSpawn({
      backup: [{ code: 11, stderr: 'Fatal: unable to create lock in backend' }],
    });

    const err = await runResticBackup({
      target: TARGET,
      tenantId: 't1',
      component: 'files',
      passwordHex: PW,
      stdinFilename: 'files.tar',
      tags: [],
      stdin: Readable.from([Buffer.from('payload')]),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // Re-running would push an empty or truncated stream and record it as a
    // successful backup — worse than the failure it papers over.
    expect(seen).toEqual(['init', 'backup', 'unlock']);
    expect(err).toBeInstanceOf(ResticCommandError);
    expect((err as ResticCommandError).lockCleared).toBe(true);
  });

  it('reports lockCleared=false when the unlock could not run', async () => {
    const { seen } = stubSpawn({
      backup: [{ code: 11, stderr: 'unable to create lock' }],
      unlock: [{ code: 1, stderr: 'Fatal: Access Denied' }],
    });

    const err = await runResticBackup({
      target: TARGET,
      tenantId: 't1',
      component: 'files',
      passwordHex: PW,
      stdinFilename: 'files.tar',
      tags: [],
      stdin: Readable.from([Buffer.from('payload')]),
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(seen).toEqual(['init', 'backup', 'unlock']);
    expect((err as ResticCommandError).lockCleared).toBe(false);
  });
});
