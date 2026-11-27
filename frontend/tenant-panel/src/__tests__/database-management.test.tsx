import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DatabaseManagementModal from '../components/DatabaseManagementModal';
import type { Deployment, CatalogEntry } from '@/types/api';
import type { DeploymentCredentialsResponse } from '@insula/api-contracts';
import { apiFetch, ApiError } from '@/lib/api-client';
import { ADMIN_ACCOUNT_PENDING_WAIT_MS } from '@/hooks/use-credentials-awaiting-admin';

// The rotate hook runs for real against a mocked apiFetch, so its pending /
// error / success states are the ones the panel actually gets.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: vi.fn(),
}));
const mockApiFetch = vi.mocked(apiFetch);

// Mock all deployment hooks
const mockUseDeploymentCredentials = vi.fn();
const mockUseRestartDeployment = vi.fn();
const mockUseDbDatabases = vi.fn();
const mockUseCreateDbDatabase = vi.fn();
const mockUseDropDbDatabase = vi.fn();
const mockUseDbUsers = vi.fn();
const mockUseCreateDbUser = vi.fn();
const mockUseDropDbUser = vi.fn();
const mockUseSetDbUserPassword = vi.fn();

vi.mock('../hooks/use-deployments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/use-deployments')>();
  return {
    ...actual,
    useDeploymentCredentials: (...args: unknown[]) => mockUseDeploymentCredentials(...args),
    useRestartDeployment: (...args: unknown[]) => mockUseRestartDeployment(...args),
    useDbDatabases: (...args: unknown[]) => mockUseDbDatabases(...args),
    useCreateDbDatabase: (...args: unknown[]) => mockUseCreateDbDatabase(...args),
    useDropDbDatabase: (...args: unknown[]) => mockUseDropDbDatabase(...args),
    useDbUsers: (...args: unknown[]) => mockUseDbUsers(...args),
    useCreateDbUser: (...args: unknown[]) => mockUseCreateDbUser(...args),
    useDropDbUser: (...args: unknown[]) => mockUseDropDbUser(...args),
    useSetDbUserPassword: (...args: unknown[]) => mockUseSetDbUserPassword(...args),
  };
});

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

const mockDeployment: Deployment = {
  id: 'dep-1',
  tenantId: 'tenant-1',
  catalogEntryId: 'entry-1',
  name: 'my-mariadb',
  domainName: null,
  replicaCount: 1,
  cpuRequest: '0.25',
  memoryRequest: '256Mi',
  configuration: {},
  installedVersion: '10.11',
  targetVersion: '10.11',
  status: 'running',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
} as Deployment;

const mockDatabaseEntry: CatalogEntry = {
  id: 'entry-1',
  code: 'mariadb',
  name: 'MariaDB',
  type: 'database',
  components: [{ name: 'mariadb', type: 'statefulset', image: 'mariadb:11', database: 'mariadb' }],
} as CatalogEntry;

const ADMIN_PASSWORD = 'Adm1n-Pw-xyz';
const mockRefetchCredentials = vi.fn();

function credentialsWith(over: Partial<DeploymentCredentialsResponse> = {}) {
  return {
    refetch: mockRefetchCredentials,
    data: {
      data: {
        // The platform's root keys are never in here any more.
        credentials: {},
        connectionInfo: { host: 'my-mariadb.tenant-1.svc.cluster.local', port: 3306, database: 'mydb', username: 'admin' },
        generatedKeys: [],
        adminAccount: { username: 'dbadmin', password: ADMIN_PASSWORD },
        adminAccountStatus: 'ready' as const,
        ...over,
      },
    },
    isLoading: false,
  };
}

const mockNonDatabaseEntry: CatalogEntry = {
  id: 'entry-2',
  code: 'nodejs',
  name: 'Node.js',
  type: 'runtime',
} as CatalogEntry;

function setupDefaultMocks() {
  mockUseDeploymentCredentials.mockReturnValue(credentialsWith());
  mockUseRestartDeployment.mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false });
  mockUseDbDatabases.mockReturnValue({
    data: { data: [{ name: 'app_db' }, { name: 'test_db' }] },
    isLoading: false,
    isError: false,
  });
  mockUseCreateDbDatabase.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDropDbDatabase.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDbUsers.mockReturnValue({
    data: { data: [{ username: 'admin', host: '%' }, { username: 'reader', host: '%' }] },
    isLoading: false,
    isError: false,
  });
  mockUseCreateDbUser.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseDropDbUser.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mockUseSetDbUserPassword.mockReturnValue({ mutate: vi.fn(), isPending: false });
}

