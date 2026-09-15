import { describe, it, expect } from 'vitest';
import { splitLockSection, LOCK_SENTINEL } from './backups.js';

/**
 * `/backups/mail` reported repoReachable=true throughout a total outage.
 *
 * The listing pod runs `restic snapshots --no-lock`, which reads a fully wedged
 * repo happily — so "the list worked" says nothing about whether anything can
 * WRITE. DEV sat locked for 3 days 17 hours with this surface green. The pod now
 * also enumerates locks, and this splits the two halves back apart.
 */

const SNAPS = '[{"id":"aa","short_id":"aa","time":"2026-09-15T12:51:00Z","hostname":"h","tags":[]}]';
const LOCK_A = 'a'.repeat(64);
const LOCK_B = 'b'.repeat(64);

describe('splitLockSection', () => {
  it('separates snapshot JSON from the lock ids and counts them', () => {
    const out = `${SNAPS}\n${LOCK_SENTINEL}\n${LOCK_A}\n${LOCK_B}\n`;
    const { snapshotsRaw, lockCount } = splitLockSection(out);
    expect(JSON.parse(snapshotsRaw.trim())).toHaveLength(1);
    expect(lockCount).toBe(2);
  });

  it('reports 0 when the section is present and empty — the healthy case', () => {
    const { lockCount } = splitLockSection(`${SNAPS}\n${LOCK_SENTINEL}\n`);
    expect(lockCount).toBe(0);
  });

  it('reports null, NOT zero, when the pod never emitted the section', () => {
    // An older tenant-backup-tools image. "We did not look" must not render as
    // "there are none" — that is the same lie this whole change removes.
    const { snapshotsRaw, lockCount } = splitLockSection(SNAPS);
    expect(lockCount).toBeNull();
    expect(snapshotsRaw).toBe(SNAPS);
  });

  it('ignores non-lock-id noise after the sentinel', () => {
    // restic or the shell can print warnings here; they must not inflate the
    // count into a phantom lock that sends an operator chasing nothing.
    const out = [
      SNAPS,
      LOCK_SENTINEL,
      'Warning: repository is in an old format',
      LOCK_A,
      '',
      'some other line',
    ].join('\n');
    expect(splitLockSection(out).lockCount).toBe(1);
  });

  it('leaves the snapshot half byte-identical so the existing parser is unaffected', () => {
    const out = `${SNAPS}\n${LOCK_SENTINEL}\n${LOCK_A}\n`;
    expect(splitLockSection(out).snapshotsRaw).toBe(`${SNAPS}\n`);
  });

  it('handles an empty snapshot list next to live locks', () => {
    // The exact DEV shape: nothing written for days, two locks holding it shut.
    const { snapshotsRaw, lockCount } = splitLockSection(`[]\n${LOCK_SENTINEL}\n${LOCK_A}\n${LOCK_B}\n`);
    expect(JSON.parse(snapshotsRaw.trim())).toHaveLength(0);
    expect(lockCount).toBe(2);
  });
});
