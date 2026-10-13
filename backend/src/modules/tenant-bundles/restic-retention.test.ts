/**
 * Unit tests for the restic reclamation path (ADR-048).
 *
 * The value here is the guards. This code deletes backups, and every guard
 * exists because the failure mode is unrecoverable — so each is asserted
 * directly rather than through an ORM mock:
 *
 *   G1 min-age    a snapshot younger than the cutoff is never forgotten
 *   G2 no-history a repo the DB has no memory of is skipped, not emptied
 *   G5 two-signal either sha256 or the bundle-id tag saves a snapshot
 *
 * Driver-level tests assert the exact argv, because a mistake there (a missing
 * --repo, an unvalidated id reaching the shell) is the other way this loses
 * data. No real restic binary runs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  nothingLeftToReclaim,
  planRepoReclamation,
  pruneRepositories,
  type PlanRepoReclamationArgs,
  type PruneOutcome,
} from './restic-retention.js';
import {
  runResticForget,
  runResticPrune,
  __setResticSpawnForTest,
  __resetResticSpawnForTest,
  type BackupTarget,
} from './restic-driver.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');
/** Default G1 cutoff: 48h before NOW. */
const CUTOFF = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);

const id = (n: number): string => String(n).repeat(64).slice(0, 64);

function snap(overrides: {
  id: string;
  time: string;
  tags?: string[];
}): { id: string; shortId: string; time: string; tags: string[] } {
  return {
    id: overrides.id,
    shortId: overrides.id.slice(0, 8),
    time: overrides.time,
    tags: overrides.tags ?? [],
  };
}

function plan(over: Partial<PlanRepoReclamationArgs> = {}): ReturnType<typeof planRepoReclamation> {
  return planRepoReclamation({
    snapshots: [],
    keepSnapshotIds: new Set(),
    keepBundleIds: new Set(),
    hasHistory: true,
    minAgeCutoff: CUTOFF,
    ...over,
  });
}

const OLD = '2026-07-01T00:00:00.000Z';   // well past the cutoff
const FRESH = '2026-08-31T06:00:00.000Z'; // 6h old — inside the 48h window

describe('planRepoReclamation — G5 two-signal keep', () => {
  it('keeps a snapshot whose id is referenced by a live bundle', () => {
    const s = snap({ id: id(1), time: OLD });
    const p = plan({ snapshots: [s], keepSnapshotIds: new Set([s.id]) });
    expect(p.forget).toEqual([]);
    expect(p.keep).toEqual([s.id]);
  });

  it('keeps a snapshot whose bundle-id TAG names a live bundle even when sha256 was never recorded', () => {
    const s = snap({ id: id(2), time: OLD, tags: ['component=files', 'bundle-id=bundle-abc'] });
    const p = plan({ snapshots: [s], keepBundleIds: new Set(['bundle-abc']) });
    expect(p.forget).toEqual([]);
  });

  it('keeps a snapshot matched by a short id in the keep set', () => {
    const s = snap({ id: id(3), time: OLD });
    const p = plan({ snapshots: [s], keepSnapshotIds: new Set([s.id.slice(0, 8)]) });
    expect(p.forget).toEqual([]);
  });

  it('forgets a snapshot that NEITHER signal vouches for', () => {
    const s = snap({ id: id(4), time: OLD, tags: ['bundle-id=bundle-dead'] });
    const p = plan({
      snapshots: [s],
      keepSnapshotIds: new Set([id(9)]),
      keepBundleIds: new Set(['bundle-live']),
    });
    expect(p.forget).toEqual([s.id]);
    expect(p.skip).toBeNull();
  });
});

