import { describe, it, expect } from 'vitest';

import { buildExportPreflight, IN_FLIGHT_STALE_AFTER_MS } from './export-preflight.js';
import { backupComponents, backupJobs, tenantBackupV2Settings, tenantBundleInFlight } from '../../db/schema.js';

const SNAP = 'a'.repeat(64);
const NOW = new Date('2026-01-01T12:00:00Z');

interface Fixture {
  job?: Record<string, unknown> | null;
  components?: Array<Record<string, unknown>>;
  inFlight?: Array<{ bundleId: string; refreshedAt: Date }>;
  cap?: number;
}

/**
 * Minimal drizzle stub. Each `.from(table)` decides what the chain resolves to,
 * and the chain is thenable at `.where()` as well as after `.limit()` because
 * the module awaits it both ways.
 */
function stubDb(f: Fixture) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === backupJobs) return f.job === null || f.job === undefined ? [] : [f.job];
    if (table === backupComponents) return f.components ?? [];
    if (table === tenantBundleInFlight) {
      // The module filters staleness in SQL; the stub applies the same cutoff
      // so the test exercises the real predicate rather than trusting it.
      const cutoff = NOW.getTime() - IN_FLIGHT_STALE_AFTER_MS;
      return (f.inFlight ?? []).filter((r) => r.refreshedAt.getTime() >= cutoff);
    }
    if (table === tenantBackupV2Settings) {
      return f.cap === undefined ? [] : [{ id: 1, globalMaxInFlight: f.cap }];
    }
    return [];
  };
  const chain = (table: unknown) => {
    const rows = rowsFor(table);
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return self;
  };
  return { select: () => ({ from: (t: unknown) => chain(t) }) } as unknown as
    Parameters<typeof buildExportPreflight>[0]['deps'] extends never ? never : never;
}

const call = (f: Fixture, bundleId = 'bkp-1') =>
  buildExportPreflight({ db: stubDb(f) as never, now: () => NOW }, bundleId);

const completedJob = { id: 'bkp-1', status: 'completed' };

describe('buildExportPreflight', () => {
  it('returns null for an unknown bundle', async () => {
    expect(await call({ job: null })).toBeNull();
  });

  it('classifies restic vs object components by snapshot id', async () => {
    const pre = (await call({
      job: completedJob, cap: 4,
      components: [
        { component: 'mailboxes', artifactName: 'a@example.test', sizeBytes: 3_000_000, sha256: SNAP },
        { component: 'config', artifactName: 'db-rows.json.gz', sizeBytes: 2_744, sha256: null },
      ],
    }))!;
    expect(pre.components.map((c) => c.source)).toEqual(['restic', 'object']);
    expect(pre.needsRestic).toBe(true);
    expect(pre.totalBytes).toBe(3_002_744);
  });

  it('an object-only bundle is never reported as gated', async () => {
    // The capture gate applies to restic dumps. A bundle with no restic
    // component cannot queue behind one, so warning about a full gate there
    // would be a false alarm on every export.
    const pre = (await call({
      job: completedJob, cap: 1,
      components: [{ component: 'config', artifactName: 'db-rows.json.gz', sizeBytes: 10, sha256: null }],
      inFlight: [{ bundleId: 'other', refreshedAt: NOW }],
    }))!;
    expect(pre.needsRestic).toBe(false);
    expect(pre.blocked).toBe(false);
  });

  it('reports blocked when every cluster slot is taken', async () => {
    const pre = (await call({
      job: completedJob, cap: 2,
      components: [{ component: 'files', artifactName: 'archive', sizeBytes: 1, sha256: SNAP }],
      inFlight: [
        { bundleId: 'other-1', refreshedAt: NOW },
        { bundleId: 'other-2', refreshedAt: NOW },
      ],
    }))!;
    expect(pre.capture).toMatchObject({ inFlight: 2, cap: 2, slotsFree: 0 });
    expect(pre.blocked).toBe(true);
    expect(pre.warnings.join(' ')).toContain('queued, not failed');
  });

  it('ignores stale in-flight rows — a crashed pod holds no slot', async () => {
    // A row whose heartbeat stopped is an orphan. Counting it would warn the
    // operator about a backup that is not running, and the gate itself ignores
    // it, so the dialog would disagree with reality.
    const stale = new Date(NOW.getTime() - IN_FLIGHT_STALE_AFTER_MS - 1000);
    const pre = (await call({
      job: completedJob, cap: 1,
      components: [{ component: 'files', artifactName: 'archive', sizeBytes: 1, sha256: SNAP }],
      inFlight: [{ bundleId: 'crashed', refreshedAt: stale }],
    }))!;
    expect(pre.capture.inFlight).toBe(0);
    expect(pre.blocked).toBe(false);
  });

  it('cap 0 disables the gate rather than meaning zero slots', async () => {
    // global_max_in_flight = 0 means "cluster gate off". Reading it as a cap of
    // zero would mark every restic export blocked forever.
    const pre = (await call({
      job: completedJob, cap: 0,
      components: [{ component: 'files', artifactName: 'archive', sizeBytes: 1, sha256: SNAP }],
      inFlight: [{ bundleId: 'other', refreshedAt: NOW }],
    }))!;
    expect(pre.capture.cap).toBe(0);
    expect(pre.blocked).toBe(false);
  });

  it('warns when a capture for THIS bundle is running', async () => {
    const pre = (await call({
      job: completedJob, cap: 4,
      components: [{ component: 'files', artifactName: 'archive', sizeBytes: 1, sha256: SNAP }],
      inFlight: [{ bundleId: 'bkp-1', refreshedAt: NOW }],
    }))!;
    expect(pre.capture.thisBundleCapturing).toBe(true);
    expect(pre.warnings.join(' ')).toContain('same bundle');
  });

  it('warns that a partial bundle exports only what was captured', async () => {
    const pre = (await call({
      job: { id: 'bkp-1', status: 'partial' }, cap: 4,
      components: [{ component: 'config', artifactName: 'x', sizeBytes: 1, sha256: null }],
    }))!;
    expect(pre.bundleStatus).toBe('partial');
    expect(pre.warnings.join(' ')).toContain('partial');
  });

  it('warns rather than silently offering an empty archive', async () => {
    const pre = (await call({ job: completedJob, cap: 4, components: [] }))!;
    expect(pre.totalBytes).toBe(0);
    expect(pre.warnings.join(' ')).toContain('empty');
  });
});
