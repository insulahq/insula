/**
 * The admin tables that page through the server also sort through it.
 *
 * Each of these tables pages with a cursor, 20 rows (50 for the delivery log)
 * at a time. They used to sort only the page they held in the browser, so a
 * column click on page one of 140 tenants ordered those 20. Now the column is
 * sent as `sort=<field>:<asc|desc>` and the server orders the whole list —
 * and because the server refuses a cursor made under another sort
 * (INVALID_CURSOR), every sort change starts again from page one.
 *
 * Real hooks, mocked `apiFetch`: the assertions read the URL the panel sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType } from 'react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiFetch,
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

vi.mock('@/hooks/use-impersonate', () => ({
  useLoginAsTenant: () => ({ open: vi.fn(), isPending: false, error: null, isUnconfigured: false }),
}));

const cpuReading = (cpu: number) => ({
  tenantId: 'x',
  cpu: { inUse: cpu, reserved: null, available: 4 },
  memory: { inUse: 1, reserved: null, available: 100 },
  storage: { inUse: 1, reserved: null, available: 100 },
  lastUpdatedAt: '2026-10-01T00:00:00Z',
});
/** CPU in use per tenant: ascending order is t-2, t-4, t-3, t-1. */
const METRICS = { 't-1': cpuReading(3), 't-2': cpuReading(0.5), 't-3': cpuReading(2), 't-4': cpuReading(1) };
vi.mock('@/hooks/use-resource-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-resource-metrics')>()),
  useAllTenantMetrics: () => ({ data: { data: METRICS }, isLoading: false }),
}));

vi.mock('@/components/outage/TenantHealthChip', () => ({ default: () => null }));
vi.mock('@/components/CreateTenantModal', () => ({ default: () => null }));
vi.mock('@/components/BulkRunModal', () => ({ default: () => null }));

const { default: TenantsListTab } = await import('@/pages/tenants/TenantsListTab');
const { default: UsersTab } = await import('@/pages/tenants/UsersTab');
const { default: DomainsTab } = await import('@/pages/tenants/DomainsTab');
const { default: EmailAccountsTab } = await import('@/pages/tenants/EmailAccountsTab');
const { default: CronJobsTab } = await import('@/pages/tenants/CronJobsTab');
const { default: SftpUsersTab } = await import('@/pages/tenants/SftpUsersTab');
const { default: AuditLogs } = await import('@/pages/AuditLogs');
const { default: DeliveryLogTable } = await import('@/features/notifications/DeliveryLogTable');

const CREATED = '2026-09-01T00:00:00.000Z';

interface TableCase {
  readonly name: string;
  readonly Component: ComponentType;
  /** The list endpoint the table pages through. */
  readonly listPath: string;
  readonly row: (i: number) => Record<string, unknown>;
  /** The order the table opens in. */
  readonly defaultSort: string;
  /** A column to click — any but the default one. */
  readonly column: string;
  /** Every header must be a field the endpoint sorts by (else 400 INVALID_SORT_FIELD). */
  readonly serverFields: readonly string[];
  /** Headers the browser sorts instead (live values the server cannot order by). */
  readonly liveFields?: readonly string[];
  /** The control that reads the next page. */
  readonly nextTestId: string;
}

const tenantRow = (i: number) => ({
  id: `t-${i}`, name: `Tenant ${String(i).padStart(3, '0')}`, status: 'active', isSystem: false,
  planId: 'p', planName: 'Pro', nodeName: null, storageTier: 'local', placement: null,
  subscriptionExpiresAt: null, createdAt: CREATED,
});

