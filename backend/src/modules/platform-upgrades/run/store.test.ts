import { describe, it, expect } from 'vitest';
import type { PlatformUpgradeRunRow } from '../../../db/schema.js';
import { toUpgradeRun } from './store.js';

const row = (over: Partial<PlatformUpgradeRunRow> = {}): PlatformUpgradeRunRow => ({
  id: 'r1', fromVersion: '2026.10.6', toVersion: '2026.10.7', mode: 'manual', status: 'running', step: 'prepare-nodes',
  excludedNodes: ['sv3'], nodes: [{ node: 'sv1', state: 'ready', cliVersion: '2026.10.7', detail: 'ok' }], message: null,
  initiatedBy: null, startedAt: new Date('2026-10-09T10:00:00Z'), stepStartedAt: new Date('2026-10-09T10:05:00Z'), finishedAt: null,
  ...over,
} as PlatformUpgradeRunRow);

describe('toUpgradeRun', () => {
  it('maps a row to the API shape with ISO timestamps', () => {
    expect(toUpgradeRun(row())).toEqual({
      id: 'r1', fromVersion: '2026.10.6', toVersion: '2026.10.7', mode: 'manual', status: 'running', step: 'prepare-nodes',
      excludedNodes: ['sv3'], nodes: [{ node: 'sv1', state: 'ready', cliVersion: '2026.10.7', detail: 'ok' }], message: null,
      startedAt: '2026-10-09T10:00:00.000Z', stepStartedAt: '2026-10-09T10:05:00.000Z', finishedAt: null,
    });
  });

  it('normalises unexpected values instead of passing them through', () => {
    const r = toUpgradeRun(row({ mode: 'weird', status: 'odd', step: 'nope', excludedNodes: null as unknown as string[], nodes: null as unknown as [] }));
    expect(r.mode).toBe('manual');
    expect(r.status).toBe('running');
    expect(r.step).toBe('prepare-nodes');
    expect(r.excludedNodes).toEqual([]);
    expect(r.nodes).toEqual([]);
  });
});
