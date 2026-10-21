/**
 * The mail retention, applied the moment it is saved.
 */
import { describe, it, expect, vi } from 'vitest';
import { TargetFrozenError } from '../backup-config/writable-guard.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import { applyMailRetentionNow, MAIL_SNAPSHOT_TAG, type MailRetentionNowDeps } from './snapshot-forget.js';

const REPO = `s3:${SHIM_S3_ENDPOINT_URL}/mail/mail-snapshots/cid`;
const ENV = { RESTIC_REPOSITORY: REPO, RESTIC_PASSWORD: 'pw', AWS_ACCESS_KEY_ID: 'ak', AWS_SECRET_ACCESS_KEY: 'sk' };

function deps(over: Partial<MailRetentionNowDeps> & { counts?: number[] } = {}) {
  const counts = [...(over.counts ?? [10, 4])];
  const d: MailRetentionNowDeps = {
    loadPolicy: async () => ({ days: 7, count: 48 }),
    findMailTargetId: async () => 'tgt-1',
    requireWritable: async () => undefined,
    readRepoEnv: async () => ENV,
    listSnapshots: vi.fn(async () => Array.from({ length: counts.shift() ?? 0 }, (_, i) => ({ id: `${i}`, shortId: `${i}`, time: '', tags: [] }))),
    forget: vi.fn(async () => undefined),
    pruneNow: vi.fn(async () => ({ outcome: 'pruned' as const, at: 'x', durationMs: 1, error: null })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  return d;
}

describe('applyMailRetentionNow', () => {
  it('forgets with the saved limits — both, as restic passes — then prunes what it forgot', async () => {
    const d = deps();
    const res = await applyMailRetentionNow(d);
    expect(d.forget).toHaveBeenCalledWith(expect.objectContaining({
      repoUri: REPO, keepWithinDays: 7, keepLast: 48, tag: MAIL_SNAPSHOT_TAG,
      target: expect.objectContaining({ kind: 'shim', accessKey: 'ak', secretKey: 'sk' }),
    }));
    expect(d.pruneNow).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ outcome: 'applied', before: 10, after: 4, prune: { outcome: 'pruned' } });
  });

  it('does not prune when nothing was forgotten (a raised limit)', async () => {
    const d = deps({ counts: [10, 10] });
    expect(await applyMailRetentionNow(d)).toMatchObject({ outcome: 'applied', prune: null });
    expect(d.pruneNow).not.toHaveBeenCalled();
  });

  it('never touches a frozen target', async () => {
    const d = deps({ requireWritable: async () => { throw new TargetFrozenError('tgt-1', 'Box'); } });
    expect(await applyMailRetentionNow(d)).toEqual({ outcome: 'skipped', reason: 'frozen' });
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('leaves a repo that is not behind the shim alone', async () => {
    const d = deps({ readRepoEnv: async () => ({ ...ENV, RESTIC_REPOSITORY: 's3:https://example.test/mail' }) });
    expect(await applyMailRetentionNow(d)).toEqual({ outcome: 'skipped', reason: 'unsupported-repo' });
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('needs the full credentials', async () => {
    const d = deps({ readRepoEnv: async () => ({ ...ENV, RESTIC_PASSWORD: '' }) });
    expect(await applyMailRetentionNow(d)).toEqual({ outcome: 'skipped', reason: 'incomplete-credentials' });
  });

  it('does nothing with no mail target bound', async () => {
    const d = deps({ findMailTargetId: async () => null });
    expect(await applyMailRetentionNow(d)).toEqual({ outcome: 'skipped', reason: 'no-target' });
  });
});