describe('planRepoReclamation — G1 minimum age', () => {
  it('never forgets a snapshot younger than the cutoff, even with no DB reference', () => {
    const s = snap({ id: id(5), time: FRESH });
    const p = plan({ snapshots: [s] });
    expect(p.forget).toEqual([]);
    expect(p.keep).toEqual([s.id]);
  });

  it('forgets an unreferenced snapshot once it is older than the cutoff', () => {
    const s = snap({ id: id(6), time: OLD });
    expect(plan({ snapshots: [s] }).forget).toEqual([s.id]);
  });

  it('treats an unparseable timestamp as too young to judge rather than deleting', () => {
    const s = snap({ id: id(7), time: 'not-a-date' });
    const p = plan({ snapshots: [s] });
    expect(p.forget).toEqual([]);
  });
});

describe('planRepoReclamation — G2 no-db-history', () => {
  it('skips a repo that holds snapshots while the DB remembers no bundles at all', () => {
    // This is the platform-DB-loss signature. Without the guard, an empty
    // keep-set would delete every tenant's backups on the next tick.
    const p = plan({
      snapshots: [snap({ id: id(1), time: OLD }), snap({ id: id(2), time: OLD })],
      hasHistory: false,
    });
    expect(p.skip).toBe('no-db-history');
    expect(p.forget).toEqual([]);
    expect(p.keep).toHaveLength(2);
  });

  it('still reclaims when the DB remembers the bundles but all of them expired', () => {
    // A legitimately aged-out tenant keeps its EXPIRED backup_jobs rows, which
    // is exactly what distinguishes it from DB loss.
    const p = plan({ snapshots: [snap({ id: id(3), time: OLD })], hasHistory: true });
    expect(p.skip).toBeNull();
    expect(p.forget).toEqual([id(3)]);
  });

  it('honours the operator force override', () => {
    const p = plan({ snapshots: [snap({ id: id(4), time: OLD })], hasHistory: false, force: true });
    expect(p.forget).toEqual([id(4)]);
  });

  it('does not trip on an empty repo', () => {
    const p = plan({ snapshots: [], hasHistory: false });
    expect(p.skip).toBe('nothing-to-forget');
    expect(p.forget).toEqual([]);
  });
});

describe('planRepoReclamation — mixed repo', () => {
  it('partitions a realistic repo correctly', () => {
    const live = snap({ id: id(1), time: OLD });
    const tagged = snap({ id: id(2), time: OLD, tags: ['bundle-id=b-live'] });
    const fresh = snap({ id: id(3), time: FRESH });
    const expired = snap({ id: id(4), time: OLD, tags: ['bundle-id=b-gone'] });
    const orphan = snap({ id: id(5), time: OLD }); // hard-deleted bundle row
    const p = plan({
      snapshots: [live, tagged, fresh, expired, orphan],
      keepSnapshotIds: new Set([live.id]),
      keepBundleIds: new Set(['b-live']),
    });
    expect([...p.forget].sort()).toEqual([expired.id, orphan.id].sort());
    expect(p.keep).toHaveLength(3);
  });
});

// ── Driver argv ────────────────────────────────────────────────────────────

const TARGET: BackupTarget = {
  kind: 'shim',
  endpoint: 'http://shim.platform.svc:9000',
  bucket: 'tenant',
  accessKey: 'ak',
  secretKey: 'sk',
};
const PW = 'a'.repeat(64);
const REPO = 's3:http://shim.platform.svc:9000/tenant/restic-files/t1';

function stubSpawn(exitCode = 0): { calls: string[][] } {
  const calls: string[][] = [];
  __setResticSpawnForTest((_bin, args) => {
    calls.push([...args]);
    const child = {
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      stdin: { write: () => true, end: () => {}, on: () => {} },
      on(evt: 'exit' | 'close', cb: (c: number | null) => void) {
        if (evt === 'exit') setImmediate(() => cb(exitCode));
        return this;
      },
      kill: () => {},
    };
    return child as never;
  });
  return { calls };
}

afterEach(() => __resetResticSpawnForTest());

