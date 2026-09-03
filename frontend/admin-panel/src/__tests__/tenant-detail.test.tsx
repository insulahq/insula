import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TenantDetail from '../pages/TenantDetail';
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

const MOCK_CLIENT = {
  data: {
    id: 'tenant-001',
    name: 'Acme Corp',
    primaryEmail: 'admin@acme.com',
    secondaryEmail: 'support@acme.com',
    status: 'active' as const,
    planId: 'plan-001',
    regionId: 'region-001',
    kubernetesNamespace: 'acme-ns',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'admin',
  },
};

const MOCK_DOMAINS = {
  data: [
    { id: 'd1', tenantId: 'tenant-001', domainName: 'acme.com', status: 'active', sslAutoRenew: 1, dnsMode: 'cname', createdAt: '2026-01-10T00:00:00Z' },
    { id: 'd2', tenantId: 'tenant-001', domainName: 'shop.acme.com', status: 'pending', sslAutoRenew: 0, dnsMode: 'primary', createdAt: '2026-01-11T00:00:00Z' },
  ],
  pagination: { total_count: 2, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_DATABASES = {
  data: [
    { id: 'db1', tenantId: 'tenant-001', name: 'acme_prod', databaseType: 'mysql', username: 'acme_usr', status: 'active', port: 3306, sizeBytes: 1048576, createdAt: '2026-01-05T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' },
  ],
  pagination: { total_count: 1, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_DEPLOYMENTS = {
  data: [
    { id: 'w1', tenantId: 'tenant-001', name: 'web-app', catalogEntryId: 'entry-1', type: 'runtime', status: 'running', replicaCount: 2, cpuRequest: '500m', memoryRequest: '256Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    { id: 'w2', tenantId: 'tenant-001', name: 'worker', catalogEntryId: 'entry-2', type: 'runtime', status: 'stopped', replicaCount: 1, cpuRequest: '250m', memoryRequest: '128Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-05T00:00:00Z', updatedAt: '2026-02-05T00:00:00Z' },
    { id: 'w3', tenantId: 'tenant-001', name: 'cron-runner', catalogEntryId: 'entry-1', type: 'service', status: 'pending', replicaCount: 1, cpuRequest: '100m', memoryRequest: '64Mi', installedVersion: null, targetVersion: null, domainName: null, createdAt: '2026-02-10T00:00:00Z', updatedAt: '2026-02-10T00:00:00Z' },
  ],
  pagination: { total_count: 3, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_BACKUPS = {
  data: [
    { id: 'b1', tenantId: 'tenant-001', backupType: 'auto', resourceType: 'database', resourceId: 'db1', storagePath: null, sizeBytes: 5242880, status: 'completed', completedAt: '2026-03-01T00:01:00Z', expiresAt: '2026-04-01T00:00:00Z', notes: null, createdAt: '2026-03-01T00:00:00Z' },
  ],
  pagination: { total_count: 1, cursor: null, has_more: false, page_size: 25 },
};

const MOCK_EMAIL_DOMAINS = { data: [] };
const MOCK_MAILBOXES = { data: [] };

function setupMockApi() {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
    if (path.includes('/databases')) return Promise.resolve(MOCK_DATABASES);
    if (path.includes('/backups')) return Promise.resolve(MOCK_BACKUPS);
    if (path.includes('/mailboxes')) return Promise.resolve(MOCK_MAILBOXES);
    if (path.includes('/email/domains')) return Promise.resolve(MOCK_EMAIL_DOMAINS);
    if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
    if (path.includes('/metrics')) return Promise.resolve({ data: { tenantId: 'tenant-001', cpu: { inUse: 0.02, reserved: 0.5, available: 2 }, memory: { inUse: 0.1, reserved: 0.5, available: 4 }, storage: { inUse: 0.001, reserved: 10, available: 50 }, lastUpdatedAt: new Date().toISOString() } });
    if (path.match(/\/tenants\/tenant-001$/)) return Promise.resolve(MOCK_CLIENT);
    return Promise.resolve({ data: [] });
  });
}

function renderTenantDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tenants/tenant-001']}>
        <Routes>
          <Route path="tenants/:id" element={<TenantDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenantDetail resource tabs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupMockApi();
  });

  it('renders all resource tabs', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('resource-tabs')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tab-domains')).toBeInTheDocument();
    expect(screen.getByTestId('tab-applications')).toBeInTheDocument();
    expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    expect(screen.getByTestId('tab-email')).toBeInTheDocument();
    expect(screen.getByTestId('tab-backups')).toBeInTheDocument();
  });

  it('shows counts in tab labels', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-domains')).toHaveTextContent('Domains (2)');
    });
    expect(screen.getByTestId('tab-deployments')).toHaveTextContent('Deployments (3)');
    expect(screen.getByTestId('tab-backups')).toHaveTextContent('Backups (1)');
  });

  it('defaults to domains tab and shows domains table', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('domains-table')).toBeInTheDocument();
    });
    expect(screen.getByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('shop.acme.com')).toBeInTheDocument();
  });

  it('switches to deployments tab on click', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-deployments'));

    await waitFor(() => {
      expect(screen.getByTestId('deployments-table')).toBeInTheDocument();
    });
    expect(screen.getByText('web-app')).toBeInTheDocument();
  });

  it('switches to deployments tab on click and shows deployment data', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-deployments')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-deployments'));

    await waitFor(() => {
      expect(screen.getByTestId('deployments-table')).toBeInTheDocument();
    });
    expect(screen.getByText('web-app')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('cron-runner')).toBeInTheDocument();
  });

  it('switches to backups tab on click', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByTestId('tab-backups')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('tab-backups'));

    await waitFor(() => {
      expect(screen.getByTestId('backups-table')).toBeInTheDocument();
    });
    expect(screen.getByText('database')).toBeInTheDocument();
  });

  it('still shows tenant account info alongside tabs', async () => {
    renderTenantDetail();

    await waitFor(() => {
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });
    expect(screen.getByText('Account Information')).toBeInTheDocument();
    expect(screen.getByTestId('resource-tabs')).toBeInTheDocument();
  });
});

