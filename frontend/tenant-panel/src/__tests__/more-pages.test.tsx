import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Email from '../pages/Email';
import Files from '../pages/Files';

vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(() => ({
    user: { id: 'tenant-1', email: 'test@example.com', fullName: 'Test User', role: 'tenant' },
    token: 'test-token',
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    initialize: vi.fn(),
  })),
}));

vi.mock('../hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({
    tenantId: 'tenant-1',
    tenantName: 'Test Company',
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-file-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-file-manager')>();
  return {
    ...actual,
    useFileManagerStatus: vi.fn(() => ({ data: { ready: false, phase: 'starting' }, isLoading: false, error: null })),
    useStartFileManager: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useDirectoryListing: vi.fn(() => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() })),
    useFileContent: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
    useCreateDirectory: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useWriteFile: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useRenameFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useDeleteFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useDownloadFile: vi.fn(() => vi.fn()),
    useUploadFiles: vi.fn(() => ({ uploads: [], uploadFiles: vi.fn(), clearUploads: vi.fn(), visible: false, setVisible: vi.fn() })),
    useCopyFile: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
    useArchiveFiles: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useExtractArchive: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useGitClone: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useAuthenticatedBlobUrl: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
    useDiskUsage: vi.fn(() => ({ data: null, isLoading: false })),
    useFolderSize: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
    useChmod: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false })),
  };
});

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
}));

vi.mock('../hooks/use-email', () => ({
  useEmailDomains: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useMailboxes: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDeleteEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useWebmailToken: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useEnableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDisableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null })),
  useEmailDomainDisablePreview: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  useUpdateEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailDomainDnsRecords: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useDkimKeys: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useRotateDkimKey: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useActivateDkimKey: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useImapSyncJobs: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateImapSyncJob: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCancelImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  usePurgeImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useResyncImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateImapSyncJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useMailRateLimit: vi.fn(() => ({
    data: { data: { limitPerHour: 100, source: 'hardcoded_default', suspended: false } },
    isLoading: false,
  })),
  useMailboxUsage: vi.fn(() => ({
    data: { data: { limit: 50, current: 0, remaining: 50, source: 'plan' } },
    isLoading: false,
  })),
}));

vi.mock('../hooks/use-domains', () => ({
  useDomains: vi.fn(() => ({
    data: { data: [] },
    isLoading: false,
  })),
}));

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// Backups surface tests live in backups-page.test.tsx — that page reads
// /api/v1/tenant/backups/* (bundles). The skipped legacy block that used to
// sit here went with the retired `backups` table (2026-09-11).

describe('Email', () => {
  it('renders the heading', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-heading')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows the Enable Email card when no email domains', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-enable-card')).toBeInTheDocument();
    expect(screen.getByText('Enable Email Hosting')).toBeInTheDocument();
  });
});

describe('Files', () => {
  it('renders the heading', () => {
    renderWithProviders(<Files />);
    expect(screen.getByTestId('files-heading')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('shows loading state when starting', () => {
    renderWithProviders(<Files />);
    // File manager status defaults to starting/not_deployed, should show loading
    expect(screen.getByText('Starting File Manager')).toBeInTheDocument();
  });
});
