import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ClusterNodeResponse } from '@insula/api-contracts';
import NodeEditModal from '../components/NodeEditModal';
import { nodeTakesTier, pinnedOnlySuffix } from '../lib/tenant-hosting';

// "Tenant hosting" replaced the "Can host tenant workloads" switch: all
// tenants, pinned tenants only, or none.

const mutateAsync = vi.fn(async (_body: Record<string, unknown>) => ({}));
vi.mock('@/hooks/use-cluster-nodes', () => ({
  useUpdateClusterNode: () => ({ mutateAsync, isPending: false, error: null }),
  useDrainImpact: () => ({ data: undefined }),
}));

const node = (over: Partial<ClusterNodeResponse> = {}) => ({
  name: 'za-1', displayName: null, role: 'worker', canHostTenantWorkloads: true, tenantHosting: 'all',
  cordoned: false, ingressMode: 'all', notes: null, ...over,
}) as unknown as ClusterNodeResponse;

const open = (n: ClusterNodeResponse) => render(<MemoryRouter><NodeEditModal node={n} onClose={() => {}} /></MemoryRouter>);
const save = () => fireEvent.click(screen.getByTestId('save-node-za-1-button'));

beforeEach(() => mutateAsync.mockClear());

describe('NodeEditModal — Tenant hosting', () => {
  it('offers the three modes and says what the chosen one does', () => {
    open(node());
    const select = screen.getByTestId('node-tenant-hosting-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['ALL TENANTS', 'PINNED TENANTS ONLY', 'NO TENANTS']);
    expect(select.value).toBe('all');
    fireEvent.change(select, { target: { value: 'pinned' } });
    expect(screen.getByTestId('node-tenant-hosting-hint')).toHaveTextContent('Auto never picks this node');
    expect(screen.getByTestId('node-tenant-hosting-hint')).toHaveTextContent('Local storage tier only');
  });

  it('saves pinned-only with the boolean an older API reads', async () => {
    open(node());
    fireEvent.change(screen.getByTestId('node-tenant-hosting-select'), { target: { value: 'pinned' } });
    save();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ tenantHosting: 'pinned', canHostTenantWorkloads: true });
  });

  it('saves none as hosting off', async () => {
    open(node({ tenantHosting: 'pinned' }));
    expect((screen.getByTestId('node-tenant-hosting-select') as HTMLSelectElement).value).toBe('pinned');
    fireEvent.change(screen.getByTestId('node-tenant-hosting-select'), { target: { value: 'none' } });
    save();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ tenantHosting: 'none', canHostTenantWorkloads: false });
  });

  it('a save that leaves hosting alone sends neither — a drained pinned-only node keeps its setting', async () => {
    open(node({ canHostTenantWorkloads: false, tenantHosting: 'none' }));
    fireEvent.change(screen.getByLabelText('Operator notes'), { target: { value: 'remote' } });
    save();
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    const body = mutateAsync.mock.calls[0][0];
    expect(body.tenantHosting).toBeUndefined();
    expect(body.canHostTenantWorkloads).toBeUndefined();
    expect(body.notes).toBe('remote');
  });

  it('reads a node from an API without the mode by its boolean', () => {
    open(node({ tenantHosting: undefined, canHostTenantWorkloads: false }));
    expect((screen.getByTestId('node-tenant-hosting-select') as HTMLSelectElement).value).toBe('none');
  });
});

describe('node pickers', () => {
  const all = { canHostTenantWorkloads: true, tenantHosting: 'all' as const };
  const pinned = { canHostTenantWorkloads: true, tenantHosting: 'pinned' as const };
  const none = { canHostTenantWorkloads: false, tenantHosting: 'none' as const };

  it('a pinned-only node takes Local-tier tenants, not HA-tier ones', () => {
    expect(nodeTakesTier(pinned, 'local')).toBe(true);
    expect(nodeTakesTier(pinned, 'ha')).toBe(false);
    expect(nodeTakesTier(all, 'ha')).toBe(true);
    expect(nodeTakesTier(none, 'local')).toBe(false);
    // Tier unknown (a bulk change across tenants): any node that hosts.
    expect(nodeTakesTier(pinned)).toBe(true);
  });

  it('labels a pinned-only node and only that', () => {
    expect(pinnedOnlySuffix(pinned)).toBe(' — pinned tenants only');
    expect(pinnedOnlySuffix(all)).toBe('');
    expect(pinnedOnlySuffix({ canHostTenantWorkloads: true })).toBe('');
  });
});
