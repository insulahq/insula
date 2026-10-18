import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClusterNodeResponse, DrainImpact } from '@insula/api-contracts';
import NodeEditModal from '../components/NodeEditModal';

// The edit modal's Cordon toggle is the other way to cordon a node. It says
// what the cordon touches — mail's failover, a database instance's rebuild —
// and reads that only once the operator switches it on.

const enabledCalls: boolean[] = [];
let impact: Partial<DrainImpact> | undefined;
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useUpdateClusterNode: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDrainImpact: (_name: string, enabled: boolean) => {
    enabledCalls.push(enabled);
    return { data: enabled && impact ? { data: impact } : undefined };
  },
}));

const node = { name: 's2', displayName: null, role: 'server', canHostTenantWorkloads: true, cordoned: false, ingressMode: 'all', notes: null } as unknown as ClusterNodeResponse;

beforeEach(() => {
  enabledCalls.length = 0;
  impact = {
    mailRole: {
      role: 'secondary', activeNode: 's1', autoFailoverEnabled: true, failoverThresholdSeconds: 300,
      otherFailoverTargets: [], onlyStandbyCopy: true,
    },
    longhornReplicas: [{
      volumeName: 'pvc-3', replicaName: 'r-3', isLastReplica: true, movedByRepin: false,
      postgresInstance: { kind: 'postgres', cluster: 'system-db', instance: 'system-db-3', primary: false, coveredBy: ['system-db-2'] },
      namespace: 'platform', pvcName: 'system-db-3', tenantId: null, tenantName: null, ownerLabel: 'Platform System (platform)',
    }],
  };
});

describe('NodeEditModal — switching Cordon on says what it touches', () => {
  it('reads nothing until the toggle is switched on, then shows the mail and database notices', () => {
    render(<MemoryRouter><NodeEditModal node={node} onClose={() => {}} /></MemoryRouter>);
    expect(enabledCalls.every((e) => e === false)).toBe(true);
    expect(screen.queryByTestId('cordon-impact')).toBeNull();

    fireEvent.click(screen.getByTestId('node-cordon-toggle'));

    expect(enabledCalls.at(-1)).toBe(true);
    expect(screen.getByTestId('mail-role-notice')).toHaveTextContent('While s2 is cordoned, mail cannot fail over');
    expect(screen.getByTestId('cordon-impact-db')).toHaveTextContent('platform/system-db-3');
  });

  it('an already-cordoned node being edited shows no notice', () => {
    render(<MemoryRouter><NodeEditModal node={{ ...node, cordoned: true }} onClose={() => {}} /></MemoryRouter>);
    expect(screen.queryByTestId('cordon-impact')).toBeNull();
    expect(enabledCalls.every((e) => e === false)).toBe(true);
  });
});
