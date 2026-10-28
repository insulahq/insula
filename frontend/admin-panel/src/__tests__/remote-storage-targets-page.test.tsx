import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RemoteStorageTargetsPage from '../pages/backups/RemoteStorageTargetsPage';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RemoteStorageTargetsPage", () => {
  it('renders page heading', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('remote-storage-targets-heading')).toBeInTheDocument();
    });
    expect(screen.getByText('Remote Storage Targets')).toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    // The Loader2 spinner is rendered — check for the animate-spin class
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows empty state when no configs exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No backup targets configured. Add one to get started.')).toBeInTheDocument();
    });
  });

  it('shows add backup target button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Backup Target')).toBeInTheDocument();
  });

  it('shows form when add button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-backup-config-button'));
    expect(screen.getByTestId('backup-config-form')).toBeInTheDocument();
    expect(screen.getByTestId('bc-name')).toBeInTheDocument();
    expect(screen.getByTestId('bc-type-ssh')).toBeInTheDocument();
    expect(screen.getByTestId('bc-type-s3')).toBeInTheDocument();
  });

  it('renders backup configs when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'bc-1',
          name: 'Nightly SSH',
          storageType: 'ssh',
          sshUser: 'backup',
          sshHost: 'storage.example.com',
          sshPath: '/backups',
          sshPort: 22,
          s3Endpoint: null,
          s3Bucket: null,
          s3Region: null,
          s3Prefix: null,
          enabled: 1,
          lastTestedAt: null,
          lastTestStatus: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('backup-config-bc-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Nightly SSH')).toBeInTheDocument();
    // A target has no retention or schedule of its own — both stored columns
    // were read by nothing, so neither is shown as if it applied.
    expect(screen.queryByText(/Retention:/)).toBeNull();
    expect(screen.queryByText(/Schedule:/)).toBeNull();
  });

  it('shows what each target holds and its free space, and measures one on demand', async () => {
    const config = {
      id: 'bc-1', name: 'Box', storageType: 'cifs', cifsUser: 'u', cifsHost: 'box.example.test', cifsShare: 'backup', cifsPath: null,
      enabled: 1, lastTestedAt: null, lastTestStatus: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const usage = {
      targets: [{
        targetId: 'bc-1', name: 'Box', storageType: 'cifs', enabled: true, readOnly: false, boundClasses: ['mail', 'system', 'tenant'],
        measuringSince: null,
        usage: {
          measuredAt: new Date().toISOString(), durationMs: 1000,
          // Decimal, as the target reports it.
          classes: { system: { bytes: 3e9, objects: 1 }, tenant: { bytes: 500e9, objects: 1 }, mail: { bytes: 60e9, objects: 1 } },
          usedByBackupsBytes: 563e9,
          capacity: { totalBytes: 1e12, usedBytes: 576e9, freeBytes: 424e9 },
          capacityNote: null, errors: {},
        },
      }],
    };
    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/backup-configs/usage')) return { data: usage };
      if (url.endsWith('/usage/refresh') && init?.method === 'POST') return { data: { started: true } };
      return { data: [config] };
    });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    const summary = await screen.findByTestId('target-usage-summary-bc-1');
    expect(summary).toHaveTextContent('563.0 GB used by backups');
    expect(summary).toHaveTextContent('424.0 GB free of 1.0 TB');
    expect(summary).toHaveTextContent('System 3.0 GB · Tenants 500.0 GB · Mail 60.0 GB');
    fireEvent.click(screen.getByTestId('target-usage-measure-bc-1'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/admin/backup-configs/bc-1/usage/refresh', { method: 'POST' }));
  });

  it('shows SSH fields by default in form', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<RemoteStorageTargetsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-backup-config-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-backup-config-button'));
    expect(screen.getByTestId('bc-ssh-host')).toBeInTheDocument();
    expect(screen.getByTestId('bc-ssh-user')).toBeInTheDocument();
    // No per-target retention or schedule to fill in.
    expect(screen.queryByTestId('bc-retention')).toBeNull();
    expect(screen.queryByTestId('bc-schedule')).toBeNull();
  });
});