describe('DatabaseManagementModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders nothing when closed', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={false}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('database-management-modal')).not.toBeInTheDocument();
  });

  it('renders nothing when no deployment', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={null}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('database-management-modal')).not.toBeInTheDocument();
  });

  it('renders the modal with deployment name', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('database-management-modal')).toBeInTheDocument();
    expect(screen.getByText('my-mariadb')).toBeInTheDocument();
    expect(screen.getByText('Database Management')).toBeInTheDocument();
  });

  it('renders connection info card', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connection-info-card')).toBeInTheDocument();
    expect(screen.getByText('my-mariadb.tenant-1.svc.cluster.local')).toBeInTheDocument();
  });

  it('renders credentials card', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('credentials-card')).toBeInTheDocument();
  });

  it('renders databases card for database-type entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('databases-card')).toBeInTheDocument();
    expect(screen.getByTestId('db-row-app_db')).toBeInTheDocument();
    expect(screen.getByTestId('db-row-test_db')).toBeInTheDocument();
  });

  it('renders database users card for database-type entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('db-users-card')).toBeInTheDocument();
    expect(screen.getByTestId('user-row-admin')).toBeInTheDocument();
    expect(screen.getByTestId('user-row-reader')).toBeInTheDocument();
  });

  it('does not render databases or users cards for non-database entries', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockNonDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('databases-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('db-users-card')).not.toBeInTheDocument();
  });

  it('shows create database form', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('create-db-form')).toBeInTheDocument();
    expect(screen.getByTestId('create-db-input')).toBeInTheDocument();
    expect(screen.getByTestId('create-db-button')).toBeInTheDocument();
  });

  it('creates a database when submitting the form', () => {
    const mutateFn = vi.fn();
    mockUseCreateDbDatabase.mockReturnValue({ mutate: mutateFn, isPending: false });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByTestId('create-db-input');
    fireEvent.change(input, { target: { value: 'new_db' } });
    fireEvent.click(screen.getByTestId('create-db-button'));

    expect(mutateFn).toHaveBeenCalledWith(
      { deploymentId: 'dep-1', name: 'new_db' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('shows delete confirmation for database', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('db-delete-app_db'));
    expect(screen.getByTestId('db-delete-confirm-app_db')).toBeInTheDocument();
    expect(screen.getByTestId('db-delete-cancel-app_db')).toBeInTheDocument();
  });

  it('cancels delete confirmation for database', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('db-delete-app_db'));
    fireEvent.click(screen.getByTestId('db-delete-cancel-app_db'));
    expect(screen.queryByTestId('db-delete-confirm-app_db')).not.toBeInTheDocument();
  });

  it('shows add user button and form', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('show-create-user-form'));
    expect(screen.getByTestId('create-user-form')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-username')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-database')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-submit')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-cancel')).toBeInTheDocument();
  });

  it('creates a user when submitting the form', () => {
    const mutateFn = vi.fn();
    mockUseCreateDbUser.mockReturnValue({ mutate: mutateFn, isPending: false });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('show-create-user-form'));
    fireEvent.change(screen.getByTestId('create-user-username'), { target: { value: 'new_user' } });
    fireEvent.click(screen.getByTestId('create-user-submit'));

    // The password must NOT be sent. This test previously asserted
    // `password: expect.any(String)` — it encoded the bug as the contract.
    // The panel generated a password, sent it, and displayed its own value;
    // the API ignored it and applied a different one, so every user created
    // this way had a password nobody had seen. Symptom: "Access denied" from
    // the tenant's application with a correct username and correct grants.
    const [payload, handlers] = mutateFn.mock.calls[0];
    expect(payload).toEqual({
      deploymentId: 'dep-1',
      username: 'new_user',
      // Preselected because a database exists — least privilege by default.
      database: 'app_db',
    });
    expect(payload).not.toHaveProperty('password');
    expect(handlers.onSuccess).toEqual(expect.any(Function));
  });

  it('displays the password the SERVER returned, not one it generated', () => {
    // The regression that mattered: whatever is shown to the operator must be
    // the value the API applied.
    const mutateFn = vi.fn((_vars, opts) => {
      opts.onSuccess({ data: { username: 'new_user', password: 'SERVER-SIDE-PW', database: 'app_db' } });
    });
    mockUseCreateDbUser.mockReturnValue({ mutate: mutateFn, isPending: false });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('show-create-user-form'));
    fireEvent.change(screen.getByTestId('create-user-username'), { target: { value: 'new_user' } });
    fireEvent.click(screen.getByTestId('create-user-submit'));

    expect(screen.getByText('SERVER-SIDE-PW')).toBeInTheDocument();
  });

  it('triggers password regeneration for a user', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    // The set-password button now triggers regeneration directly (auto-generate)
    const regenButton = screen.getByTestId('user-set-password-admin');
    expect(regenButton).toBeInTheDocument();
    fireEvent.click(regenButton);
    // The mutation should be called with a generated password
  });

  it('shows delete confirmation for user', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('user-delete-reader'));
    expect(screen.getByTestId('user-delete-confirm-reader')).toBeInTheDocument();
    expect(screen.getByTestId('user-delete-cancel-reader')).toBeInTheDocument();
  });

  it('renders actions card with restart button', () => {
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('actions-card')).toBeInTheDocument();
    expect(screen.getByTestId('restart-database-button')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId('db-modal-close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading state while credentials are loading', () => {
    mockUseDeploymentCredentials.mockReturnValue({ data: null, isLoading: true });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('connection-info-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('databases-card')).not.toBeInTheDocument();
  });

  it('shows error state when databases fail to load', () => {
    mockUseDbDatabases.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('databases-error')).toBeInTheDocument();
  });

  it('shows error state when users fail to load', () => {
    mockUseDbUsers.mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
    });

    renderWithProviders(
      <DatabaseManagementModal
        open={true}
        deployment={mockDeployment}
        catalogEntry={mockDatabaseEntry}
        tenantId="tenant-1"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('db-users-error')).toBeInTheDocument();
  });
});

