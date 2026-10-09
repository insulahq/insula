import { describe, it, expect } from 'vitest';
import type { HostMigrationNodeStatus, ReleaseContents } from '@insula/api-contracts';
import { computeUpgradeChanges } from './release-changes.js';

const contents: ReleaseContents = {
  hostMigrations: [
    { key: '2026.10.6/0001-old.sh', phase: 'before-services', description: 'Old change everyone has.' },
    { key: '2026.10.7/0001-a.sh', phase: 'before-services', description: 'Moves the firewall config.' },
    { key: '2026.10.7/0002-b.sh', phase: 'after-services', description: 'Needs the new services.' },
  ],
  migrations: { sql: ['0153_a.sql', '0154_b.sql'], platform: ['0009_x', '0010_y'] },
};

const node = (name: string, items: HostMigrationNodeStatus['items'], collectedAt: string | null = '2026-10-09T10:00:00Z') => ({
  node: name, collectedAt, mode: 'enforce', source: 'configmap', ok: true,
  appliedCount: 0, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0, invalidCount: 0, items,
} as HostMigrationNodeStatus);

const input = (over: Partial<Parameters<typeof computeUpgradeChanges>[0]> = {}) => ({
  fromVersion: '2026.10.6', toVersion: '2026.10.7', contents,
  sqlApplied: new Set(['0153_a.sql']), platformApplied: new Set(['0009_x']),
  nodes: [
    node('sv1', [{ key: '2026.10.6/0001-old.sh', state: 'applied' }, { key: '2026.10.7/0001-a.sh', state: 'applied' }]),
    node('sv2', [{ key: '2026.10.6/0001-old.sh', state: 'already-applied' }]),
  ],
  ...over,
});

describe('computeUpgradeChanges', () => {
  it('counts the migrations the cluster has not run', () => {
    const r = computeUpgradeChanges(input());
    expect(r.known).toBe(true);
    expect(r.databaseMigrations).toBe(1);
    expect(r.platformMigrations).toBe(1);
  });

  it('lists each host change with the nodes it still has to run on — a script a node does not list is still to run', () => {
    const r = computeUpgradeChanges(input());
    expect(r.hostChanges).toEqual([
      { key: '2026.10.7/0001-a.sh', phase: 'before-services', description: 'Moves the firewall config.', nodes: ['sv2'] },
      { key: '2026.10.7/0002-b.sh', phase: 'after-services', description: 'Needs the new services.', nodes: ['sv1', 'sv2'] },
    ]);
  });

  it('a failed or deferred script is still to run; a skipped one is done', () => {
    const r = computeUpgradeChanges(input({ nodes: [node('sv1', [
      { key: '2026.10.6/0001-old.sh', state: 'skipped' },
      { key: '2026.10.7/0001-a.sh', state: 'run-failed' },
      { key: '2026.10.7/0002-b.sh', state: 'deferred' },
    ])] }));
    expect(r.hostChanges.map((c) => c.key)).toEqual(['2026.10.7/0001-a.sh', '2026.10.7/0002-b.sh']);
  });

  it('a node with no report is listed apart, never as "nothing to do"', () => {
    const r = computeUpgradeChanges(input({ nodes: [node('sv3', [], null)] }));
    expect(r.unreportedNodes).toEqual(['sv3']);
    expect(r.hostChanges).toEqual([]);
  });

  it('a release whose manifest carries no contents says so instead of reporting zero', () => {
    const r = computeUpgradeChanges(input({ contents: null }));
    expect(r.known).toBe(false);
    expect(r.hostChanges).toEqual([]);
  });

  it('offers the Kubernetes step from the release\'s k3s pin and the lowest kubelet', () => {
    const r = computeUpgradeChanges(input({ contents: { ...contents, k3sVersion: 'v1.36.5+k3s1' }, kubelet: 'v1.36.2+k3s1' }));
    expect(r.kubernetes).toEqual({ current: 'v1.36.2+k3s1', target: 'v1.36.5+k3s1', offer: true, reason: null });
    const none = computeUpgradeChanges(input({ kubelet: 'v1.36.2+k3s1' }));
    expect(none.kubernetes).toEqual({ current: 'v1.36.2+k3s1', target: null, offer: false, reason: null });
  });
});

