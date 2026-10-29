import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CatalogEntry, Deployment } from '@/types/api';

// WHY THIS EXISTS: reported from production as "SQL Manager shows NO DATA for
// all tables, although the table sizes say there is data". The imported
// schema named its tables `1-StudentsTb`, `2-ParentsTb`, …; the
// API refused those names with a 400 and the browse panel, which read only
// `data`, rendered the refusal as "No data". In the same session the panel
// asked a freshly created database for the table selected in the previous one.

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

let tableDataQuery: MockQuery = idleQuery;
let structureQuery: MockQuery = idleQuery;
let rowCountQuery: MockQuery = idleQuery;
let createDbMutation: Record<string, unknown> = { ...idleMutation };
let executeQueryMutation: Record<string, unknown> = { ...idleMutation };
// The (database, table) the page asked for on its most recent render.
const tableDataArgs = vi.fn();

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: () => ({ tenantId: 'tenant-1', tenant: { id: 'tenant-1' } }),
}));

vi.mock('@/hooks/use-catalog', () => ({
  useCatalog: () => ({ data: { data: [mockCatalogEntry] }, isLoading: false, error: null }),
}));

vi.mock('@/hooks/use-deployments', () => ({
  useDeployments: () => ({ data: { data: [mockDeployment] }, isLoading: false, error: null }),
  useDeploymentLiveMetrics: () => ({ ...idleQuery }),
  useDbDatabases: () => ({ ...idleQuery, data: { data: [{ name: 'archive' }, { name: 'school' }] } }),
  useDbUsers: () => ({ ...idleQuery, data: { data: [] } }),
  useCreateDbDatabase: () => createDbMutation,
  useDropDbDatabase: () => ({ ...idleMutation }),
  useCreateDbUser: () => ({ ...idleMutation }),
  useDropDbUser: () => ({ ...idleMutation }),
  useSetDbUserPassword: () => ({ ...idleMutation }),
}));