describe('nothingLeftToReclaim — when a deleted tenant can leave the sweep', () => {
  it.each<[string, Parameters<typeof nothingLeftToReclaim>[0]]>([
    ['no repository in either layout', ['missing', 'missing']],
    ['one missing, the other emptied — an emptied repository stays on the target', ['missing', 'empty']],
    ['a single emptied repository', ['empty']],
  ])('nothing is left with %s', (_what, seen) => {
    expect(nothingLeftToReclaim(seen)).toBe(true);
  });

  it.each<[string, Parameters<typeof nothingLeftToReclaim>[0]]>([
    ['a repository that still holds snapshots', ['missing', 'holds-snapshots']],
    ['a repository that could not be looked at', ['missing', 'not-looked-at']],
    ['an emptied one beside one that could not be looked at', ['empty', 'not-looked-at']],
    ['no repository looked at at all', []],
  ])('something may be left with %s', (_what, seen) => {
    expect(nothingLeftToReclaim(seen)).toBe(false);
  });
});

describe('pruneRepositories — every repository a row\'s forgotten snapshots can be in', () => {
  const MERGED = 's3:http://shim.example.test/tenant/restic/t1';
  const SPLIT = 's3:http://shim.example.test/tenant/restic-files/t1';
  const ABSENT = new Error('restic prune exited 10: Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.');
  const DOWN = new Error('restic prune exited 1: Fatal: unable to open config file: Stat: Get "http://shim.example.test/tenant/restic/t1/config": dial tcp 10.0.0.9:9000: connect: connection refused');
  const LOCKED = new Error('restic prune exited 11: unable to create lock in backend: repository is already locked');

  /** A stand-in target: what each repository's prune does, and which were asked for. */
  const run = (does: Record<string, Error | null>, outcomes = new Map<string, PruneOutcome>(), repoUris = [SPLIT, MERGED]) => {
    const asked: string[] = [];
    const done = pruneRepositories({
      repoUris, outcomes,
      prune: async (repoUri) => { asked.push(repoUri); const err = does[repoUri]; if (err) throw err; },
    });
    return { asked, done, outcomes };
  };

  it('prunes both layouts', async () => {
    const r = run({ [SPLIT]: null, [MERGED]: null });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.asked).toEqual([SPLIT, MERGED]);
  });

  it('a repository that is not there has nothing to prune: the other is pruned, and the row is done', async () => {
    const r = run({ [SPLIT]: ABSENT, [MERGED]: null });
    await expect(r.done).resolves.toBeUndefined();
    expect(r.asked).toEqual([SPLIT, MERGED]);
  });

  it('neither repository there: done, nothing to free', async () => {
    await expect(run({ [SPLIT]: ABSENT, [MERGED]: ABSENT }).done).resolves.toBeUndefined();
  });

  it('a target that cannot be reached is NOT a repository that is not there: the row fails and stays pending', async () => {
    const r = run({ [SPLIT]: DOWN, [MERGED]: DOWN });
    await expect(r.done).rejects.toBe(DOWN);
    expect(r.asked).toEqual([SPLIT, MERGED]);
  });

  it('one repository failing does not keep the other from being pruned — and the row still fails', async () => {
    const r = run({ [SPLIT]: LOCKED, [MERGED]: null });
    await expect(r.done).rejects.toBe(LOCKED);
    expect(r.asked).toEqual([SPLIT, MERGED]);
  });

  it('a repository already pruned in this pass is not pruned a second time for the tenant\'s other row', async () => {
    const first = run({ [SPLIT]: ABSENT, [MERGED]: null });
    await first.done;
    const OTHER_SPLIT = 's3:http://shim.example.test/tenant/restic-mailboxes/t1';
    const second = run({ [OTHER_SPLIT]: ABSENT, [MERGED]: null }, first.outcomes, [OTHER_SPLIT, MERGED]);
    await expect(second.done).resolves.toBeUndefined();
    expect(second.asked).toEqual([OTHER_SPLIT]);
  });

  it('…and one that FAILED the first time fails the second row too: it must not read pruned', async () => {
    const first = run({ [SPLIT]: ABSENT, [MERGED]: LOCKED });
    await expect(first.done).rejects.toBe(LOCKED);
    const OTHER_SPLIT = 's3:http://shim.example.test/tenant/restic-mailboxes/t1';
    const second = run({ [OTHER_SPLIT]: ABSENT, [MERGED]: null }, first.outcomes, [OTHER_SPLIT, MERGED]);
    await expect(second.done).rejects.toBe(LOCKED);
    expect(second.asked).toEqual([OTHER_SPLIT]);                     // the merged one is not tried again in this pass
  });
});

