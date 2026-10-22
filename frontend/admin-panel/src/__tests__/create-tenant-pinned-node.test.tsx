import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import CreateTenantModal from '../components/CreateTenantModal';

// A node that takes pinned tenants only is a hand-picked target for a
// Local-tier tenant — never for an HA-tier one, and never what Auto means.

vi.mock('@/hooks/use-cluster-nodes', () => ({
  useClusterNodes: () => ({
    data: {
      data: [
        { name: 'de-1', canHostTenantWorkloads: true, tenantHosting: 'all' },
        { name: 'de-2', canHostTenantWorkloads: true, tenantHosting: 'all' },
        { name: 'de-3', canHostTenantWorkloads: true, tenantHosting: 'all' },
        { name: 'za-1', canHostTenantWorkloads: true, tenantHosting: 'pinned' },
        { name: 'sys-1', canHostTenantWorkloads: false, tenantHosting: 'none' },
      ],
    },
  }),
}));

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CreateTenantModal open onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const optionTexts = () => [...(screen.getByTestId('worker-select') as HTMLSelectElement).options].map((o) => o.textContent ?? '');

describe('CreateTenantModal — a pinned-only node', () => {
  it('is offered for a Local-tier tenant, labelled', () => {
    renderModal();
    const texts = optionTexts();
    expect(texts.some((t) => t.startsWith('za-1 — pinned tenants only'))).toBe(true);
    expect(texts.some((t) => t.startsWith('sys-1'))).toBe(false);
    expect(screen.getByText(/among nodes that take all tenants/)).toBeInTheDocument();
  });

  it('is not offered for an HA-tier tenant, and choosing HA puts a picked one back to Auto', () => {
    renderModal();
    const nodeSelect = screen.getByTestId('worker-select') as HTMLSelectElement;
    fireEvent.change(nodeSelect, { target: { value: 'za-1' } });
    expect(nodeSelect.value).toBe('za-1');
    fireEvent.change(screen.getByTestId('storage-tier-select'), { target: { value: 'ha' } });
    expect(nodeSelect.value).toBe('');
    expect(optionTexts().some((t) => t.startsWith('za-1'))).toBe(false);
    expect(optionTexts().some((t) => t.startsWith('de-1'))).toBe(true);
  });

  it('choosing HA keeps a picked node that takes all tenants', () => {
    renderModal();
    const nodeSelect = screen.getByTestId('worker-select') as HTMLSelectElement;
    fireEvent.change(nodeSelect, { target: { value: 'de-2' } });
    fireEvent.change(screen.getByTestId('storage-tier-select'), { target: { value: 'ha' } });
    expect(nodeSelect.value).toBe('de-2');
  });
});