// ─── The tenant's administrator account (root is the platform's) ─────────────

function renderOpen(deployment: Deployment = mockDeployment, entry: CatalogEntry = mockDatabaseEntry) {
  return renderWithProviders(
    <DatabaseManagementModal
      open={true}
      deployment={deployment}
      catalogEntry={entry}
      tenantId="tenant-1"
      onClose={vi.fn()}
    />,
  );
}

describe('DatabaseManagementModal — root is never shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('renders no root / superuser row, whatever the user list says', () => {
    // Even a list that (wrongly) contained root must not bring the old row back.
    mockUseDbUsers.mockReturnValue({
      data: { data: [{ username: 'reader', host: '%' }] },
      isLoading: false,
      isError: false,
    });
    renderOpen();
    expect(screen.queryByTestId('user-row-root')).not.toBeInTheDocument();
    expect(screen.queryByText(/superuser/i)).not.toBeInTheDocument();
    const users = screen.getByTestId('db-users-card');
    expect(within(users).queryByText('root')).not.toBeInTheDocument();
  });

  it('builds the connection URL with the application user, never root', () => {
    renderOpen();
    const card = screen.getByTestId('connection-info-card');
    expect(card).toHaveTextContent('mysql://admin:***@my-mariadb.tenant-1.svc.cluster.local:3306/mydb');
    expect(card.textContent).not.toMatch(/root/);
  });

  it('uses the administrator account in the URL when there is no application user', () => {
    mockUseDeploymentCredentials.mockReturnValue(credentialsWith({
      connectionInfo: { host: 'my-mariadb.tenant-1.svc.cluster.local', port: 3306, database: null, username: null },
    }));
    renderOpen();
    expect(screen.getByTestId('connection-info-card')).toHaveTextContent('mysql://dbadmin:***@my-mariadb.tenant-1.svc.cluster.local:3306');
  });
});

