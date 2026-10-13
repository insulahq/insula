import { describe, expect, it } from 'vitest';
import { observeTenantPlacement } from './compute.js';
import { failoverMessage, misplacedMessage, type NamedFailover, type NamedPlacement } from './messages.js';

const failover = (over: Partial<NamedFailover> = {}): NamedFailover => ({
  id: 'f1', tenantId: 't1', tenantName: 'Acme School', primaryNode: 'node-a',
  volumeName: 'pvc-1', pvcName: 'tenant-acme-storage',
  remountRequestedAt: new Date('2026-10-02T05:09:29Z'),
  nodesBefore: ['node-a'], nodesAfter: ['node-b'], detectedAt: new Date('2026-10-02T05:10:30Z'),
  ...over,
});

const placement = (over: Partial<NamedPlacement> = {}): NamedPlacement => ({
  tenantId: 't1', tenantName: 'Acme School', status: 'misplaced', primaryNode: 'node-a',
  storageTier: 'local', workloadNodes: ['node-b'], attachedNodes: ['node-b'], dataNodes: ['node-b'],
  actualNodes: ['node-b'], reasons: ['running on node-b', 'data on node-b'],
  misplacedSince: new Date('2026-10-02T05:10:30Z'), notifiedAt: null,
  checkedAt: new Date('2026-10-02T05:16:00Z'), ...over,
});

describe('failoverMessage', () => {
  it('names the tenant, the volume, the time and the move off the primary node', () => {
    const m = failoverMessage([failover()]);
    expect(m.summary).toBe('Acme School');
    expect(m.details).toEqual(['Acme School: volume tenant-acme-storage salvaged at 2026-10-02 05:09 UTC; '
      + 'was on node-a, now on node-b — no longer on its primary node node-a.']);
  });

  it('points at the node when every salvaged volume was on the same one', () => {
    const m = failoverMessage([failover(), failover({ id: 'f2', tenantId: 't2', tenantName: 'Bright Academy', nodesAfter: [] })]);
    expect(m.summary).toBe('2 tenants');
    // One list item per tenant — never run together into a paragraph.
    expect(m.details).toHaveLength(2);
    expect(m.details[1]).toContain('now on nowhere yet (restarting).');
    expect(m.guidance).toMatch(/^Every salvaged volume was on the same node/);
  });

  it('caps a long list instead of writing one line per tenant forever', () => {
    const many = Array.from({ length: 13 }, (_, i) => failover({ id: `f${i}`, tenantId: `t${i}`, tenantName: `T${i}` }));
    const m = failoverMessage(many);
    expect(m.summary).toBe('13 tenants');
    expect(m.details).toHaveLength(11);
    expect(m.details[10]).toBe('…and 3 more.');
  });
});

describe('misplacedMessage', () => {
  it('says where the tenant should be, where it is, and since when', () => {
    const m = misplacedMessage([placement()]);
    expect(m.details).toEqual(['Acme School: primary node node-a, but running on node-b, data on node-b (seen since 2026-10-02 05:10 UTC).']);
    expect(m.guidance).toContain('Placement card');
    // Nothing is stuck here: no talk of a copy Longhorn cannot make.
    expect(m.guidance).not.toContain('cannot copy');
  });

  it('carries Longhorn\'s reason for a blocked copy, and says it will not resolve by waiting', () => {
    const m = misplacedMessage([
      placement({ primaryNode: 'node-b', reasons: ['data on node-a; Longhorn cannot copy it to node-b: insufficient storage'] }),
      placement({ tenantId: 't2', tenantName: 'Bright Academy' }),
    ]);
    expect(m.details[0]).toBe('Acme School: primary node node-b, but data on node-a; Longhorn cannot copy it to node-b: '
      + 'insufficient storage (seen since 2026-10-02 05:10 UTC).');
    expect(m.guidance).toContain('Where Longhorn cannot copy the data it stays put');
    expect(m.guidance).toContain('reserves the volume\'s full size');
    expect(m.guidance).toContain('shrink the volume');
  });

  it('recognises a blocked copy by the wording the placement check writes', () => {
    // The stored reason is plain text; the two modules must not drift apart.
    const reason = observeTenantPlacement(
      { id: 't1', name: 'Acme', namespace: 'tenant-acme', storageTier: 'local', pinnedNode: 'node-b', status: 'active', hasMailboxes: false },
      {
        pods: [],
        volumes: [{
          volumeName: 'pvc-1', namespace: 'tenant-acme', pvcName: 'tenant-acme-storage', robustness: 'healthy', attached: true,
          pvcRefLostAt: null, attachedNode: 'node-b', remountRequestedAt: null, scheduleFailure: 'insufficient storage',
        }],
        replicas: [{ volumeName: 'pvc-1', nodeId: 'node-a', running: true, failed: false }],
      },
    ).reasons;
    expect(misplacedMessage([placement({ reasons: [...reason] })]).guidance).toContain('Where Longhorn cannot copy the data');
  });
});
