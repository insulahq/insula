/**
 * Every writer of `repo_total_bytes` must also set its provenance.
 *
 * Found on DEV: the operator's **Refresh repo size** button produced an exact
 * `restic stats` figure and left the row saying `tracked`, dated to the last
 * backup rather than to the measurement — the button understating its own
 * result. The column gained a label and an "as of" and this writer was not
 * updated with them.
 *
 * The fix routes refreshRepoStats through anchorResticRepoTotal so there is
 * one writer for "this is a real measurement". What the test below pins is
 * that writer's contract — all four columns, together. That the Refresh
 * button reaches it is a wiring question this test does not answer; it was
 * confirmed by pressing Refresh on DEV and reading the row back.
 */
import { describe, it, expect, vi } from 'vitest';
import { anchorResticRepoTotal } from './repo-state.js';
import type { Database } from '../../db/index.js';

describe('anchorResticRepoTotal', () => {
  it('writes the size, the provenance and BOTH timestamps together', async () => {
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const db = { update: vi.fn(() => ({ set })) } as unknown as Database;
    const measuredAt = new Date('2026-09-20T10:15:13.000Z');

    await anchorResticRepoTotal({
      db, tenantId: 't1', component: 'files', totalBytes: 3030312, measuredAt,
    });

    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0] as Record<string, unknown>;
    expect(written).toEqual({
      repoTotalBytes: 3030312,
      // A measurement is authoritative: it is what `repo_stats_at` means.
      repoStatsAt: measuredAt,
      // And it is also the moment the total last changed.
      repoTotalAt: measuredAt,
      // Not 'tracked' — this figure came straight from the repository.
      repoTotalSource: 'measured',
    });
  });
});
