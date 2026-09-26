import { describe, it, expect } from 'vitest';
import { classifyFsckOutput } from './fsck.js';

/**
 * Fixtures are the VERBATIM stored output of two real `xfs_repair -n` runs
 * against THE SAME production volume, pulled out of `storage_operations` on
 * a production cluster — not reconstructed. A hand-written fixture would
 * have agreed with whatever the classifier already did; these disagree with the
 * OLD classifier, which is the whole point.
 *
 * A controlled pair, same code, same flags, same device, 50 minutes apart:
 *   DIRTY_LOG_OUTPUT — 21:34:49 UTC. `head block 79392 tail block 79376`
 *                      (unflushed journal) → exit 1, one "finding"
 *                      (`sb_fdblocks` stale) while phases 3/4/6/7 were clean.
 *   CLEAN_OUTPUT     — 22:24 UTC, after a normal mount replayed the log.
 *                      `head block 80208 tail block 80208` → exit 0.
 * The filesystem was healthy in BOTH. Only the journal state differed, and that
 * alone flipped the old verdict to "ERRORS FOUND", which wedged the tenant in
 * storage_lifecycle_state='failed'.
 *
 * Both fixtures contain `- moving disconnected inodes to lost+found ...`, a
 * phase-6 header xfs_repair prints unconditionally. Any damage pattern matching
 * it marks every XFS volume on the fleet corrupt.
 */
const DIRTY_LOG_OUTPUT = "[fsck] fsType=xfs dryRun=true dev=/dev/longhorn/pvc-00000000-1111-2222-3333-444444444444\nPhase 1 - find and verify superblock...\n        - block cache size set to 764408 entries\nPhase 2 - using internal log\n        - zero log...\nzero_log: head block 79392 tail block 79376\nALERT: The filesystem has valuable metadata changes in a log which is being\nignored because the -n option was used.  Expect spurious inconsistencies\nwhich may be resolved by first mounting the filesystem to replay the log.\n        - scan filesystem freespace and inode maps...\nsb_fdblocks 1019986, counted 1052976\n        - found root inode chunk\nPhase 3 - for each AG...\n        - scan (but don't clear) agi unlinked lists...\n        - process known inodes and perform inode discovery...\n        - agno = 0\n        - agno = 1\n        - agno = 2\n        - agno = 3\n        - process newly discovered inodes...\nPhase 4 - check for duplicate blocks...\n        - setting up duplicate extent list...\n        - check for inodes claiming duplicate blocks...\n        - agno = 0\n        - agno = 1\n        - agno = 2\n        - agno = 3\nNo modify flag set, skipping phase 5\nPhase 6 - check inode connectivity...\n        - traversing filesystem ...\n        - agno = 0\n        - agno = 1\n        - agno = 2\n        - agno = 3\n        - traversal finished ...\n        - moving disconnected inodes to lost+found ...\nPhase 7 - verify link counts...\nNo modify flag set, skipping filesystem flush and exiting.\n\n        XFS_REPAIR Summary    Mon Jan  1 21:34:50 2035\n\nPhase\t\tStart\t\tEnd\t\tDuration\nPhase 1:\t01/01 21:34:49\t01/01 21:34:49\t\nPhase 2:\t01/01 21:34:49\t01/01 21:34:49\t\nPhase 3:\t01/01 21:34:49\t01/01 21:34:49\t\nPhase 4:\t01/01 21:34:49\t01/01 21:34:49\t\nPhase 5:\tSkipped\nPhase 6:\t01/01 21:34:49\t01/01 21:34:50\t1 second\nPhase 7:\t01/01 21:34:50\t01/01 21:34:50\t\n\nTotal run time: 1 second\n[fsck] exit=1";