describe('DatabaseManagementModal — administrator account', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    writeText = vi.fn();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
  });

  it('shows the username and keeps the password masked until revealed', () => {
    renderOpen();
    const card = screen.getByTestId('admin-account-card');
    expect(within(card).getByTestId('admin-account-username')).toHaveTextContent('dbadmin');
    expect(screen.getByTestId('admin-account-password-value')).not.toHaveTextContent(ADMIN_PASSWORD);
    expect(screen.queryByText(ADMIN_PASSWORD)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-admin-password'));
    expect(screen.getByTestId('admin-account-password-value')).toHaveTextContent(ADMIN_PASSWORD);

    fireEvent.click(screen.getByTestId('toggle-admin-password'));
    expect(screen.queryByText(ADMIN_PASSWORD)).not.toBeInTheDocument();
  });

  it('copies the password and the username without revealing them', () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('copy-admin-password'));
    expect(writeText).toHaveBeenCalledWith(ADMIN_PASSWORD);
    fireEvent.click(screen.getByTestId('copy-admin-username'));
    expect(writeText).toHaveBeenCalledWith('dbadmin');
    expect(screen.queryByText(ADMIN_PASSWORD)).not.toBeInTheDocument();
  });

  it('says what the account can do — and that users are added under Database Users', () => {
    renderOpen();
    const scope = screen.getByTestId('admin-account-scope');
    expect(scope).toHaveTextContent(/all your databases/i);
    expect(scope).toHaveTextContent('db_');
    expect(scope).toHaveTextContent(/Database Users/);
  });

  it('says "being set up" and asks the hook to re-poll while the account is not there yet', () => {
    mockUseDeploymentCredentials.mockReturnValue(credentialsWith({ adminAccount: null, adminAccountStatus: 'pending' }));
    renderOpen();
    expect(screen.getByTestId('admin-account-pending')).toHaveTextContent(/being set up/i);
    expect(screen.queryByTestId('admin-account-username')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-password-new')).not.toBeInTheDocument();
    expect(mockUseDeploymentCredentials).toHaveBeenLastCalledWith('tenant-1', 'dep-1', { pollWhileAdminPending: true });
  });

  it('stops asking after a while, says it is taking too long, and "Check again" asks once more', async () => {
    vi.useFakeTimers();
    try {
      mockUseDeploymentCredentials.mockReturnValue(credentialsWith({ adminAccount: null, adminAccountStatus: 'pending' }));
      renderOpen();
      expect(screen.getByTestId('admin-account-pending')).toBeInTheDocument();

      await act(async () => { vi.advanceTimersByTime(ADMIN_ACCOUNT_PENDING_WAIT_MS); });
      expect(screen.getByTestId('admin-account-slow')).toHaveTextContent(/taking longer than it should/i);
      expect(mockUseDeploymentCredentials).toHaveBeenLastCalledWith('tenant-1', 'dep-1', { pollWhileAdminPending: false });

      fireEvent.click(screen.getByTestId('admin-account-check-again'));
      expect(mockRefetchCredentials).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('admin-account-pending')).toBeInTheDocument();
      expect(mockUseDeploymentCredentials).toHaveBeenLastCalledWith('tenant-1', 'dep-1', { pollWhileAdminPending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['restricted', /only a tenant administrator/i],
    ['unavailable', /no administrator account here/i],
    ['lost', /lost its administrator access[\s\S]*operator has been notified/i],
  ] as const)('says why there is no account when it is %s, and shows no password or rotate button', (status, text) => {
    mockUseDeploymentCredentials.mockReturnValue(credentialsWith({ adminAccount: null, adminAccountStatus: status }));
    renderOpen();
    expect(screen.getByTestId(`admin-account-${status}`)).toHaveTextContent(text);
    expect(screen.queryByTestId('admin-account-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-account-username')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-password-new')).not.toBeInTheDocument();
  });

  it('does not poll for a stopped instance, and says why the account is not there', () => {
    mockUseDeploymentCredentials.mockReturnValue(credentialsWith({ adminAccount: null, adminAccountStatus: 'pending' }));
    renderOpen({ ...mockDeployment, status: 'stopped' } as Deployment);
    expect(screen.getByTestId('admin-account-waiting')).toHaveTextContent(/once the database is running/i);
    expect(screen.queryByTestId('admin-account-pending')).not.toBeInTheDocument();
    expect(mockUseDeploymentCredentials).toHaveBeenLastCalledWith('tenant-1', 'dep-1', { pollWhileAdminPending: false });
  });

  it('does not wait for an account on a database entry with no managed engine', () => {
    mockUseDeploymentCredentials.mockReturnValue(credentialsWith({ adminAccount: null, adminAccountStatus: 'pending' }));
    renderOpen(mockDeployment, { ...mockDatabaseEntry, components: [] } as CatalogEntry);
    expect(screen.queryByTestId('admin-account-card')).not.toBeInTheDocument();
    expect(mockUseDeploymentCredentials).toHaveBeenLastCalledWith('tenant-1', 'dep-1', { pollWhileAdminPending: false });
  });

  it('asks before setting a new password, and says tools using the old one must be updated', () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('admin-password-new'));
    expect(screen.getByTestId('admin-password-confirm')).toHaveTextContent(/stops connecting until you update it/i);
    expect(mockApiFetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('admin-password-cancel'));
    expect(screen.queryByTestId('admin-password-confirm')).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('sets a new password: POSTs once, shows a spinner while pending, closes the confirm and reveals the result', async () => {
    let resolve!: (v: unknown) => void;
    mockApiFetch.mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
    renderOpen();

    fireEvent.click(screen.getByTestId('admin-password-new'));
    fireEvent.click(screen.getByTestId('admin-password-confirm-button'));

    await waitFor(() => expect(screen.getByTestId('admin-password-confirm-button')).toBeDisabled());
    expect(screen.getByTestId('admin-password-confirm-button').querySelector('.animate-spin')).not.toBeNull();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/tenants/tenant-1/deployments/dep-1/admin-account/password',
      { method: 'POST' },
    );
    expect(screen.getByTestId('admin-password-cancel')).toBeDisabled();

    resolve({ data: { username: 'dbadmin', password: 'N3w-Pw-abc' } });

    await waitFor(() => expect(screen.queryByTestId('admin-password-confirm')).not.toBeInTheDocument());
    expect(screen.getByTestId('admin-password-rotated')).toHaveTextContent(/Update every tool/i);
    // Revealed so it can be copied straight away.
    expect(screen.getByTestId('admin-account-password-value')).not.toHaveTextContent('•');
  });

  it('shows why setting a new password failed, in an error panel, and keeps the confirm open', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(409, 'ADMIN_ACCOUNT_PENDING', 'The administrator account is still being set up'));
    renderOpen();

    fireEvent.click(screen.getByTestId('admin-password-new'));
    fireEvent.click(screen.getByTestId('admin-password-confirm-button'));

    expect(await screen.findByTestId('admin-password-error')).toHaveTextContent('The administrator account is still being set up');
    expect(screen.getByTestId('admin-password-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-password-rotated')).not.toBeInTheDocument();
  });
});