describe('runResticForget', () => {
  it('passes --repo and every snapshot id to `forget`, without --no-lock', async () => {
    const { calls } = stubSpawn();
    await runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [id(1), id(2)] });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv).toContain('--repo');
    expect(argv[argv.indexOf('--repo') + 1]).toBe(REPO);
    expect(argv).toContain('forget');
    expect(argv).toContain(id(1));
    expect(argv).toContain(id(2));
    // forget mutates the repo: it must take the lock.
    expect(argv).not.toContain('--no-lock');
  });

  it('is a no-op that spawns nothing when given no ids', async () => {
    const { calls } = stubSpawn();
    await runResticForget({ target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [] });
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed snapshot id before it can reach argv', async () => {
    const { calls } = stubSpawn();
    await expect(runResticForget({
      target: TARGET, passwordHex: PW, repoUri: REPO,
      snapshotIds: ['--repo=/etc/passwd'],
    })).rejects.toThrow(/invalid snapshot id/);
    expect(calls).toHaveLength(0);
  });

  it('rejects the whole batch if any id is malformed', async () => {
    const { calls } = stubSpawn();
    await expect(runResticForget({
      target: TARGET, passwordHex: PW, repoUri: REPO,
      snapshotIds: [id(1), 'zzzz'],
    })).rejects.toThrow(/invalid snapshot id/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-zero restic exit', async () => {
    stubSpawn(1);
    await expect(runResticForget({
      target: TARGET, passwordHex: PW, repoUri: REPO, snapshotIds: [id(1)],
    })).rejects.toThrow(/restic forget exited 1/);
  });
});

describe('runResticPrune', () => {
  it('runs prune against the repo', async () => {
    const { calls } = stubSpawn();
    await runResticPrune({ target: TARGET, passwordHex: PW, repoUri: REPO });
    const argv = calls[0]!;
    expect(argv).toContain('prune');
    expect(argv[argv.indexOf('--repo') + 1]).toBe(REPO);
    expect(argv).not.toContain('--max-repack-size');
  });

  it('bounds repack work when maxRepackSize is set', async () => {
    const { calls } = stubSpawn();
    await runResticPrune({ target: TARGET, passwordHex: PW, repoUri: REPO, maxRepackSize: '4G' });
    const argv = calls[0]!;
    expect(argv[argv.indexOf('--max-repack-size') + 1]).toBe('4G');
  });

  it('rejects a malformed maxRepackSize instead of passing it through', async () => {
    const { calls } = stubSpawn();
    await expect(runResticPrune({
      target: TARGET, passwordHex: PW, repoUri: REPO, maxRepackSize: '4G; rm -rf /',
    })).rejects.toThrow(/invalid maxRepackSize/);
    expect(calls).toHaveLength(0);
  });

  it('waits out a live lock when retryLock is set, and only then', async () => {
    const { calls } = stubSpawn();
    await runResticPrune({ target: TARGET, passwordHex: PW, repoUri: REPO, retryLock: '5m' });
    await runResticPrune({ target: TARGET, passwordHex: PW, repoUri: REPO });
    expect(calls[0]![calls[0]!.indexOf('--retry-lock') + 1]).toBe('5m');
    expect(calls[1]).not.toContain('--retry-lock');
  });

  it('rejects a malformed retryLock instead of passing it through', async () => {
    const { calls } = stubSpawn();
    await expect(runResticPrune({
      target: TARGET, passwordHex: PW, repoUri: REPO, retryLock: '5m --no-lock',
    })).rejects.toThrow(/invalid retryLock/);
    expect(calls).toHaveLength(0);
  });
});
