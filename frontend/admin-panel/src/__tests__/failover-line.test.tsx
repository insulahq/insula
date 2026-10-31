/**
 * The dashboard's Failover line.
 *
 * Operator report: it said "Worst case is sv4" — the node with the most CPU —
 * while no tenant and no part of mail used sv4, and sv3 held 23 tenants and
 * the mail standby. The worst case now names what depends on the node.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { AdminDashboardLive, NodeLoss } from '@insula/api-contracts';
import FailoverLine, { nodeLossParts } from '../components/console/FailoverLine';

vi.mock('@/hooks/use-node-labels', () => ({ useNodeLabel: () => (n: string) => n }));

type Cluster = NonNullable<AdminDashboardLive['cluster']['data']>;

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    cpu: { inUse: 4, committed: 12, total: 40, unit: 'cores', kind: 'reserve' },
    memory: { inUse: 40, cache: 10, committed: 60, total: 160, unit: 'GiB', kind: 'reserve' },
    storage: { inUse: 178, committed: 160, total: 540, unit: 'GB', kind: 'consume' },
    storageBreakdown: null,
    nodeCount: 4,
    survivesSingleNodeLoss: true,
    worstNode: 'sv4',
    worstNodeLoss: { node: 'sv3', tenants: 23, mail: { role: 'secondary', staysDown: false } },
    ...over,
  };
}

const line = () => screen.getByTestId('failover-line').textContent;

describe('FailoverLine', () => {
  it('names the node most depends on and what it would take with it, not the largest node', () => {
    render(<FailoverLine cluster={cluster()} />);
    expect(line()).toBe('FailoverSurvives losing any one node. Worst case is sv3 (23 tenants + mail secondary would be affected).');
    expect(line()).not.toContain('sv4');
  });

  it('says when nothing depends on a single node', () => {
    render(<FailoverLine cluster={cluster({ worstNodeLoss: { node: 'sv4', tenants: 0, mail: null } })} />);
    expect(line()).toContain('No tenant or mail depends on a single node.');
    expect(line()).not.toContain('Worst case');
  });

  it('names no worst case rather than guess when placement could not be read', () => {
    render(<FailoverLine cluster={cluster({ worstNodeLoss: null })} />);
    expect(line()).toBe('FailoverSurvives losing any one node.');
  });

  it('keeps the capacity node in the warning, and adds what the worst node would affect', () => {
    render(<FailoverLine cluster={cluster({ survivesSingleNodeLoss: false })} />);
    expect(line()).toContain('Would not survive losing sv4.');
    expect(line()).toContain('Losing sv3 would affect 23 tenants + mail secondary.');
  });

  it('keeps the single-node message', () => {
    render(<FailoverLine cluster={cluster({ nodeCount: 1, survivesSingleNodeLoss: false })} />);
    expect(line()).toContain('No redundancy.');
  });
});

describe('nodeLossParts', () => {
  const loss = (over: Partial<NodeLoss>): NodeLoss => ({ node: 'sv1', tenants: 0, mail: null, ...over });

  it('words every part of mail', () => {
    expect(nodeLossParts(loss({ tenants: 1, mail: { role: 'active', staysDown: false } })))
      .toEqual(['1 tenant', 'mail until it fails over']);
    expect(nodeLossParts(loss({ mail: { role: 'active', staysDown: true } }))).toEqual(['all mail (no failover)']);
    expect(nodeLossParts(loss({ mail: { role: 'tertiary', staysDown: false } }))).toEqual(['mail tertiary']);
    expect(nodeLossParts(loss({ mail: { role: 'standby', staysDown: false } }))).toEqual(['mail standby']);
    expect(nodeLossParts(loss({}))).toEqual([]);
  });
});