describe('DatabaseManagementModal — "All databases" for a new user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('says it covers databases created later, not the whole server', () => {
    renderOpen();
    fireEvent.click(screen.getByTestId('show-create-user-form'));
    const select = screen.getByTestId('create-user-database') as HTMLSelectElement;
    const all = within(select).getByRole('option', { name: /All databases/ });
    expect(all).toHaveTextContent('All databases (including ones created later)');
    expect(select.textContent).not.toMatch(/full access to this server/i);

    fireEvent.change(select, { target: { value: '__all__' } });
    expect(screen.getByTestId('create-user-all-databases-hint')).toHaveTextContent('db_');
    expect(screen.getByTestId('create-user-all-databases-hint')).toHaveTextContent(/No user or server administration/);
  });

  it('is honest for PostgreSQL: only the databases that exist now', () => {
    renderOpen(mockDeployment, {
      ...mockDatabaseEntry,
      code: 'postgresql',
      components: [{ name: 'postgresql', type: 'statefulset', image: 'postgres:18', database: 'postgresql' }],
    } as CatalogEntry);
    fireEvent.click(screen.getByTestId('show-create-user-form'));
    const select = screen.getByTestId('create-user-database');
    expect(within(select).getByRole('option', { name: /All databases/ })).toHaveTextContent('All databases that exist now');
  });
});