describe('TenantDetail impersonation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('opens the impersonation tab at the URL configured in System Settings, not the build-time env', async () => {
    // /system-info returns an admin-chosen tenantPanelUrl. The
    // "Login as Tenant" button must use THIS value, not the runtime-config
    // fallback. A trailing slash on the configured URL must be stripped
    // so we don't produce "https://x//login".
    mockApiFetch.mockImplementation((path: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && path.includes('/impersonate/')) {
        return Promise.resolve({
          data: {
            token: 'imp-token-xyz',
            user: { id: 'user-999', email: 'admin@acme.com', role: 'tenant_admin' },
            impersonatedBy: 'super-admin',
          },
        });
      }
      if (path.includes('/system-info')) {
        return Promise.resolve({
          data: {
            platformName: 'Acme Host',
            supportEmail: null,
            supportUrl: null,
            adminPanelUrl: 'https://admin.acme.com',
            tenantPanelUrl: 'https://my.acme.com/', // trailing slash on purpose
          },
        });
      }
      if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
      if (path.includes('/backups')) return Promise.resolve(MOCK_BACKUPS);
      if (path.includes('/mailboxes')) return Promise.resolve(MOCK_MAILBOXES);
      if (path.includes('/email/domains')) return Promise.resolve(MOCK_EMAIL_DOMAINS);
      if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
      if (path.match(/\/tenants\/tenant-001$/)) return Promise.resolve(MOCK_CLIENT);
      return Promise.resolve({ data: [] });
    });

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderTenantDetail();
    await waitFor(() => {
      expect(screen.getByTestId('impersonate-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('impersonate-button'));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const openedUrl = openSpy.mock.calls[0][0] as string;
    // DB URL wins, trailing slash stripped, token + user encoded.
    expect(openedUrl).toMatch(/^https:\/\/my\.acme\.com\/login\?token=imp-token-xyz&user=/);
    expect(openedUrl).not.toContain('//login'); // double slash check
    openSpy.mockRestore();
  });
});

/**
 * Resource Limits: a field showing "Plan default" must show the PLAN's value.
 *
 * The override state is seeded once when editing starts, so it drifts from the
 * plan in two ways an operator hits immediately: type a custom value then toggle
 * back to Plan default (the disabled input kept the typed text), or move the
 * tenant to another plan (it kept the old plan's number). Both are asserted here
 * because both were reported from the real admin panel.
 */
