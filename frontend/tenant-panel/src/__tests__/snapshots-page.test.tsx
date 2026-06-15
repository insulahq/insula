import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Snapshots from '../pages/Snapshots';

const createMutate = vi.fn();
const deleteMutate = vi.fn();
const restoreMutate = vi.fn();
let listData: { data: { snapshots: unknown[]; expiryHours: number } } | undefined = {
  data: { snapshots: [], expiryHours: 48 },
};

vi.mock('../hooks/use-snapshots', () => ({
  useSnapshots: vi.fn(() => ({ data: listData, isLoading: false, isError: false, refetch: vi.fn() })),
  useCreateSnapshot: vi.fn(() => ({ mutate: createMutate, isPending: false, error: null })),
  useDeleteSnapshot: vi.fn(() => ({ mutate: deleteMutate, isPending: false, error: null })),
  useRestoreSnapshot: vi.fn(() => ({ mutate: restoreMutate, isPending: false, error: null })),
  useRestoreStatus: vi.fn(() => ({ data: { data: { operationId: 'op-1', state: 'restoring', progressPct: 70, progressMessage: 'Restoring…', lastError: null } } })),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Snapshots page', () => {
  beforeEach(() => {
    createMutate.mockClear();
    deleteMutate.mockClear();
    restoreMutate.mockClear();
    listData = { data: { snapshots: [], expiryHours: 48 } };
  });

  const readySnap = {
    id: 'snap-1', tenantId: 't', label: 'nightly', status: 'ready', sizeBytes: 5368709120,
    lastError: null, createdAt: new Date().toISOString(), readyAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 40 * 3600_000).toISOString(),
  };

  it('renders the heading + the on-server / expiry notice', () => {
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('snapshots-heading')).toBeInTheDocument();
    // The notice must surface the admin-configured retention.
    expect(screen.getByTestId('snapshots-notice').textContent).toMatch(/48 hours/);
  });

  it('shows the empty state with no snapshots', () => {
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('snapshots-empty')).toBeInTheDocument();
  });

  it('opens the create modal and submits the label', () => {
    render(<Snapshots />, { wrapper });
    fireEvent.click(screen.getByTestId('create-snapshot'));
    fireEvent.change(screen.getByTestId('snapshot-label-input'), { target: { value: 'before update' } });
    fireEvent.click(screen.getByTestId('confirm-create-snapshot'));
    expect(createMutate).toHaveBeenCalledWith('before update', expect.anything());
  });

  it('lists a ready snapshot with its expiry countdown + delete action', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('snapshot-row-snap-1')).toBeInTheDocument();
    expect(screen.getByTestId('snapshot-row-snap-1').textContent).toMatch(/in 39h|in 40h/);
    fireEvent.click(screen.getByTestId('delete-snapshot-snap-1'));
    fireEvent.click(screen.getByTestId('confirm-delete-snapshot'));
    expect(deleteMutate).toHaveBeenCalledWith('snap-1', expect.anything());
  });

  it('Restore is gated off (coming soon) — disabled, never fires the hook', () => {
    // Full-volume restore is disabled pending the Longhorn snapshotRevert
    // redesign. The button stays visible (discoverable) but disabled.
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    render(<Snapshots />, { wrapper });
    const btn = screen.getByTestId('restore-snapshot-snap-1');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toMatch(/coming soon/i);
    fireEvent.click(btn); // disabled → no-op
    expect(restoreMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-restore-snapshot')).toBeNull();
  });

  it('does NOT offer restore for a still-creating snapshot', () => {
    listData = { data: { expiryHours: 48, snapshots: [{ ...readySnap, status: 'creating' }] } };
    render(<Snapshots />, { wrapper });
    expect(screen.queryByTestId('restore-snapshot-snap-1')).toBeNull();
  });
});