vi.mock('@/hooks/use-sql-manager', () => ({
  useExecuteQuery: () => executeQueryMutation,
  useListTables: (_t: unknown, _d: unknown, database: string | undefined) => ({
    ...idleQuery,
    data: { data: database === 'school' ? ['1-StudentsTb', 'CityTb'] : ['legacy_records'] },
  }),
  useTableStructure: () => structureQuery,
  useTableData: (_t: unknown, _d: unknown, database: string | undefined, table: string | undefined) => {
    tableDataArgs(database, table);
    return tableDataQuery;
  },
  useRowCount: () => rowCountQuery,
  useExportDatabase: () => ({ ...idleMutation }),
  useImportSql: () => ({ ...idleMutation }),
  useImportSqlFromFile: () => ({ ...idleMutation }),
  useDatabasesWithSize: () => ({ ...idleQuery }),
  useListTablesWithSize: () => ({ ...idleQuery }),
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

async function openTable(name: string) {
  fireEvent.doubleClick(await screen.findByTitle(`Double-click to browse ${name}`));
  // Opening a table scrolls the results into view 50 ms later. Let that timer
  // fire inside the test, so a crash there fails THIS test instead of landing
  // as an unhandled error after it.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function lastTableDataArgs(): [string | undefined, string | undefined] {
  const calls = tableDataArgs.mock.calls;
  return calls[calls.length - 1] as [string | undefined, string | undefined];
}

describe('SQL Manager table reads', () => {
  beforeEach(() => {
    tableDataQuery = { ...idleQuery };
    structureQuery = { ...idleQuery };
    rowCountQuery = { ...idleQuery };
    createDbMutation = { ...idleMutation };
    executeQueryMutation = { ...idleMutation };
    tableDataArgs.mockClear();
  });

  it('shows why a table could not be read instead of "No data"', async () => {
    tableDataQuery = {
      ...idleQuery,
      error: Object.assign(new Error('Invalid table name'), { code: 'INVALID_TABLE_NAME', status: 400 }),
    };
    rowCountQuery = { ...idleQuery, error: new Error('Invalid table name') };

    await renderPage();
    fireEvent.change(await screen.findByTestId('database-selector'), { target: { value: 'school' } });
    await openTable('1-StudentsTb');

    expect((await screen.findByTestId('table-data-error')).textContent).toMatch(/Invalid table name/);
    expect(screen.queryByText('No data')).toBeNull();
  });

  it('shows an inline engine error carried in a 200 result', async () => {
    tableDataQuery = {
      ...idleQuery,
      data: { data: { columns: [], rows: [], rowCount: 0, executionTimeMs: 1, error: "Table 'school.gone' doesn't exist" } },
    };

    await renderPage();
    await openTable('legacy_records');

    expect((await screen.findByTestId('table-data-error')).textContent).toMatch(/doesn't exist/);
  });

  it('keeps the rows but warns when only the row count failed', async () => {
    tableDataQuery = {
      ...idleQuery,
      data: { data: { columns: ['CITYID', 'CITY'], rows: [['1', 'Northfield']], rowCount: 1, executionTimeMs: 1 } },
    };
    rowCountQuery = { ...idleQuery, error: new Error('DB_EXEC_ERROR') };

    await renderPage();
    await openTable('legacy_records');

    expect(await screen.findByText('Northfield')).toBeTruthy();
    expect(screen.getByTestId('table-row-count-error')).toBeTruthy();
  });

  it('shows why a table structure could not be read', async () => {
    structureQuery = { ...idleQuery, error: new Error("Table 'school.gone' doesn't exist") };

    await renderPage();
    fireEvent.contextMenu(await screen.findByTestId('table-row-legacy_records'));
    fireEvent.click(await screen.findByTestId('table-structure-legacy_records'));

    expect((await screen.findByTestId('table-structure-error')).textContent).toMatch(/doesn't exist/);
  });

  it('forgets the selected table when a new database is created', async () => {
    createDbMutation = {
      ...idleMutation,
      mutate: (_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    };

    await renderPage();
    await openTable('legacy_records');
    expect(lastTableDataArgs()).toEqual(['archive', 'legacy_records']);

    fireEvent.click(screen.getByTestId('create-database-button'));
    fireEvent.change(screen.getByTestId('new-database-name-input'), { target: { value: 'courses' } });
    fireEvent.click(screen.getByTestId('confirm-create-database'));

    // Before: ['courses', 'legacy_records'] — a table the new database never had.
    expect(lastTableDataArgs()).toEqual(['courses', undefined]);
    expect(tableDataArgs.mock.calls).not.toContainEqual(['courses', 'legacy_records']);
    // The Browse tab went with the table; the pane is back on the query tab.
    expect(screen.getByText('Run a query to see results')).toBeTruthy();
  });

  // Already true before the fix (the picker cleared the table itself); kept so
  // the selectDatabase() funnel cannot lose this path.
  it('forgets the selected table when another database is picked', async () => {
    await renderPage();
    await openTable('legacy_records');

    fireEvent.change(screen.getByTestId('database-selector'), { target: { value: 'school' } });

    expect(lastTableDataArgs()).toEqual(['school', undefined]);
    expect(tableDataArgs.mock.calls).not.toContainEqual(['school', 'legacy_records']);
  });
});

describe('SQL Manager row edits', () => {
  const sent: string[] = [];
  const browseRow = (path: string) => ({
    ...idleQuery,
    data: { data: { columns: ['id', 'path'], rows: [['1', path]], rowCount: 1, executionTimeMs: 1 } },
  });
  const pkStructure = {
    ...idleQuery,
    data: { data: [
      { name: 'id', type: 'int(11)', nullable: false, defaultValue: null, key: 'PRI' },
      { name: 'path', type: 'varchar(80)', nullable: true, defaultValue: null, key: '' },
    ] },
  };
  // Answer every executed statement with the given inline result.
  const answerWith = (result: Record<string, unknown>) => ({
    ...idleMutation,
    mutate: (vars: { query: string }, opts?: { onSuccess?: (res: unknown) => void }) => {
      sent.push(vars.query);
      opts?.onSuccess?.({ data: { columns: [], rows: [], rowCount: 1, executionTimeMs: 1, ...result } });
    },
  });

  beforeEach(() => {
    sent.length = 0;
    rowCountQuery = { ...idleQuery, data: { data: { count: 1 } } };
    structureQuery = pkStructure;
    createDbMutation = { ...idleMutation };
    tableDataArgs.mockClear();
  });

  async function editPath(to: string) {
    await renderPage();
    await openTable('legacy_records');
    fireEvent.click(await screen.findByTestId('edit-row-0'));
    fireEvent.change(screen.getByTestId('edit-field-path'), { target: { value: to } });
    fireEvent.click(screen.getByTestId('save-edit-row'));
  }

  // MariaDB reads `\n` inside a literal as a newline: the value used to be
  // stored as `C:`, a newline and `ew`.
  it('writes a backslash in a MariaDB value as a backslash', async () => {
    tableDataQuery = browseRow('old');
    executeQueryMutation = answerWith({});

    await editPath('C:\\new');

    expect(sent).toEqual(["UPDATE `legacy_records` SET `path` = 'C:\\\\new' WHERE `id` = '1'"]);
  });

  it('keeps the edit open and shows why when the database refuses it', async () => {
    tableDataQuery = browseRow('old');
    executeQueryMutation = answerWith({ error: "ERROR 1406 (22001): Data too long for column 'path' at row 1" });

    await editPath('x'.repeat(200));

    expect(await screen.findByText(/Data too long for column 'path'/)).toBeTruthy();
    expect(screen.getByTestId('edit-row-form')).toBeTruthy();
  });
});