const MOCK_PLANS_BASIC = {
  data: [
    {
      id: 'plan-001', name: 'Starter', cpuLimit: 1, memoryLimit: 2, storageLimit: 10,
      bandwidthGbLimit: 100, maxSubUsers: 3, maxMailboxes: 5, maxMailboxSizeMb: 500,
      monthlyPriceUsd: 9.99, emailHourlySendLimit: 50, emailDailySendLimit: 500,
      allowCustomContainers: false,
    },
    {
      id: 'plan-002', name: 'Pro', cpuLimit: 4, memoryLimit: 8, storageLimit: 80,
      bandwidthGbLimit: 800, maxSubUsers: 25, maxMailboxes: 50, maxMailboxSizeMb: 5000,
      monthlyPriceUsd: 49.99, emailHourlySendLimit: 500, emailDailySendLimit: 5000,
      allowCustomContainers: true,
    },
  ],
};

function setupLimitsApi(planId = 'plan-001') {
  mockApiFetch.mockImplementation((path: string) => {
    if (path.includes('/plans')) return Promise.resolve(MOCK_PLANS_BASIC);
    if (path.match(/\/tenants\/tenant-001$/)) {
      return Promise.resolve({ data: { ...MOCK_CLIENT.data, planId } });
    }
    if (path.includes('/metrics')) return Promise.resolve({ data: {} });
    return Promise.resolve({ data: [] });
  });
}

describe('TenantDetail resource limits — plan defaults', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupLimitsApi();
  });

  // Regression guard, not a demonstration: this already passed before the fix,
  // because startEditing seeds from the plan when there is no override.
  it('shows the plan value in a field left on Plan default', async () => {
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    const cpu = (await screen.findAllByRole('spinbutton'))[0] as HTMLInputElement;
    // Not overridden → the Starter plan's cpuLimit, and not editable.
    expect(cpu.value).toBe('1');
    expect(cpu.disabled).toBe(true);
  });

  // THIS is the reported bug: fails without the fix ('3.5' where '1' is due).
  it('reverts to the plan value after a custom value is typed and toggled back', async () => {
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    const cpu = (await screen.findAllByRole('spinbutton'))[0] as HTMLInputElement;

    fireEvent.click(screen.getByTestId('toggle-cpu-limit'));   // → Custom
    fireEvent.change(cpu, { target: { value: '3.5' } });
    expect(cpu.value).toBe('3.5');

    fireEvent.click(screen.getByTestId('toggle-cpu-limit'));   // → Plan default
    // The bug: this used to still read 3.5.
    expect(cpu.value).toBe('1');
    expect(cpu.disabled).toBe(true);
  });

  // Covers a FRESH mount on the new plan. It does NOT exercise the key-based
  // remount of a card that was already on screen — that path is correct by
  // React key semantics but is not asserted here; driving it needs the
  // subscription save → invalidate → refetch round trip.
  it('seeds from the new plan when the tenant is on a different one', async () => {
    const { unmount } = renderTenantDetail();
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    expect(((await screen.findAllByRole('spinbutton'))[0] as HTMLInputElement).value).toBe('1');
    unmount();

    // Same tenant, now on Pro — the card is keyed on planId, so it re-seeds.
    setupLimitsApi('plan-002');
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    await waitFor(async () => {
      expect(((await screen.findAllByRole('spinbutton'))[0] as HTMLInputElement).value).toBe('4');
    });
  });
});

/**
 * Subscription-vs-cluster surfacing.
 *
 * Production 2026-09-03: a tenant was moved to a 512 MiB storage plan while
 * still holding the 2 GiB volume created under the old plan — it was never
 * shrunk. Nothing said so. The tenant panel reports bytes WRITTEN against the
 * plan ("78.8 MB of 512Mi", reassuring) and the admin panel showed the plan
 * values straight from the DB. These assert the three columns are on screen.
 */