const CASES: readonly TableCase[] = [
  {
    name: 'Tenants',
    Component: TenantsListTab,
    listPath: '/api/v1/tenants',
    row: tenantRow,
    defaultSort: 'name:asc',
    column: 'status',
    serverFields: ['name', 'status', 'storageTier', 'planName', 'subscriptionExpiresAt', 'createdAt'],
    liveFields: ['cpu', 'memory', 'storage', 'placement'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'Users',
    Component: UsersTab,
    listPath: '/api/v1/admin/tenant-users',
    row: (i) => ({
      id: `u-${i}`, email: `user${i}@example.test`, fullName: `User ${i}`, tenantId: 't-1', tenantName: 'Acme',
      roleName: 'tenant_admin', status: 'active', totpEnabled: false, lastLoginAt: null, createdAt: CREATED,
    }),
    defaultSort: 'createdAt:asc',
    column: 'email',
    serverFields: ['email', 'tenantName', 'roleName', 'status', 'lastLoginAt', 'createdAt'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'Domains',
    Component: DomainsTab,
    listPath: '/api/v1/admin/domains',
    row: (i) => ({
      id: `d-${i}`, domainName: `site${i}.example.test`, tenantId: 't-1', status: 'active', dnsMode: 'primary',
      sslAutoRenew: 1, tlsCertStatus: 'active', createdAt: CREATED,
    }),
    defaultSort: 'domainName:asc',
    // The Tenant column sorts by the tenant's name, not its id.
    column: 'tenantName',
    serverFields: ['domainName', 'tenantName', 'status', 'dnsMode', 'sslAutoRenew', 'createdAt'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'Email accounts',
    Component: EmailAccountsTab,
    listPath: '/api/v1/admin/mailboxes',
    row: (i) => ({
      id: `m-${i}`, fullAddress: `box${i}@example.test`, displayName: null, tenantId: 't-1', tenantName: 'Acme',
      mailboxType: 'mailbox', status: 'active', quotaMb: 1024, usedMb: i, aliases: [], forwardingAddresses: null,
      createdAt: CREATED,
    }),
    defaultSort: 'fullAddress:asc',
    column: 'usedMb',
    serverFields: ['fullAddress', 'tenantName', 'mailboxType', 'status', 'quotaMb', 'usedMb', 'createdAt'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'Cron jobs',
    Component: CronJobsTab,
    listPath: '/api/v1/admin/cron-jobs',
    row: (i) => ({
      id: `c-${i}`, name: `job-${i}`, tenantId: 't-1', tenantName: 'Acme', type: 'webcron', schedule: '*/5 * * * *',
      httpMethod: 'GET', url: 'https://example.test/cron', enabled: true, lastRunAt: null, lastRunStatus: null,
      createdAt: CREATED,
    }),
    defaultSort: 'name:asc',
    column: 'tenantName',
    serverFields: ['name', 'tenantName', 'type', 'schedule', 'enabled', 'lastRunAt', 'lastRunStatus', 'createdAt'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'SFTP users',
    Component: SftpUsersTab,
    listPath: '/api/v1/admin/sftp-users',
    row: (i) => ({
      id: `s-${i}`, tenantId: 't-1', tenantName: 'Acme', username: `sftp${i}`, homePath: `/home/${i}`,
      description: null, enabled: 1, lastLoginAt: null, createdAt: CREATED,
    }),
    defaultSort: 'createdAt:desc',
    column: 'username',
    serverFields: ['username', 'tenantName', 'homePath', 'enabled', 'lastLoginAt', 'createdAt'],
    nextTestId: 'pagination-next',
  },
  {
    name: 'Audit logs',
    Component: AuditLogs,
    listPath: '/api/v1/admin/audit-logs',
    row: (i) => ({
      id: `a-${i}`, tenantId: null, actionType: 'update', resourceType: 'tenant', resourceId: null, actorId: 'admin-1',
      actorType: 'user', httpMethod: 'PATCH', httpPath: '/api/v1/tenants/x', httpStatus: 200, changes: null,
      ipAddress: '192.0.2.1', createdAt: CREATED,
    }),
    defaultSort: 'createdAt:desc',
    column: 'actionType',
    serverFields: ['createdAt', 'actionType', 'resourceType', 'httpMethod', 'httpPath', 'actorId', 'ipAddress'],
    nextTestId: 'audit-logs-load-more',
  },
  {
    name: 'Notification delivery log',
    Component: DeliveryLogTable,
    listPath: '/api/v1/admin/notifications/deliveries',
    row: (i) => ({
      id: `n-${i}`, categoryId: 'backup.failed', channel: 'email', recipientHash: `hash-${i}`, status: 'sent',
      attempt: 1, maxAttempts: 3, lastError: null, queuedAt: CREATED,
    }),
    defaultSort: 'queuedAt:desc',
    column: 'attempt',
    serverFields: ['queuedAt', 'channel', 'categoryId', 'status', 'recipientHash', 'attempt', 'lastError'],
    nextTestId: 'pagination-next',
  },
];

const EMPTY = { data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 0 } };

/** Two pages of two rows: page one (no cursor) has more, the page after it is the last. */
function serve(c: Pick<TableCase, 'listPath' | 'row'>) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = new URL(url, 'http://panel.test');
    if (u.pathname !== c.listPath) return EMPTY;
    const first = !u.searchParams.has('cursor');
    const offset = first ? 0 : 2;
    return {
      data: [c.row(offset + 1), c.row(offset + 2)],
      pagination: { total_count: 4, cursor: first ? 'c-next' : null, has_more: first, page_size: 2 },
    };
  });
}

interface ListRequest { readonly sort: string | null; readonly cursor: string | null; readonly limit: string | null }

function listRequests(listPath: string): ListRequest[] {
  return apiFetch.mock.calls
    .map(([url]) => new URL(String(url), 'http://panel.test'))
    .filter((u) => u.pathname === listPath)
    .map((u) => ({ sort: u.searchParams.get('sort'), cursor: u.searchParams.get('cursor'), limit: u.searchParams.get('limit') }));
}

const lastRequest = (listPath: string): ListRequest | undefined => listRequests(listPath).at(-1);

function renderTable(Component: ComponentType) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Component /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe.each(CASES)('$name — sorted by the server', (c) => {
  it('every sortable header is a field the server sorts by', async () => {
    serve(c);
    renderTable(c.Component);
    await screen.findByTestId(`sort-${c.column}`);
    const keys = [...document.querySelectorAll('[data-testid^="sort-"]')]
      .map((el) => el.getAttribute('data-testid')!.replace(/^sort-/, ''));
    const allowed = new Set([...c.serverFields, ...(c.liveFields ?? [])]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
  });

  it('sends the column clicked, ascending then descending, each from page one', async () => {
    serve(c);
    renderTable(c.Component);
    await waitFor(() => expect(lastRequest(c.listPath)).toMatchObject({ sort: c.defaultSort, cursor: null }));

    // On to page two, under the default order.
    await waitFor(() => expect(screen.getByTestId(c.nextTestId)).not.toBeDisabled());
    fireEvent.click(screen.getByTestId(c.nextTestId));
    await waitFor(() => expect(lastRequest(c.listPath)).toMatchObject({ sort: c.defaultSort, cursor: 'c-next' }));

    // A column click asks the server for that order — and drops the cursor,
    // which belonged to the old one.
    fireEvent.click(await screen.findByTestId(`sort-${c.column}`));
    await waitFor(() => expect(lastRequest(c.listPath)).toMatchObject({ sort: `${c.column}:asc`, cursor: null }));

    // The same column again flips it.
    fireEvent.click(await screen.findByTestId(`sort-${c.column}`));
    await waitFor(() => expect(lastRequest(c.listPath)).toMatchObject({ sort: `${c.column}:desc`, cursor: null }));

    // No request ever paired a sort with a cursor made under another one.
    const requests = listRequests(c.listPath);
    const cursorRequests = requests.filter((r) => r.cursor !== null);
    expect(cursorRequests.every((r) => r.sort === c.defaultSort)).toBe(true);
  });
});

describe('Tenants — a live column', () => {
  const rowNames = (): string[] => within(screen.getByTestId('tenants-table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => (r.querySelector('td:nth-child(2) span')?.textContent ?? '').trim());

  it('reads every tenant, not a page, and orders them by the metric in the browser', async () => {
    serve({ listPath: '/api/v1/tenants', row: tenantRow });
    renderTable(TenantsListTab);
    await screen.findByTestId('tenants-table');
    // Page one only: two of the four tenants, in the server's order.
    expect(rowNames()).toEqual(['Tenant 001', 'Tenant 002']);
    const before = listRequests('/api/v1/tenants').length;

    fireEvent.click(screen.getByTestId('sort-cpu'));

    // Every page at the largest size the API allows, following the cursor.
    await waitFor(() => expect(listRequests('/api/v1/tenants').slice(before)).toEqual([
      { sort: 'name:asc', cursor: null, limit: '100' },
      { sort: 'name:asc', cursor: 'c-next', limit: '100' },
    ]));
    await waitFor(() => expect(rowNames()).toEqual(['Tenant 002', 'Tenant 004', 'Tenant 003', 'Tenant 001']));
    expect(screen.getByTestId('tenants-live-sort-note').textContent).toMatch(/CPU in use.*showing all 4 tenants/);
    expect(screen.queryByTestId('pagination-bar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sort-cpu'));
    expect(rowNames()).toEqual(['Tenant 001', 'Tenant 003', 'Tenant 004', 'Tenant 002']);

    // A server column pages again, from page one, in the server's order.
    fireEvent.click(screen.getByTestId('sort-planName'));
    await waitFor(() => expect(lastRequest('/api/v1/tenants')).toEqual({ sort: 'planName:asc', cursor: null, limit: '20' }));
    expect(await screen.findByTestId('pagination-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('tenants-live-sort-note')).not.toBeInTheDocument();
  });

  it('keeps "All" rows per page server-sorted for a server column', async () => {
    serve({ listPath: '/api/v1/tenants', row: tenantRow });
    renderTable(TenantsListTab);
    await screen.findByTestId('tenants-table');
    fireEvent.change(screen.getByTestId('page-size-select'), { target: { value: '-1' } });
    await waitFor(() => expect(lastRequest('/api/v1/tenants')).toEqual({ sort: 'name:asc', cursor: 'c-next', limit: '100' }));

    fireEvent.click(await screen.findByTestId('sort-subscriptionExpiresAt'));
    await waitFor(() => expect(listRequests('/api/v1/tenants').slice(-2)).toEqual([
      { sort: 'subscriptionExpiresAt:asc', cursor: null, limit: '100' },
      { sort: 'subscriptionExpiresAt:asc', cursor: 'c-next', limit: '100' },
    ]));
    expect(await screen.findByTestId('pagination-bar')).toHaveTextContent(/Showing 1-4 of 4/);
  });
});
