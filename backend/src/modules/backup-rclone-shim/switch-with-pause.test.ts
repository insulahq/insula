/**
 * Unit tests for switch-with-pause.ts (Phase 5 — 2026-05-24).
 *
 * Covers previewSwitchEffects exhaustively (pure DB-layer logic). The
 * full switchTargetWithPause path cascades into applyShimAssignmentChange
 * + disableWalArchive — exercised end-to-end by the staging E2E harness
 * because mocking the cascade depth is more mock than test.
 *
 * Mock strategy: each test pre-declares an ORDERED queue of return
 * values. The faked `select()` chain pops the head of the queue per
 * call, so tests only seed the queries they expect to fire.
 *   - schedule query (returned from .where(), no .limit)
 *   - wal state query (returned from .where().limit(1))
 *   - wal target name query (returned from .where().limit(1))
 *   - new target query (returned from .where().limit(1))
 */

import { describe, expect, it } from 'vitest';
import { previewSwitchEffects } from './switch-with-pause.js';
import { ApiError } from '../../shared/errors.js';

interface QueuedReturn {
  // If the call shape ends with .where() returning a Promise directly
  // (no .limit()), set `direct: true`. Otherwise the value is returned
  // from .limit(n).
  readonly direct: boolean;
  readonly rows: ReadonlyArray<unknown>;
}

function makeDb(queue: QueuedReturn[]) {
  const select = () => ({
    from: () => ({
      where: () => {
        const next = queue.shift();
        if (!next) throw new Error('mock db: select queue exhausted — test setup missing a fixture');
        if (next.direct) {
          return Promise.resolve([...next.rows]);
        }
        // Match the .where().limit(n) shape used by walRow + target lookups.
        return { limit: async () => [...next.rows] };
      },
    }),
  });
  return { select } as unknown as Parameters<typeof previewSwitchEffects>[0];
}

describe('previewSwitchEffects', () => {
  it('returns empty effects for a tenant class with no enabled schedules + no target switch', async () => {
    const db = makeDb([
      // 1. schedules where in([tenant_bundle]) and enabled=true → empty
      { direct: true, rows: [] },
    ]);
    const r = await previewSwitchEffects(db, 'tenant', null);
    expect(r.schedulesToPause).toEqual([]);
    expect(r.walToDisable).toBeNull();
    expect(r.newTargetName).toBeNull();
  });

  it('includes enabled tenant_bundle schedule when class=tenant', async () => {
    const db = makeDb([
      { direct: true, rows: [{ subsystem: 'tenant_bundle', enabled: true, cronExpression: '0 3 * * *' }] },
    ]);
    const r = await previewSwitchEffects(db, 'tenant', null);
    expect(r.schedulesToPause).toHaveLength(1);
    expect(r.schedulesToPause[0].subsystem).toBe('tenant_bundle');
    expect(r.walToDisable).toBeNull();
  });

  it('surfaces WAL state for system class when WAL is configured', async () => {
    const db = makeDb([
      // 1. schedules
      { direct: true, rows: [{ subsystem: 'system_pitr', enabled: true, cronExpression: '0 3 * * *' }] },
      // 2. wal state row
      { direct: false, rows: [{ clusterNamespace: 'platform', clusterName: 'system-db', targetConfigId: 'tgt-aaa' }] },
      // 3. wal target name lookup
      { direct: false, rows: [{ name: 'cifs-primary' }] },
    ]);
    const r = await previewSwitchEffects(db, 'system', null);
    expect(r.walToDisable).toEqual({
      clusterNamespace: 'platform',
      clusterName: 'system-db',
      currentTargetName: 'cifs-primary',
    });
    expect(r.schedulesToPause.map((s) => s.subsystem)).toContain('system_pitr');
  });

  it('returns walToDisable=null when no WAL state row exists', async () => {
    const db = makeDb([
      // 1. schedules
      { direct: true, rows: [{ subsystem: 'system_pitr', enabled: true, cronExpression: '0 3 * * *' }] },
      // 2. wal state row → empty (no row in systemWalArchiveState)
      { direct: false, rows: [] },
      // (no wal target lookup since walRow was null)
    ]);
    const r = await previewSwitchEffects(db, 'system', null);
    expect(r.walToDisable).toBeNull();
  });

  it('throws TARGET_NOT_FOUND when new target id resolves to no row', async () => {
    const db = makeDb([
      // 1. schedules
      { direct: true, rows: [] },
      // 2. wal state row (system class) → none
      { direct: false, rows: [] },
      // 3. new target lookup → empty
      { direct: false, rows: [] },
    ]);
    await expect(
      previewSwitchEffects(db, 'system', 'tgt-xxx')
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('throws TARGET_DISABLED when the new target exists but enabled=0', async () => {
    const db = makeDb([
      { direct: true, rows: [] },
      { direct: false, rows: [] }, // wal state
      { direct: false, rows: [{ name: 'old-s3', enabled: 0 }] }, // new target
    ]);
    await expect(
      previewSwitchEffects(db, 'system', 'tgt-xxx')
    ).rejects.toMatchObject({ code: 'TARGET_DISABLED' });
  });

  it('surfaces the new target name when supplied + enabled', async () => {
    const db = makeDb([
      // class=tenant: only schedules query + new target query (no wal)
      { direct: true, rows: [] },
      { direct: false, rows: [{ name: 'cifs-secondary', enabled: 1 }] },
    ]);
    const r = await previewSwitchEffects(db, 'tenant', 'tgt-new');
    expect(r.newTargetName).toBe('cifs-secondary');
  });

  it('class=mail looks up the mail schedule subsystem only (no wal)', async () => {
    const db = makeDb([
      { direct: true, rows: [{ subsystem: 'mail', enabled: true, cronExpression: '0 2 * * *' }] },
    ]);
    const r = await previewSwitchEffects(db, 'mail', null);
    expect(r.schedulesToPause.map((s) => s.subsystem)).toEqual(['mail']);
    expect(r.walToDisable).toBeNull();
  });
});