describe('TenantDetail namespace integrity — subscription vs cluster', () => {
  function setupIntegrityApi(report: unknown) {
    mockApiFetch.mockImplementation((path: string) => {
      if (path.includes('/namespace-integrity')) return Promise.resolve({ data: report });
      if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
      if (path.includes('/databases')) return Promise.resolve(MOCK_DATABASES);
      if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
      if (path.match(/\/tenants\/tenant-001$/)) return Promise.resolve(MOCK_CLIENT);
      return Promise.resolve({ data: [] });
    });
  }

  const ROWS = [
    { resource: 'storage', label: 'Storage', subscription: '512Mi', enforced: '512Mi', provisioned: '2Gi', exceedsSubscription: true, enforcedDiffers: false, blocked: true },
    { resource: 'cpu', label: 'CPU', subscription: '0.1', enforced: '100m', provisioned: null, exceedsSubscription: false, enforcedDiffers: false, blocked: false },
    { resource: 'memory', label: 'Memory', subscription: '102.4Mi', enforced: '107374182400m', provisioned: null, exceedsSubscription: false, enforcedDiffers: false, blocked: false },
  ];

  const OVER_PLAN = {
    tenantId: 'tenant-001', name: 'Acme Corp', namespace: 'acme-ns',
    findings: ['provisioned_exceeds_plan', 'resource_quota_exceeded'],
    repaired: [], errors: [], quota: ROWS,
  };

  beforeEach(() => { vi.resetAllMocks(); });

  it('shows subscription, enforced quota and provisioned size side by side', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();

    const detail = await screen.findByTestId('quota-mismatch-detail');
    expect(detail.textContent).toContain('Subscription');
    expect(detail.textContent).toContain('Enforced quota');
    expect(detail.textContent).toContain('Provisioned');

    const storage = await screen.findByTestId('quota-row-storage');
    expect(storage.textContent).toContain('512Mi');   // what the plan allows
    expect(storage.textContent).toContain('2Gi');     // what actually exists
    expect(storage.textContent).toContain('over plan');
  });

  it('renders every resource row, so the three columns can be compared', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();

    await screen.findByTestId('quota-mismatch-detail');
    expect(screen.getByTestId('quota-row-cpu')).toBeTruthy();
    expect(screen.getByTestId('quota-row-memory')).toBeTruthy();
  });

  it('marks only the offending row as over plan', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();

    await screen.findByTestId('quota-mismatch-detail');
    expect(screen.getByTestId('quota-row-cpu').textContent).not.toContain('over plan');
  });

  // The case that would otherwise stay invisible: the plan was lowered but the
  // quota was never re-applied, so the live quota is NOT exceeded. Comparing
  // against the subscription is the only thing that catches it.
  it('surfaces an over-plan volume even when the quota is not being exceeded', async () => {
    setupIntegrityApi({
      ...OVER_PLAN,
      findings: ['provisioned_exceeds_plan'],
      quota: [{ resource: 'storage', label: 'Storage', subscription: '512Mi', enforced: '2Gi', provisioned: '2Gi', exceedsSubscription: true, enforcedDiffers: true, blocked: false }],
    });
    renderTenantDetail();

    const storage = await screen.findByTestId('quota-row-storage');
    expect(storage.textContent).toContain('over plan');
  });

  it('does NOT offer "Run reconciler" — it cannot resize an existing volume', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();

    await screen.findByTestId('quota-mismatch-detail');
    expect(screen.queryByTestId('namespace-integrity-repair-button')).toBeNull();
  });

  it('DOES offer "Run reconciler" when a repairable finding is present too', async () => {
    setupIntegrityApi({ ...OVER_PLAN, findings: ['provisioned_exceeds_plan', 'network_policy_missing'] });
    renderTenantDetail();

    expect(await screen.findByTestId('namespace-integrity-repair-button')).toBeTruthy();
  });

  it('renders no banner at all when subscription and cluster agree', async () => {
    setupIntegrityApi({
      tenantId: 'tenant-001', name: 'Acme Corp', namespace: 'acme-ns',
      findings: [], repaired: [], errors: [],
      quota: [{ resource: 'storage', label: 'Storage', subscription: '1Gi', enforced: '1Gi', provisioned: '1Gi', exceedsSubscription: false, enforcedDiffers: false, blocked: false }],
    });
    renderTenantDetail();

    await screen.findByText('Acme Corp');
    expect(screen.queryByTestId('namespace-integrity-banner')).toBeNull();
  });
});