const CLEAN_OUTPUT = "[fsck] fsType=xfs dryRun=true dev=/dev/longhorn/pvc-00000000-1111-2222-3333-444444444444\nPhase 1 - find and verify superblock...\n        - block cache size set to 764408 entries\nPhase 2 - using internal log\n        - zero log...\nzero_log: head block 80208 tail block 80208\n        - scan filesystem freespace and inode maps...\n        - found root inode chunk\nPhase 3 - for each AG...\n        - scan (but don't clear) agi unlinked lists...\n        - process known inodes and perform inode discovery...\n        - agno = 0\n        - agno = 1\n        - agno = 2\n        - agno = 3\n        - process newly discovered inodes...\nPhase 4 - check for duplicate blocks...\n        - setting up duplicate extent list...\n        - check for inodes claiming duplicate blocks...\n        - agno = 0\n        - agno = 1\n        - agno = 3\n        - agno = 2\nNo modify flag set, skipping phase 5\nPhase 6 - check inode connectivity...\n        - traversing filesystem ...\n        - agno = 0\n        - agno = 1\n        - agno = 2\n        - agno = 3\n        - traversal finished ...\n        - moving disconnected inodes to lost+found ...\nPhase 7 - verify link counts...\nNo modify flag set, skipping filesystem flush and exiting.\n\n        XFS_REPAIR Summary    Mon Jan  1 22:24:45 2035\n\nPhase\t\tStart\t\tEnd\t\tDuration\nPhase 1:\t01/01 22:24:44\t01/01 22:24:44\t\nPhase 2:\t01/01 22:24:44\t01/01 22:24:44\t\nPhase 3:\t01/01 22:24:44\t01/01 22:24:45\t1 second\nPhase 4:\t01/01 22:24:45\t01/01 22:24:45\t\nPhase 5:\tSkipped\nPhase 6:\t01/01 22:24:45\t01/01 22:24:45\t\nPhase 7:\t01/01 22:24:45\t01/01 22:24:45\t\n\nTotal run time: 1 second\n[fsck] exit=0";

describe('classifyFsckOutput — real production output', () => {
  it('calls an unreplayed journal INCONCLUSIVE, not damage', () => {
    const r = classifyFsckOutput('xfs', true, 1, DIRTY_LOG_OUTPUT);
    expect(r.verdict).toBe('inconclusive');
    expect(r.logDirty).toBe(true);
    expect(r.clean).toBe(false);
    expect(r.summary).not.toMatch(/ERRORS FOUND/);
    expect(r.summary).toMatch(/INCONCLUSIVE/);
    expect(r.summary).toMatch(/un-replayed/);
  });

  it('calls the post-replay re-check of the same volume CLEAN', () => {
    const r = classifyFsckOutput('xfs', true, 0, CLEAN_OUTPUT);
    expect(r.verdict).toBe('clean');
    expect(r.clean).toBe(true);
    expect(r.logDirty).toBe(false);
  });

  it('does not treat the unconditional phase-6 lost+found header as damage', () => {
    for (const out of [CLEAN_OUTPUT, DIRTY_LOG_OUTPUT]) {
      expect(out).toContain('moving disconnected inodes to lost+found');
    }
    expect(classifyFsckOutput('xfs', true, 0, CLEAN_OUTPUT).verdict).toBe('clean');
  });

  it('derives logDirty from head != tail even without the ALERT text', () => {
    const noAlert = DIRTY_LOG_OUTPUT.replace(
      /ALERT: The filesystem has valuable metadata changes[\s\S]*?replay the log\./,
      '',
    );
    expect(noAlert).not.toMatch(/valuable metadata changes/);
    const r = classifyFsckOutput('xfs', true, 1, noAlert);
    expect(r.logDirty).toBe(true);
    expect(r.verdict).toBe('inconclusive');
  });
});

