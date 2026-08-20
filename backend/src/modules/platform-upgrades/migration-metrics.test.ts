import { describe, it, expect, beforeEach } from 'vitest';
import { platformMigrationFailed, platformMigrationsPending } from '../../shared/metrics.js';
import { publishMigrationMetrics } from './index.js';
import type { RunMigrationsResult } from './registry/types.js';

/**
 * These gauges back the platform-migration SLO rules. Before they existed a
 * halted registry was one warn line in a pod log: migration 0009 403'd on DEV,
 * then STAGING, then production, and every tier rolled it out silently. It
 * surfaced days later as a wildcard certificate stuck "Issuing" because the
 * ClusterIssuer it referenced had never been created.
 */
const FAILED_ID = '0009_seed_wildcard_dns01_issuers';

function result(over: Partial<RunMigrationsResult> = {}): RunMigrationsResult {
  return { ran: true, dryRun: false, applied: 0, pending: 0, failed: false, outcomes: [], ...over };
}

async function gaugeValue(g: typeof platformMigrationsPending, labels?: Record<string, string>) {
  const { values } = await g.get();
  return values.find((v) =>
    !labels || Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val),
  )?.value;
}

describe('publishMigrationMetrics', () => {
  beforeEach(() => {
    platformMigrationFailed.reset();
    platformMigrationsPending.reset();
  });

  it('names the migration that failed — the incident in one assertion', async () => {
    publishMigrationMetrics(result({
      failed: true,
      pending: 1,
      outcomes: [{ id: FAILED_ID, status: 'failed', durationMs: 12, error: 'HTTP-Code: 403' }],
    }));
    expect(await gaugeValue(platformMigrationFailed, { id: FAILED_ID })).toBe(1);
    // …and the registry is still unconverged, which is the other half.
    expect(await gaugeValue(platformMigrationsPending)).toBe(1);
  });

  it('clears the failure once the migration applies, so the alert resolves', async () => {
    publishMigrationMetrics(result({
      failed: true, pending: 1,
      outcomes: [{ id: FAILED_ID, status: 'failed', durationMs: 1, error: 'boom' }],
    }));
    expect(await gaugeValue(platformMigrationFailed, { id: FAILED_ID })).toBe(1);

    publishMigrationMetrics(result({
      applied: 1, pending: 1,
      outcomes: [{ id: FAILED_ID, status: 'applied', durationMs: 5 }],
    }));
    expect(await gaugeValue(platformMigrationFailed, { id: FAILED_ID })).toBeUndefined();
    expect(await gaugeValue(platformMigrationsPending)).toBe(0);
  });

  it('reports 0 pending on a converged cluster', async () => {
    publishMigrationMetrics(result({ applied: 0, pending: 0 }));
    expect(await gaugeValue(platformMigrationsPending)).toBe(0);
  });

  it('subtracts what applied this pass from the starting pending count', async () => {
    publishMigrationMetrics(result({
      applied: 2, pending: 3,
      outcomes: [{ id: 'a', status: 'applied', durationMs: 1 }, { id: 'b', status: 'applied', durationMs: 1 }],
    }));
    expect(await gaugeValue(platformMigrationsPending)).toBe(1);
  });

  it('leaves the gauges ALONE when the pass did not run', async () => {
    // A skipped pass (advisory lock held by a peer, or PLATFORM_SKIP_MIGRATIONS)
    // knows nothing about registry health. Publishing 0 here would let one
    // replica's skip clear a real alert raised by another — a false all-clear,
    // which is the failure mode this whole change exists to remove.
    platformMigrationFailed.set({ id: FAILED_ID }, 1);
    publishMigrationMetrics(result({ ran: false, skippedReason: 'lock-held-by-another-replica' }));
    expect(await gaugeValue(platformMigrationFailed, { id: FAILED_ID })).toBe(1);
  });
});
