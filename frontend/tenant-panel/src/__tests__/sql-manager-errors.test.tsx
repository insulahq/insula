import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CatalogEntry, Deployment } from '@/types/api';

// WHY THIS EXISTS: reported from production as "SQL Manager does not see any
// databases although there is an active one". The database actually rejected
// the platform's root credentials, and `/databases`, `/databases-with-size`
// and `/db-users` all returned 500 — but the page read only `data` from those
// queries and did `?? []`, so a hard authentication failure rendered as an
// empty, actionless database picker. Every one of those failures must reach
// the tenant as an <ErrorPanel>.

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco-stub" /> }));

const DEPLOYMENT_ID = 'dep-1';
const CATALOG_ENTRY_ID = 'cat-mariadb';

const mockDeployment = {
  id: DEPLOYMENT_ID,
  name: 'my-mariadb',
  catalogEntryId: CATALOG_ENTRY_ID,
  status: 'running',
  cpuRequest: '250m',
  memoryRequest: '256Mi',
} as unknown as Deployment;

const mockCatalogEntry = {
  id: CATALOG_ENTRY_ID,
  code: 'mariadb',
  name: 'MariaDB',
  type: 'database',
  runtime: 'mariadb',
} as unknown as CatalogEntry;

interface MockQuery {
  readonly data?: unknown;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

const idleQuery: MockQuery = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
const idleMutation = { mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() };

// Each test sets these; everything else stays idle.
let databasesQuery: MockQuery = idleQuery;
let usersQuery: MockQuery = idleQuery;
let tablesQuery: MockQuery = idleQuery;

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 'tenant-1', tenant: { id: 'tenant-1' } }),
}));

vi.mock('@/hooks/use-catalog', () => ({
  useCatalog: () => ({ data: { data: [mockCatalogEntry] }, isLoading: false, error: null }),
}));

vi.mock('@/hooks/use-deployments', () => ({
  useDeployments: () => ({ data: { data: [mockDeployment] }, isLoading: false, error: null }),
  useDeploymentLiveMetrics: () => ({ ...idleQuery }),
  useDbDatabases: () => databasesQuery,
  useDbUsers: () => usersQuery,
  useCreateDbDatabase: () => ({ ...idleMutation }),
  useDropDbDatabase: () => ({ ...idleMutation }),
  useCreateDbUser: () => ({ ...idleMutation }),
  useDropDbUser: () => ({ ...idleMutation }),
  useSetDbUserPassword: () => ({ ...idleMutation }),
}));

vi.mock('@/hooks/use-sql-manager', () => ({
  useExecuteQuery: () => ({ ...idleMutation }),
  useListTables: () => tablesQuery,
  useTableStructure: () => ({ ...idleQuery }),
  useTableData: () => ({ ...idleQuery }),
  useRowCount: () => ({ ...idleQuery }),
  useExportDatabase: () => ({ ...idleMutation }),
  useImportSql: () => ({ ...idleMutation }),
  useImportSqlFromFile: () => ({ ...idleMutation }),
  useDatabasesWithSize: () => ({ ...idleQuery }),
  useListPvcFiles: () => ({ ...idleQuery }),
  useSqliteQuery: () => ({ ...idleMutation }),
  useSqliteTables: () => ({ ...idleQuery }),
  useSqliteTableStructure: () => ({ ...idleQuery }),
  useSqliteTableData: () => ({ ...idleQuery }),
  useSqliteRowCount: () => ({ ...idleQuery }),
  useSqliteExport: () => ({ ...idleMutation }),
  useSqliteImport: () => ({ ...idleMutation }),
}));

async function renderPage() {
  const { default: DatabaseManager } = await import('@/pages/DatabaseManager');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/databases?deploymentId=${DEPLOYMENT_ID}`]}>
        <DatabaseManager />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SQL Manager error surface', () => {
  beforeEach(() => {
    databasesQuery = { ...idleQuery, data: { data: [] } };
    usersQuery = { ...idleQuery, data: { data: [] } };
    tablesQuery = { ...idleQuery, data: { data: [] } };
  });

  it('renders an error panel when the database list fails', async () => {
    databasesQuery = {
      ...idleQuery,
      error: new Error("ERROR 1045 (28000): Access denied for user 'root'@'localhost'"),
    };

    await renderPage();

    // The failure must be visible — not collapsed into "No databases".
    expect(await screen.findByTestId('database-list-error')).toBeTruthy();
    expect(screen.queryByTestId('database-selector')).toBeNull();
  });

  it('renders an error panel when the table list fails', async () => {
    databasesQuery = { ...idleQuery, data: { data: [{ name: 'perfex' }] } };
    tablesQuery = { ...idleQuery, error: new Error('DB_EXEC_ERROR') };

    await renderPage();

    expect(await screen.findByTestId('table-list-error')).toBeTruthy();
    // "No tables found." would claim an empty database that we never read.
    expect(screen.queryByText(/No tables found/i)).toBeNull();
  });

  it('shows the normal picker when the database list genuinely succeeds', async () => {
    databasesQuery = { ...idleQuery, data: { data: [{ name: 'perfex' }] } };

    await renderPage();

    expect(await screen.findByTestId('database-selector')).toBeTruthy();
    expect(screen.queryByTestId('database-list-error')).toBeNull();
  });
});
