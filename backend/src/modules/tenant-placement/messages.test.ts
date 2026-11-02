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

  it('carries the cause of a blocked copy on the tenant\'s line, and says it will not resolve by waiting', () => {
    const held = 'the volume is still held to the Longhorn node tagged node-node-a (a pin left by an earlier drain or move), '
      + 'and node-b does not carry that tag — move the tenant again from its Placement card; a move holds the volume to the node it moves to';
    const m = misplacedMessage([
      placement({ primaryNode: 'node-b', reasons: [`data on node-a; Longhorn cannot copy it to node-b: ${held}`] }),
      placement({ tenantId: 't2', tenantName: 'Bright Academy' }),
    ]);
    expect(m.details[0]).toBe(`Acme School: primary node node-b, but data on node-a; Longhorn cannot copy it to node-b: ${held} `
      + '(seen since 2026-10-02 05:10 UTC).');
    expect(m.guidance).toContain('Where Longhorn cannot copy the data, it stays where it is until the cause given for that tenant is dealt with.');
    // One piece of advice for every cause sent the operator looking for room on a node with plenty.
    expect(m.guidance).not.toMatch(/shrink|room for its volume/);
  });

  it('says Auto, not "primary node —", for a tenant on Auto whose pods and data are apart', () => {
    const m = misplacedMessage([placement({ primaryNode: null, reasons: ['running on node-a, data on node-b'] })]);
    expect(m.details[0]).toBe('Acme School: Auto, but running on node-a, data on node-b (seen since 2026-10-02 05:10 UTC).');
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
