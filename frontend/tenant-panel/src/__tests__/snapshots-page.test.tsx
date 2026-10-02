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

let lifecycle: unknown = null;
vi.mock('../hooks/use-my-lifecycle', () => ({
  useMyLifecycle: vi.fn(() => ({ data: lifecycle, isLoading: false })),
}));

vi.mock('../hooks/use-snapshots', () => ({
  useSnapshots: vi.fn(() => ({ data: listData, isLoading: false, isError: false, refetch: vi.fn() })),
  useCreateSnapshot: vi.fn(() => ({ mutate: createMutate, isPending: false, error: null })),
  useDeleteSnapshot: vi.fn(() => ({ mutate: deleteMutate, isPending: false, error: null })),
  useRestoreSnapshot: vi.fn(() => ({ mutate: restoreMutate, isPending: false, error: null })),
  useRestoreStatus: vi.fn(() => ({
    data: {
      data: {
        operationId: 'op-1', state: 'restoring', outcome: 'running', progressPct: 70, progressMessage: 'Restoring…',
        lastError: null, error: null, snapshotLabel: 'nightly', startedAt: new Date().toISOString(), completedAt: null, steps: [],
      },
    },
    isError: false,
  })),
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
    lifecycle = null;
  });

  const readySnap = {
    id: 'snap-1', tenantId: 't', label: 'nightly', status: 'ready', sizeBytes: 5368709120, dataSizeBytes: 67399680,
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
    // TimeCell (shared with the admin panel) rolls to a day tier at >= 24h,
    // so a 40h TTL renders "in 2d" (ceil), not "in 40h".
    expect(screen.getByTestId('snapshot-row-snap-1').textContent).toMatch(/in 2d/);
    fireEvent.click(screen.getByTestId('delete-snapshot-snap-1'));
    fireEvent.click(screen.getByTestId('confirm-delete-snapshot'));
    expect(deleteMutate).toHaveBeenCalledWith('snap-1', expect.anything());
  });

  it('Restore opens the destructive confirm modal and fires the hook on confirm', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    render(<Snapshots />, { wrapper });
    const btn = screen.getByTestId('restore-snapshot-snap-1');
    expect(btn).not.toBeDisabled();
    // Clicking opens the confirm modal — the hook does NOT fire yet.
    fireEvent.click(btn);
    expect(restoreMutate).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('confirm-restore-snapshot');
    expect(confirm).toBeInTheDocument();
    // Confirming fires the restore hook with the snapshot id.
    fireEvent.click(confirm);
    expect(restoreMutate).toHaveBeenCalledWith('snap-1', expect.anything());
  });

  it('shows the real data size next to the volume size', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('snapshot-volume-size-snap-1').textContent).toBe('5.0 GB');
    const data = screen.getByTestId('snapshot-data-size-snap-1');
    expect(data.textContent).toBe('64.3 MB');
    expect(data.getAttribute('data-measured')).toBe('true');
    expect(screen.getByTestId('sort-dataSizeBytes').getAttribute('title')).toMatch(/actually uses on the server/);
  });

  it('★ an unmeasured data size is a dash with a reason, and a measured 0 is "0 B"', () => {
    listData = {
      data: {
        expiryHours: 48,
        snapshots: [
          { ...readySnap, id: 'old', dataSizeBytes: null },
          { ...readySnap, id: 'same', dataSizeBytes: 0 },
        ],
      },
    };
    render(<Snapshots />, { wrapper });
    const unknown = screen.getByTestId('snapshot-data-size-old');
    expect(unknown.textContent).toBe('—');
    expect(unknown.getAttribute('data-measured')).toBe('false');
    expect(unknown.getAttribute('title')).toMatch(/Not measured/);
    const zero = screen.getByTestId('snapshot-data-size-same');
    expect(zero.textContent).toBe('0 B');
    expect(zero.getAttribute('data-measured')).toBe('true');
  });

  it('confirming a restore opens the step-by-step progress modal', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    restoreMutate.mockImplementation((_id: string, opts: { onSuccess: (r: unknown) => void }) => {
      opts.onSuccess({ data: { operationId: 'op-1' } });
    });
    render(<Snapshots />, { wrapper });
    fireEvent.click(screen.getByTestId('restore-snapshot-snap-1'));
    fireEvent.click(screen.getByTestId('confirm-restore-snapshot'));
    expect(screen.getByTestId('restore-progress-modal')).toBeInTheDocument();
    restoreMutate.mockReset();
  });

  it('★ re-opens the progress of a restore already running (reload / navigated back)', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    lifecycle = {
      tenantStatus: 'active', storageLifecycleState: 'restoring', tenantId: 't',
      activeStorageOperation: { id: 'op-1', isSnapshotRestore: true },
    };
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('restore-progress-modal')).toBeInTheDocument();
  });

  it('★ while a storage operation runs, nothing here can start another one', () => {
    listData = { data: { expiryHours: 48, snapshots: [readySnap] } };
    lifecycle = {
      tenantStatus: 'active', storageLifecycleState: 'resizing', tenantId: 't',
      activeStorageOperation: { id: 'op-2', isSnapshotRestore: false },
    };
    render(<Snapshots />, { wrapper });
    expect(screen.getByTestId('create-snapshot')).toBeDisabled();
    expect(screen.getByTestId('restore-snapshot-snap-1')).toBeDisabled();
    expect(screen.getByTestId('delete-snapshot-snap-1')).toBeDisabled();
    // Not a snapshot restore — no restore progress to re-open.
    expect(screen.queryByTestId('restore-progress-modal')).not.toBeInTheDocument();
  });

  it('does NOT offer restore for a still-creating snapshot', () => {
    listData = { data: { expiryHours: 48, snapshots: [{ ...readySnap, status: 'creating' }] } };
    render(<Snapshots />, { wrapper });
    expect(screen.queryByTestId('restore-snapshot-snap-1')).toBeNull();
  });
});