describe('classifyFsckOutput — damage is still reported', () => {
  it('flags a numbered disconnected inode as errors', () => {
    const damaged = `${CLEAN_OUTPUT}\ndisconnected inode 131, moving to lost+found`;
    const r = classifyFsckOutput('xfs', true, 1, damaged);
    expect(r.verdict).toBe('errors');
    expect(r.clean).toBe(false);
  });

  it('flags corruption even on exit 0', () => {
    const r = classifyFsckOutput('xfs', true, 0, `${CLEAN_OUTPUT}\nbad magic number`);
    expect(r.verdict).toBe('errors');
  });

  it('flags "would have cleared" as damage', () => {
    const r = classifyFsckOutput('xfs', true, 1, `${CLEAN_OUTPUT}\nwould have cleared inode 99`);
    expect(r.verdict).toBe('errors');
  });

  it('treats an operational failure (device missing) as errors, not inconclusive', () => {
    const r = classifyFsckOutput('xfs', true, 65, '[fsck] block device /dev/longhorn/x not found on this node');
    expect(r.verdict).toBe('errors');
    expect(r.logDirty).toBe(false);
  });

  it('a dirty log does NOT mask real damage found alongside it', () => {
    const r = classifyFsckOutput('xfs', true, 1, `${DIRTY_LOG_OUTPUT}\nbad directory block`);
    expect(r.verdict).toBe('errors');
  });
});

describe('classifyFsckOutput — e2fsck exit codes are not xfs exit codes', () => {
  it('e2fsck repair exit 1 = errors CORRECTED = clean', () => {
    const r = classifyFsckOutput('ext4', false, 1, 'Pass 1: Checking inodes\nFILESYSTEM WAS MODIFIED');
    expect(r.verdict).toBe('clean');
  });

  it('e2fsck dry-run exit 4 = errors left uncorrected = errors', () => {
    const r = classifyFsckOutput('ext4', true, 4, 'Pass 1: Checking inodes, blocks, and sizes');
    expect(r.verdict).toBe('errors');
  });

  it('e2fsck reporting a bad inode is damage', () => {
    const r = classifyFsckOutput('ext4', true, 4, 'Inode 12 is a bad type. Clear? no');
    expect(r.verdict).toBe('errors');
  });
});

// ── xfs REPAIR mode ─────────────────────────────────────────────────────
//
// The exit-code scales are tool-specific and must not be shared. An earlier
// revision let xfs repair-mode fall through to the e2fsck rule (exit 1-2 =
// "errors corrected" = clean), so a repair xfs_repair itself said had not
// finished was reported to the operator as a healthy filesystem — and the op was
// marked succeeded. Every fixture here is `isXfs && !dryRun`, which had no
// coverage at all.
describe('classifyFsckOutput — xfs repair mode does not borrow e2fsck exit codes', () => {
  it('exit 0 in repair mode is clean', () => {
    const r = classifyFsckOutput('xfs', false, 0, CLEAN_OUTPUT.replace('dryRun=true', 'dryRun=false'));
    expect(r.verdict).toBe('clean');
    expect(r.clean).toBe(true);
  });

  it('exit 1 in repair mode is NOT clean — xfs_repair did not finish', () => {
    const r = classifyFsckOutput('xfs', false, 1, CLEAN_OUTPUT.replace('dryRun=true', 'dryRun=false'));
    expect(r.verdict).toBe('errors');
    expect(r.clean).toBe(false);
    expect(r.summary).toMatch(/ERRORS FOUND/);
  });

  it('exit 2 in repair mode is NOT clean', () => {
    const r = classifyFsckOutput('xfs', false, 2, CLEAN_OUTPUT.replace('dryRun=true', 'dryRun=false'));
    expect(r.verdict).toBe('errors');
  });

  it('a dirty log in REPAIR mode is not excused — repair mode can replay it', () => {
    // `inconclusive` is a dry-run concession: -n cannot replay a log. A real
    // repair can, so a non-zero exit there is a genuine failure.
    const r = classifyFsckOutput('xfs', false, 1, DIRTY_LOG_OUTPUT.replace('dryRun=true', 'dryRun=false'));
    expect(r.verdict).toBe('errors');
    expect(r.verdict).not.toBe('inconclusive');
  });

  it('repair mode still reports a genuinely repaired filesystem as clean', () => {
    const r = classifyFsckOutput('xfs', false, 0, `${CLEAN_OUTPUT}\ndone`);
    expect(r.verdict).toBe('clean');
  });
});
