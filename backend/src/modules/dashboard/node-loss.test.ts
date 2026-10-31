/**
 * The Failover line's worst case.
 *
 * Operator report: the dashboard said "Worst case is sv4" — the node with the
 * most CPU — while no tenant and no part of mail used sv4, and sv3 held 23
 * tenants and the mail standby.
 */
import { describe, it, expect } from 'vitest';
import { nodeLossOf, worstNodeLoss, type NodeLossFacts } from './node-loss.js';

const ready = (name: string, labels: Record<string, string> = {}, unschedulable = false) => ({
  metadata: { name, labels },
  spec: { unschedulable },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
});

/** Production's shape: sv1 runs mail with 6 tenants, sv3 is the secondary with 23, sv4 is new and the largest. */
function production(over: Partial<NodeLossFacts> = {}): NodeLossFacts {
  return {
    nodes: [
      { name: 'sv1', cpuTotal: 8 },
      { name: 'sv2', cpuTotal: 8 },
      { name: 'sv3', cpuTotal: 8 },
      { name: 'sv4', cpuTotal: 16 },
    ],
    tenantNodes: [
      ...Array.from({ length: 6 }, () => ['sv1']),
      ['sv2'],
      ...Array.from({ length: 23 }, () => ['sv3']),
    ],
    mail: {
      activeNode: 'sv1', secondaryNode: 'sv3', tertiaryNode: null,
      autoFailoverEnabled: true, failoverThresholdSeconds: 300,
    },
    liveNodes: [ready('sv1'), ready('sv2'), ready('sv3', { 'insula.host/mail-standby': 'true' }), ready('sv4')],
    ...over,
  };
}

describe('worstNodeLoss', () => {
  it('names the node most depends on, not the largest', () => {
    expect(worstNodeLoss(production())).toEqual({
      node: 'sv3', tenants: 23, mail: { role: 'secondary', staysDown: false },
    });
  });

  it('counts a tenant once although its workloads and data are on the node twice over', () => {
    const facts = production({ tenantNodes: [['sv2', 'sv2'], ['sv2', 'sv3']] });
    expect(nodeLossOf('sv2', facts).tenants).toBe(2);
    expect(nodeLossOf('sv3', facts).tenants).toBe(1);
  });

  it('says what the mail node and an unused node would take with them', () => {
    expect(nodeLossOf('sv1', production())).toEqual({
      node: 'sv1', tenants: 6, mail: { role: 'active', staysDown: false },
    });
    expect(nodeLossOf('sv4', production())).toEqual({ node: 'sv4', tenants: 0, mail: null });
  });

  it('puts the mail node first when mail could not fail over, whatever the tenant counts', () => {
    const off = production({ mail: { ...production().mail!, autoFailoverEnabled: false } });
    expect(worstNodeLoss(off)).toMatchObject({ node: 'sv1', mail: { role: 'active', staysDown: true } });

    // Automatic failover is on, but the only target is cordoned.
    const cordoned = production({
      liveNodes: [ready('sv1'), ready('sv2'), ready('sv3', { 'insula.host/mail-standby': 'true' }, true), ready('sv4')],
    });
    expect(worstNodeLoss(cordoned)).toMatchObject({ node: 'sv1', mail: { role: 'active', staysDown: true } });
  });

  it('breaks a tie in tenants by the node\'s part in mail, then by CPU', () => {
    const tie = production({ tenantNodes: [['sv1'], ['sv2'], ['sv3'], ['sv4']] });
    expect(worstNodeLoss(tie)?.node).toBe('sv1');

    const noMail = production({ tenantNodes: [['sv1'], ['sv2'], ['sv3'], ['sv4']], mail: null, liveNodes: [] });
    expect(worstNodeLoss(noMail)?.node).toBe('sv4');
  });

  it('says mail stays down when its only target is NotReady, and fails over to a usable tertiary', () => {
    const notReady = { ...ready('sv3'), status: { conditions: [{ type: 'Ready', status: 'False' }] } };
    const down = production({ liveNodes: [ready('sv1'), ready('sv2'), notReady, ready('sv4')] });
    expect(nodeLossOf('sv1', down).mail).toEqual({ role: 'active', staysDown: true });

    const tertiary = production({
      mail: { ...production().mail!, secondaryNode: null, tertiaryNode: 'sv2' },
    });
    expect(nodeLossOf('sv1', tertiary).mail).toEqual({ role: 'active', staysDown: false });
    expect(nodeLossOf('sv2', tertiary).mail).toEqual({ role: 'tertiary', staysDown: false });
  });

  it('marks the primary as a standby while mail runs on its failover node', () => {
    const failedOver = production({
      mail: { ...production().mail!, activeNode: 'sv3' },
      liveNodes: [ready('sv1', { 'insula.host/mail-standby': 'true' }), ready('sv2'), ready('sv3'), ready('sv4')],
    });
    expect(nodeLossOf('sv1', failedOver).mail).toEqual({ role: 'standby', staysDown: false });
    expect(nodeLossOf('sv3', failedOver).mail).toMatchObject({ role: 'active' });
  });

  it('falls back to the largest node when nothing depends on any one node', () => {
    const empty = production({ tenantNodes: [], mail: null, liveNodes: [] });
    expect(worstNodeLoss(empty)).toEqual({ node: 'sv4', tenants: 0, mail: null });
  });

  it('answers null for no nodes', () => {
    expect(worstNodeLoss(production({ nodes: [] }))).toBeNull();
  });
});
