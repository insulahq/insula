import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TenantDetail from '../pages/TenantDetail';
import TenantDeletedBanner from '@/components/tenants/TenantDeletedBanner';
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
    planName: 'Starter',
    regionId: 'region-001',
    kubernetesNamespace: 'acme-ns',
    provisioningStatus: 'provisioned',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'admin',
    createdByName: 'Ada Admin',
  },
};

const PAGE = { total_count: 0, cursor: null, has_more: false, page_size: 25 };

const MOCK_DOMAINS = {
  data: [
    { id: 'd1', tenantId: 'tenant-001', domainName: 'acme.com', status: 'active', sslAutoRenew: 1, dnsMode: 'cname', createdAt: '2026-01-10T00:00:00Z' },
    { id: 'd2', tenantId: 'tenant-001', domainName: 'shop.acme.com', status: 'pending', sslAutoRenew: 0, dnsMode: 'primary', createdAt: '2026-01-11T00:00:00Z' },
  ],
  pagination: { ...PAGE, total_count: 2 },
};

const MOCK_DEPLOYMENTS = {
  data: [
    { id: 'w1', tenantId: 'tenant-001', name: 'web-app', type: 'runtime', status: 'running', source: 'catalog', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    { id: 'w2', tenantId: 'tenant-001', name: 'my-image', type: 'custom', status: 'running', source: 'custom', customSpec: { allowRoot: false }, createdAt: '2026-02-05T00:00:00Z', updatedAt: '2026-02-05T00:00:00Z' },
  ],
  pagination: { ...PAGE, total_count: 2 },
};

const MOCK_BUNDLES = {
  data: [
    {
      id: 'bundle-1', tenantId: 'tenant-001', tenantStatus: 'active', tenantName: 'Acme Corp',
      initiator: 'system', systemTrigger: 'scheduled', status: 'completed',
      targetKind: 's3', targetUri: 's3://tenant/acme', targetConfigId: null,
      label: null, description: null, sizeBytes: 5242880, retentionDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), exportMode: null, exportArtifact: null,
      startedAt: '2026-03-01T00:00:00Z', finishedAt: '2026-03-01T00:01:00Z',
      lastError: null,
    },
  ],
  pagination: { ...PAGE, total_count: 1, page_size: 50 },
};

const MOCK_EMAIL_DOMAINS = {
  data: [{ id: 'ed1', domainId: 'd1', tenantId: 'tenant-001', domainName: 'acme.com', enabled: 1, mxProvisioned: 1, spfProvisioned: 1, dkimProvisioned: 1, dmarcProvisioned: 0, createdAt: '2026-01-10T00:00:00Z' }],
};
const MOCK_MAILBOXES = {
  data: [
    { id: 'm1', emailDomainId: 'ed1', tenantId: 'tenant-001', localPart: 'info', fullAddress: 'info@acme.com', displayName: 'Front desk', quotaMb: 2048, usedMb: 512, status: 'active', mailboxType: 'mailbox', aliases: ['hello@acme.com'], forwardingAddresses: ['ops@elsewhere.test'], autoReply: 0, autoReplySubject: null, createdAt: '2026-01-10T00:00:00Z' },
  ],
};
const MOCK_ALIASES = {
  data: [{ id: 'a1', emailDomainId: 'ed1', tenantId: 'tenant-001', sourceAddress: 'team@acme.com', destinationAddresses: ['info@acme.com', 'boss@acme.com'], enabled: 1, createdAt: '2026-01-10T00:00:00Z' }],
};
const MOCK_JOBS = {
  data: [
    { id: 'j1', tenantId: 'tenant-001', mailboxId: 'm1', mailboxAddress: 'info@acme.com', sourceHost: 'imap.old.test', sourcePort: 993, sourceUsername: 'info', sourceSsl: true, options: {}, status: 'failed', k8sJobName: null, k8sNamespace: 'acme-ns', logTail: null, errorMessage: 'Login refused by the source server', startedAt: '2026-03-01T00:00:00Z', finishedAt: '2026-03-01T00:02:00Z', createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-01T00:02:00Z' },
  ],
};

const MOCK_TRAFFIC = {
  from: '2026-09-30T00:00:00.000Z', to: '2026-10-07T00:00:00.000Z', stepSeconds: 3600,
  times: ['2026-10-06T00:00:00.000Z', '2026-10-06T01:00:00.000Z'], unit: 'bytes', resolution: 'fine',
  othersFolded: 0, clamped: false,
  series: [
    { key: 'out', name: 'Outbound', kind: 'direction', points: [1_000_000, 1_000_000] },
    { key: 'in', name: 'Inbound', kind: 'direction', points: [500_000, 500_000] },
  ],
};

const MOCK_PLANS = {
  data: [
    {
      id: 'plan-001', code: 'starter', name: 'Starter', status: 'active', cpuLimit: '1', cpuTier: null, cpuBurstCores: '2', memoryLimit: '2', storageLimit: '10',
      bandwidthGbLimit: 100, maxSubUsers: 3, maxMailboxes: 5, maxMailboxSizeMb: 500,
      monthlyPriceUsd: '9.99', emailHourlySendLimit: 50, emailDailySendLimit: 500, allowCustomContainers: false,
    },
    {
      id: 'plan-002', code: 'pro', name: 'Pro', status: 'active', cpuLimit: '4', cpuTier: null, cpuBurstCores: '4', memoryLimit: '8', storageLimit: '80',
      bandwidthGbLimit: 800, maxSubUsers: 25, maxMailboxes: 50, maxMailboxSizeMb: 5000,
      monthlyPriceUsd: '49.99', emailHourlySendLimit: 500, emailDailySendLimit: 5000, allowCustomContainers: true,
    },
  ],
};

type Handler = (path: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined;

/** The page's every read, answered; `extra` is asked first. */
function setupMockApi(tenant: Record<string, unknown> = MOCK_CLIENT.data, extra?: Handler) {
  mockApiFetch.mockImplementation(((path: string, init?: { method?: string; body?: string }) => {
    const own = extra?.(path, init);
    if (own) return own;
    if (path.includes('/system-info')) return Promise.resolve({ data: { platformName: 'Acme Host', tenantPanelUrl: 'https://my.acme.com/', currency: 'USD' } });
    if (path.includes('/plans')) return Promise.resolve(MOCK_PLANS);
    if (path.includes('/deployments')) return Promise.resolve(MOCK_DEPLOYMENTS);
    if (path.includes('/tenant-bundles')) return Promise.resolve(MOCK_BUNDLES);
    if (path.includes('/mail/usage')) return Promise.resolve({ data: { hour: { used: 0, limit: 10 }, day: { used: 2, limit: 50, recipients: 3, rateLimited: 0, quotaRejected: 0 }, suspended: false, outboundSuspended: false } });
    if (path.includes('/mail/daily')) return Promise.resolve({ data: { days: [{ date: '2026-10-18', sent: 4, recipients: 4, rateLimited: 1, quotaRejected: 0 }, { date: '2026-10-19', sent: 2, recipients: 3, rateLimited: 0, quotaRejected: 0 }] } });
    if (path.includes('/mail/domain-stats')) return Promise.resolve({ data: { windowDays: 7, domains: [{ domain: 'acme.com', emailHosted: true, sent24h: 2, sent7d: 6, recipients7d: 7, rateLimited7d: 1, quotaRejected7d: 0 }] } });
    if (path.includes('/mail/dmarc')) return Promise.resolve({ data: { windowDays: 30, domains: [], intakeLocalPart: 'dmarc' } });
    if (path.includes('/mail/tls-reports')) return Promise.resolve({ data: { windowDays: 30, reports: [], total: 0, totalSuccessfulSessions: 0, totalFailedSessions: 0, successRate: null, intakeLocalPart: 'tls' } });
    if (path.includes('/mail/abuse-reports')) return Promise.resolve({ data: { windowDays: 30, reports: [], total: 0, intakeLocalPart: 'abuse' } });
    if (path.includes('/send-limits/live')) return Promise.resolve({ data: { checkedAt: '2026-10-19T15:02:00Z', reachable: true, domains: [{ domain: 'acme.com', desired: { hourly: 10, daily: 50, blocked: false }, live: { hourly: 10, daily: 50, backlog: 50, blocked: false, duplicates: 0 }, inEffect: true }] } });
    if (path.includes('/mail/imapsync')) return Promise.resolve(MOCK_JOBS);
    if (path.includes('/email/aliases')) return Promise.resolve(MOCK_ALIASES);
    if (path.includes('/mailboxes')) return Promise.resolve(MOCK_MAILBOXES);
    if (path.includes('/email/domains')) return Promise.resolve(MOCK_EMAIL_DOMAINS);
    if (path.includes('/domains')) return Promise.resolve(MOCK_DOMAINS);
    if (path.includes('/bandwidth')) return Promise.resolve({ data: { usedGb: 12, limitGb: 100, usedPct: 12, capped: false, cycleStart: null, source: 'plan' } });
    if (path.includes('/metrics')) return Promise.resolve({ data: { tenantId: 'tenant-001', cpu: { inUse: 0.02, reserved: 0.5, available: 2 }, memory: { inUse: 0.1, reserved: 0.5, available: 4 }, storage: { inUse: 1, reserved: 10, available: 10 }, lastUpdatedAt: new Date().toISOString() } });
    if (path.includes('/traffic/series')) return Promise.resolve({ data: MOCK_TRAFFIC });
    if (path.includes('/traffic/subjects')) return Promise.resolve({ data: { subjects: [] } });
    if (path.includes('/cpu-migration/preview')) return Promise.resolve({ data: { tenants: [] } });
    if (path.includes('/placement')) return Promise.resolve({ data: { placement: null, failovers: [] } });
    if (path.includes('/audit-logs')) return Promise.resolve({ data: [], pagination: PAGE });
    if (path.includes('/snapshots')) return Promise.resolve({ data: { snapshots: [], expiryHours: 72 } });
    if (path.match(/\/tenants\/tenant-001$/)) return Promise.resolve({ data: tenant });
    return Promise.resolve({ data: [], pagination: PAGE });
  }) as never);
}

/** A button that navigates the in-memory router, standing in for a search result or link. */
function GoTo({ to, label = 'go-to-other-tenant' }: { readonly to: string; readonly label?: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>{label}</button>;
}

function renderTenantDetail(path = '/tenants/tenant-001', withGoTo?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {withGoTo && <GoTo to={withGoTo} />}
        <Routes>
          <Route path="tenants/:id/:tab?" element={<TenantDetail />} />
          <Route path="tenants/list" element={<TenantDeletedBanner />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastPatch = (): Record<string, unknown> | undefined => {
  const patch = mockApiFetch.mock.calls
    .map(([, init]) => init as { method?: string; body?: string } | undefined)
    .filter((i) => i?.method === 'PATCH')
    .pop();
  return patch ? JSON.parse(patch.body ?? '{}') : undefined;
};

describe('TenantDetail — sections', () => {
  beforeEach(() => { vi.resetAllMocks(); setupMockApi(); });

  it('offers the six sections and opens on Overview', async () => {
    renderTenantDetail();
    const tabs = await screen.findByTestId('tenant-tabs');
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(
      ['Overview', 'Email', 'Traffic', 'Storage & backups', 'Plan & limits', 'Activity'],
    );
    expect(screen.getByTestId('tab-overview')).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByTestId('tenant-overview')).toBeInTheDocument();
  });

  it('lands on Overview from an old tab address instead of a blank page', async () => {
    renderTenantDetail('/tenants/tenant-001/deployments');
    expect(await screen.findByTestId('tenant-overview')).toBeInTheDocument();
  });

  it('switches section on click', async () => {
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tab-email'));
    expect(await screen.findByTestId('email-tab')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tab-storage'));
    expect(await screen.findByTestId('tenant-storage')).toBeInTheDocument();
  });

  it('keeps the email out of the header and labels primary / secondary in the account card', async () => {
    renderTenantDetail();
    const contact = await screen.findByTestId('tenant-contact-email');
    expect(contact).toHaveTextContent('Primary:admin@acme.com');
    expect(contact).toHaveTextContent('Secondary:support@acme.com');
    expect(within(screen.getByTestId('tenant-header')).queryByText('admin@acme.com')).toBeNull();
  });

  it('names the plan from the plan list when the tenant read does not carry it', async () => {
    // GET /tenants/:id leaves planName empty — only list rows fill it.
    setupMockApi({ ...MOCK_CLIENT.data, planName: null, planId: 'plan-002' });
    renderTenantDetail();
    await waitFor(() => expect(screen.getByTestId('tenant-plan-link')).toHaveTextContent('Pro plan'));
  });

  it('names the creating user instead of showing an id', async () => {
    renderTenantDetail();
    expect(await screen.findByTestId('tenant-created-by')).toHaveTextContent('Ada Admin');
  });

  it('lists domains and applications in two tables, each linking into the tenant panel', async () => {
    renderTenantDetail();
    const domains = await screen.findByTestId('domains-card');
    const table = await within(domains).findByTestId('domains-table');
    expect(within(table).getByText('acme.com').closest('button')).toHaveAttribute('data-tenant-panel-path', '/domains/d1');
    expect(within(domains).getByTestId('tp-domains')).toHaveAttribute('data-tenant-panel-path', '/domains');
    // Applications are their own table, not a block under the domains.
    expect(within(domains).queryByTestId('applications-list')).toBeNull();
    const apps = await screen.findByTestId('applications-card');
    expect(await within(apps).findByTestId('application-w1')).toHaveTextContent('web-app');
    expect(within(apps).getByTestId('tp-applications')).toHaveAttribute('data-tenant-panel-path', '/applications/installed');
    expect(screen.queryByTestId('websites-card')).toBeNull();
  });

  it('keeps the root switch for a custom container — the one application control that is the operator’s', async () => {
    renderTenantDetail();
    expect(await screen.findByTestId('allow-root-w2')).toHaveTextContent('Root OFF');
    expect(screen.queryByTestId('allow-root-w1')).toBeNull();
  });
});

describe('TenantDetail — into the tenant panel', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function impersonating(): void {
    setupMockApi(MOCK_CLIENT.data, (path, init) => (init?.method === 'POST' && path.includes('/impersonate/')
      ? Promise.resolve({ data: { token: 'imp-token-xyz', user: { id: 'user-999', email: 'admin@acme.com', role: 'tenant_admin' }, impersonatedBy: 'super-admin' } })
      : undefined));
  }

  it('opens "Login as tenant" at the URL configured in System Settings, not the build-time env', async () => {
    impersonating();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('impersonate-button'));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const url = openSpy.mock.calls[0]![0] as string;
    expect(url).toMatch(/^https:\/\/my\.acme\.com\/login\?token=imp-token-xyz&user=/);
    expect(url).not.toContain('//login');
    expect(url).not.toContain('next=');
    openSpy.mockRestore();
  });

  it('lands a management link on the page it was about', async () => {
    impersonating();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderTenantDetail('/tenants/tenant-001/email');
    fireEvent.click(await screen.findByTestId('tp-mailbox-m1'));
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const url = new URL(openSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get('next')).toBe('/email/mailboxes?emailDomain=ed1&mailbox=m1');
    openSpy.mockRestore();
  });
});

describe('TenantDetail — Email', () => {
  beforeEach(() => { vi.resetAllMocks(); setupMockApi(); });

  it('says the mail server holds the limits, when it does', async () => {
    renderTenantDetail('/tenants/tenant-001/email');
    await waitFor(() => expect(screen.getByTestId('send-limits-live')).toHaveTextContent('The mail server holds exactly these limits'));
  });

  it('shows aliases, forwarding and mailing lists', async () => {
    renderTenantDetail('/tenants/tenant-001/email');
    const row = await screen.findByTestId('mailbox-m1');
    expect(row).toHaveTextContent('hello@acme.com');
    expect(row).toHaveTextContent('ops@elsewhere.test');
    const list = await screen.findByTestId('mailing-list-a1');
    expect(list).toHaveTextContent('team@acme.com');
    expect(list).toHaveTextContent('boss@acme.com');
  });

  it('offers Edit and Delete on a finished migration — both in the tenant panel', async () => {
    renderTenantDetail('/tenants/tenant-001/email');
    expect(await screen.findByTestId('tp-migration-edit-j1')).toHaveAttribute('data-tenant-panel-path', '/email/mailboxes?emailDomain=ed1&migration=j1&action=edit');
    // Delete lands on the job; the delete itself is pressed there, never from a URL.
    expect(screen.getByTestId('tp-migration-delete-j1')).toHaveAttribute('data-tenant-panel-path', '/email/mailboxes?emailDomain=ed1&migration=j1');
    expect(screen.getByTestId('migration-j1')).toHaveTextContent('Login refused by the source server');
  });

  it('suspends outbound mail only after a second click', async () => {
    renderTenantDetail('/tenants/tenant-001/email');
    fireEvent.click(await screen.findByTestId('toggle-outbound-suspend'));
    expect(lastPatch()).toBeUndefined();
    fireEvent.click(screen.getByTestId('confirm-outbound-toggle'));
    await waitFor(() => expect(lastPatch()).toEqual({ email_outbound_suspended: true }));
  });
});

/**
 * Plan & limits. A limit shown on the plan must show the PLAN's value, and the
 * PATCH must carry only what changed: null for "back on the plan" or an empty
 * Custom box, a number — including 0 — otherwise.
 */
describe('TenantDetail — Plan & limits', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  async function openLimits(tenant: Record<string, unknown> = MOCK_CLIENT.data) {
    setupMockApi(tenant);
    renderTenantDetail('/tenants/tenant-001/limits');
    return screen.findByTestId('edit-limits-button');
  }

  async function review() {
    fireEvent.click(screen.getByTestId('limits-review'));
    return screen.findByTestId('limits-review-dialog');
  }

  it('shows the plan value for a limit left on the plan', async () => {
    await openLimits();
    expect(await screen.findByTestId('limit-value-mailboxes')).toHaveTextContent('5');
    expect(screen.getByTestId('limit-mailboxes')).toHaveTextContent('Plan');
  });

  it('shows the new plan’s values when the tenant is on another plan', async () => {
    await openLimits({ ...MOCK_CLIENT.data, planId: 'plan-002' });
    expect(await screen.findByTestId('limit-value-mailboxes')).toHaveTextContent('50');
  });

  it('sends max_mailboxes_override: 0 — and nothing else — when the operator types 0', async () => {
    fireEvent.click(await openLimits());
    fireEvent.click(screen.getByTestId('limit-custom-mailboxes'));
    fireEvent.change(screen.getByTestId('value-mailboxes'), { target: { value: '0' } });
    const dialog = await review();
    expect(dialog).toHaveTextContent('0 disables email for this tenant');
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ max_mailboxes_override: 0 }));
  });

  it('treats an empty or whitespace Custom box as no override — not 0 — so nothing is sent', async () => {
    fireEvent.click(await openLimits());
    fireEvent.click(screen.getByTestId('limit-custom-sends-per-hour'));
    fireEvent.change(screen.getByTestId('value-sends-per-hour'), { target: { value: '   ' } });
    expect(screen.getByTestId('limits-review')).toBeDisabled();
    expect(screen.getByTestId('limits-change-bar')).toHaveTextContent('no changes yet');
  });

  it('sends null when a custom limit is put back on the plan', async () => {
    fireEvent.click(await openLimits({ ...MOCK_CLIENT.data, emailSendRateLimit: 10 }));
    fireEvent.click(screen.getByTestId('limit-plan-sends-per-hour'));
    await review();
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ email_send_rate_limit: null }));
  });

  it('puts every limit back on the plan in one step', async () => {
    fireEvent.click(await openLimits({ ...MOCK_CLIENT.data, emailSendRateLimit: 10, maxMailboxesOverride: 3 }));
    fireEvent.click(screen.getByTestId('limits-all-to-plan'));
    await review();
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ email_send_rate_limit: null, max_mailboxes_override: null }));
  });

  it('discarding forgets the edits and shows the saved values again', async () => {
    fireEvent.click(await openLimits());
    fireEvent.click(screen.getByTestId('limit-custom-mailboxes'));
    fireEvent.change(screen.getByTestId('value-mailboxes'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('limits-discard'));
    expect(await screen.findByTestId('limit-value-mailboxes')).toHaveTextContent('5');
    expect(lastPatch()).toBeUndefined();
  });

  it('shows the saved CPU tier before anyone clicks Edit', async () => {
    await openLimits({ ...MOCK_CLIENT.data, cpuTierOverride: 'highest' });
    expect(await screen.findByTestId('limit-value-tier')).toHaveTextContent('Highest');
    expect(screen.queryByTestId('tenant-cpu-tier')).toBeNull();
  });

  it('says plainly that the CPU tier is not in effect for a legacy tenant', async () => {
    await openLimits();
    expect(await screen.findByTestId('limit-status-tier')).toHaveTextContent(/not in effect/i);
  });

  it('sends the chosen tier, and says it waits for Re-apply on a tiered tenant', async () => {
    fireEvent.click(await openLimits({ ...MOCK_CLIENT.data, cpuSchedulingMode: 'tiered' }));
    fireEvent.click(screen.getByTestId('limit-custom-cpu-tier'));
    fireEvent.change(await screen.findByTestId('tenant-cpu-tier'), { target: { value: 'highest' } });
    const dialog = await review();
    expect(dialog).toHaveTextContent('Re-apply');
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ cpu_tier_override: 'highest' }));
  });

  it('sends the burst ceiling override on save', async () => {
    fireEvent.click(await openLimits());
    fireEvent.click(screen.getByTestId('limit-custom-burst-ceiling'));
    fireEvent.change(screen.getByTestId('value-burst-ceiling'), { target: { value: '3' } });
    await review();
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ cpu_burst_cores_override: 3 }));
  });

  it('does not re-send untouched custom limits the API returns as "20.00"', async () => {
    fireEvent.click(await openLimits({ ...MOCK_CLIENT.data, storageLimitOverride: '20.00', cpuLimitOverride: '0.50', monthlyPriceOverride: '9.90' }));
    fireEvent.click(screen.getByTestId('limit-custom-mailboxes'));
    fireEvent.change(screen.getByTestId('value-mailboxes'), { target: { value: '7' } });
    await review();
    fireEvent.click(screen.getByTestId('save-limits-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ max_mailboxes_override: 7 }));
  });

  it('drops the edits when the page moves to another tenant on the same plan', async () => {
    // The bug needs the other tenant ALREADY loaded: a first visit shows the
    // loading state, which unmounts everything and hides it. So: visit B, go
    // to A and edit, then back to B — served from cache, the page stays
    // mounted, and only a per-tenant key drops A's drafts.
    setupMockApi(MOCK_CLIENT.data, (path) => (path.match(/\/tenants\/tenant-002$/)
      ? Promise.resolve({ data: { ...MOCK_CLIENT.data, id: 'tenant-002', name: 'Beta Ltd' } })
      : undefined));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tenants/tenant-002/limits']}>
          <GoTo to="/tenants/tenant-001/limits" label="to-a" />
          <GoTo to="/tenants/tenant-002/limits" label="to-b" />
          <Routes><Route path="tenants/:id/:tab?" element={<TenantDetail />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Beta Ltd')).toBeInTheDocument();
    fireEvent.click(screen.getByText('to-a'));
    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    fireEvent.click(screen.getByTestId('limit-custom-mailboxes'));
    fireEvent.change(screen.getByTestId('value-mailboxes'), { target: { value: '9' } });
    expect(screen.getByTestId('limits-change-bar')).toHaveTextContent('1 change');
    fireEvent.click(screen.getByText('to-b'));
    expect(await screen.findByText('Beta Ltd')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('limits-change-bar')).toBeNull());
    expect(screen.getByTestId('edit-limits-button')).toBeInTheDocument();
  });

  it('confirms a shrink separately and sends every change again with it', async () => {
    let first = true;
    const { ApiError } = await import('@/lib/api-client');
    setupMockApi({ ...MOCK_CLIENT.data, storageLimitOverride: '20' }, (path, init) => {
      if (init?.method !== 'PATCH' || !/\/tenants\/tenant-001$/.test(path)) return undefined;
      if (first) {
        first = false;
        const err = new ApiError(409, 'STORAGE_RESIZE_REQUIRED', 'Shrinking needs a resize') as Error & { details?: unknown };
        err.details = { targetMib: 15360, targetGi: 15, currentGi: 20, remediation: 'Shrinking replaces the volume.' };
        return Promise.reject(err);
      }
      return Promise.resolve({ data: { ...MOCK_CLIENT.data, storageShrinkOperationId: null } });
    });
    renderTenantDetail('/tenants/tenant-001/limits');
    fireEvent.click(await screen.findByTestId('edit-limits-button'));
    fireEvent.change(screen.getByTestId('value-storage'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('limit-custom-mailboxes'));
    fireEvent.change(screen.getByTestId('value-mailboxes'), { target: { value: '7' } });
    await review();
    fireEvent.click(screen.getByTestId('save-limits-button'));
    fireEvent.click(await screen.findByTestId('shrink-confirm-button'));
    await waitFor(() => expect(lastPatch()).toEqual({ storage_limit_override: 15, max_mailboxes_override: 7, confirm_destructive_shrink: true }));
  });
});

describe('TenantDetail — Storage & backups', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('marks the ACTIVE node and the PINNED node apart when the tenant runs away from its pin', async () => {
    setupMockApi({ ...MOCK_CLIENT.data, nodeName: 'node-2' }, (path) => (path.includes('/placement')
      ? Promise.resolve({ data: { placement: { tenantId: 'tenant-001', status: 'misplaced', primaryNode: 'node-2', workloadNodes: ['node-3'], attachedNodes: ['node-3'], dataNodes: ['node-2'], actualNodes: ['node-3'], reasons: ['running on node-3'], misplacedSince: '2026-10-19T01:12:00Z', checkedAt: '2026-10-19T14:00:00Z' }, failovers: [] } })
      : undefined));
    renderTenantDetail('/tenants/tenant-001/storage');
    expect(await screen.findByTestId('placement-node-node-3')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('placement-node-node-3')).not.toHaveAttribute('data-pinned');
    expect(screen.getByTestId('placement-node-node-2')).toHaveAttribute('data-pinned', 'true');
    expect(screen.getByTestId('placement-node-node-2')).not.toHaveAttribute('data-active');
    expect(screen.getByTestId('placement-misplaced-banner')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-placement-chip')).toHaveTextContent('Running on node-3 · pinned to node-2');
    // DATA is a solid blue pill with white text, on the node holding the data
    // only — and in the legend.
    const dataPill = within(screen.getByTestId('placement-node-node-2')).getByTestId('data-badge');
    expect(dataPill).toHaveTextContent('DATA');
    expect(dataPill).toHaveClass('bg-blue-600', 'text-white');
    expect(within(screen.getByTestId('placement-node-node-3')).queryByTestId('data-badge')).toBeNull();
  });

  it('lists snapshots and sends the operator to the tenant panel to take or restore one', async () => {
    setupMockApi();
    renderTenantDetail('/tenants/tenant-001/storage');
    expect(await screen.findByTestId('tp-snapshots')).toHaveAttribute('data-tenant-panel-path', '/snapshots');
  });
});

describe('TenantDetail namespace integrity — subscription vs cluster', () => {
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
  function setupIntegrityApi(report: unknown) {
    setupMockApi(MOCK_CLIENT.data, (path) => (path.includes('/namespace-integrity') ? Promise.resolve({ data: report }) : undefined));
  }

  beforeEach(() => { vi.resetAllMocks(); });

  it('shows subscription, enforced quota and provisioned size side by side', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();
    const detail = await screen.findByTestId('quota-mismatch-detail');
    expect(detail.textContent).toContain('Subscription');
    expect(detail.textContent).toContain('Enforced quota');
    expect(detail.textContent).toContain('Provisioned');
    const storage = await screen.findByTestId('quota-row-storage');
    expect(storage.textContent).toContain('512Mi');
    expect(storage.textContent).toContain('2Gi');
    expect(storage.textContent).toContain('over plan');
  });

  it('marks only the offending row as over plan', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();
    await screen.findByTestId('quota-mismatch-detail');
    expect(screen.getByTestId('quota-row-cpu').textContent).not.toContain('over plan');
    expect(screen.getByTestId('quota-row-memory')).toBeTruthy();
  });

  it('does NOT offer "Run reconciler" — it cannot resize an existing volume', async () => {
    setupIntegrityApi(OVER_PLAN);
    renderTenantDetail();
    await screen.findByTestId('quota-mismatch-detail');
    expect(screen.queryByTestId('namespace-integrity-repair-button')).toBeNull();
  });

  it('renders no banner at all when subscription and cluster agree', async () => {
    setupIntegrityApi({
      tenantId: 'tenant-001', name: 'Acme Corp', namespace: 'acme-ns',
      findings: [], repaired: [], errors: [],
      quota: [{ resource: 'storage', label: 'Storage', subscription: '1Gi', enforced: '1Gi', provisioned: '1Gi', exceedsSubscription: false, enforcedDiffers: false, blocked: false }],
    });
    renderTenantDetail();
    await screen.findByTestId('tenant-overview');
    expect(screen.queryByTestId('namespace-integrity-banner')).toBeNull();
  });
});

describe('TenantDetail delete', () => {
  function setupDelete(outcome: 'ok' | 'fail') {
    let deleted = false;
    setupMockApi(MOCK_CLIENT.data, (path, init) => {
      if (init?.method === 'DELETE' && path.startsWith('/api/v1/tenants/tenant-001')) {
        if (outcome === 'fail') return Promise.reject(new Error('Namespace deletion is blocked'));
        deleted = true;
        return Promise.resolve({ data: { transitionId: 'tx-1' } });
      }
      if (deleted && path.match(/\/tenants\/tenant-001$/)) return Promise.reject(new Error('Tenant not found'));
      return undefined;
    });
  }

  async function confirmDelete() {
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(screen.getByTestId('delete-button'));
    fireEvent.click(screen.getByTestId('delete-confirm-button'));
  }

  beforeEach(() => vi.resetAllMocks());

  it('goes back to the tenants list, which says the tenant was deleted', async () => {
    setupDelete('ok');
    renderTenantDetail();
    await confirmDelete();
    const banner = await screen.findByTestId('tenant-deleted-banner');
    expect(banner).toHaveTextContent('Tenant Acme Corp was deleted.');
    expect(screen.queryByText('Tenant not found')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-progress-modal')).not.toBeInTheDocument();
  });

  it('stays on the tenant and shows why when the delete fails', async () => {
    setupDelete('fail');
    renderTenantDetail();
    await confirmDelete();
    expect(await screen.findByText('Namespace deletion is blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('tenant-deleted-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('transition-progress-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('delete-confirm-dialog')).toBeInTheDocument();
  });
});

describe('TenantDetail — archive', () => {
  beforeEach(() => { vi.resetAllMocks(); setupMockApi(); });
  const suspended = { ...MOCK_CLIENT.data, status: 'suspended' as const };

  it('takes a suspended tenant only: suspend first', async () => {
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    const archive = await screen.findByTestId('archive-button');
    expect(archive).toBeDisabled();
    expect(archive).toHaveAttribute('title', expect.stringContaining('suspend it first'));
  });

  it('asks how long to keep the archive and sends it with the archive', async () => {
    setupMockApi(suspended);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('archive-button'));
    fireEvent.change(await screen.findByTestId('archive-retention-input'), { target: { value: '730' } });
    fireEvent.click(screen.getByTestId('archive-confirm'));
    await waitFor(() => expect(lastPatch()).toMatchObject({ status: 'archived', archive_retention_days: 730 }));
  });

  it('"Never expire" keeps it with no end date — and no automatic delete', async () => {
    setupMockApi(suspended);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('archive-button'));
    fireEvent.click(await screen.findByTestId('archive-never-expires'));
    expect(screen.getByTestId('archive-retention-input')).toBeDisabled();
    fireEvent.click(screen.getByTestId('archive-confirm'));
    await waitFor(() => expect(lastPatch()).toEqual(expect.objectContaining({ status: 'archived', archive_never_expires: true })));
    expect(lastPatch()).not.toHaveProperty('archive_retention_days');
  });

  it('Reactivate is off, saying why, while the subscription has ended — the hourly check would suspend it again', async () => {
    setupMockApi({ ...suspended, subscriptionExpiresAt: '2026-01-31T00:00:00Z' });
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    const reactivate = await screen.findByTestId('reactivate-button');
    expect(reactivate).toBeDisabled();
    expect(reactivate).toHaveAttribute('title', expect.stringContaining('Limits → Subscription'));
  });

  it('Reactivate is on while the subscription runs, or has no end', async () => {
    setupMockApi({ ...suspended, subscriptionExpiresAt: '2099-01-31T00:00:00Z' });
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    expect(await screen.findByTestId('reactivate-button')).toBeEnabled();
  });

  it('says what archiving removes before anyone confirms', async () => {
    setupMockApi(suspended);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('archive-button'));
    const list = await screen.findByTestId('archive-consequences');
    expect(list).toHaveTextContent('nobody can sign in');
    expect(list).toHaveTextContent('DNS zones, mail domains and DKIM keys');
  });

  it('refuses a retention outside 1–3650 days before sending anything', async () => {
    setupMockApi(suspended);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('archive-button'));
    fireEvent.change(await screen.findByTestId('archive-retention-input'), { target: { value: '0' } });
    expect(screen.getByTestId('archive-confirm')).toBeDisabled();
    fireEvent.change(screen.getByTestId('archive-retention-input'), { target: { value: '3651' } });
    expect(screen.getByTestId('archive-confirm')).toBeDisabled();
  });
});

describe('TenantDetail — an archived tenant', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  const archived = { ...MOCK_CLIENT.data, status: 'archived' as const, archivedAt: '2026-10-20T10:00:00Z' };
  const info = (over: Record<string, unknown> = {}) => ({
    data: {
      archivedAt: '2026-10-20T10:00:00Z',
      bundle: { id: 'bkp-1', createdAt: '2026-10-20T10:00:00Z', sizeBytes: 3 * 1024 * 1024 * 1024, whole: true },
      expiresAt: '2027-01-18T10:00:00Z',
      restorable: true,
      notRestorableReason: null,
      filesBytes: 2 * 1024 * 1024 * 1024,
      storageGi: 5,
      target: null,
      placement: {
        pinnedNode: 'sv1', storageTier: 'local', pinProblem: null,
        nodes: [{ name: 'sv1', problem: null }, { name: 'sv2', problem: null }, { name: 'sv3', problem: 'is cordoned' }],
      },
      subscriptionExpiresAt: null,
      ...over,
    },
  });
  /** The restore the dialog sent, or an error the API answers it with. */
  let restoreAnswer: () => Promise<unknown> = () => Promise.resolve({ data: { operationId: 'op-r', snapshotId: 's-1' } });
  const withArchive = (body: unknown) => setupMockApi(archived, (path, init) => {
    if (path.endsWith('/archive')) return Promise.resolve(body);
    if (path.endsWith('/storage/restore') && init?.method === 'POST') return restoreAnswer();
    return undefined;
  });
  const lastRestore = (): Record<string, unknown> | undefined => {
    const call = mockApiFetch.mock.calls.filter(([path, init]) => String(path).endsWith('/storage/restore') && (init as { method?: string } | undefined)?.method === 'POST').pop();
    return call ? JSON.parse((call[1] as { body?: string }).body ?? '{}') : undefined;
  };

  it('shows nothing but the archive: the notice, the bundle\u2019s date and size, its expiry, and Restore', async () => {
    withArchive(info());
    renderTenantDetail();
    const view = await screen.findByTestId('archived-tenant-view');
    expect(view).toHaveTextContent('ARCHIVED');
    expect(await screen.findByTestId('archive-bundle-size')).toHaveTextContent('3');
    expect(screen.getByTestId('archive-bundle-date')).toHaveTextContent('2026');
    expect(screen.getByTestId('archive-expiry')).toHaveTextContent('then the tenant is deleted');
    expect(screen.getByTestId('restore-archived-button')).toBeEnabled();
    expect(screen.queryByTestId('tenant-tabs')).toBeNull();
    expect(screen.queryByTestId('impersonate-button')).toBeNull();
    expect(screen.queryByTestId('impersonate-caption')).toBeNull();
  });

  it('an archive kept with no end date says so', async () => {
    withArchive(info({ expiresAt: null }));
    renderTenantDetail();
    expect(await screen.findByTestId('archive-expiry')).toHaveTextContent('with no end date');
  });

  it('restores from a dialog that says it comes back suspended and mailboxes need new passwords, on its own node', async () => {
    restoreAnswer = () => Promise.resolve({ data: { operationId: 'op-r', snapshotId: 's-1' } });
    withArchive(info());
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    const said = await screen.findByTestId('restore-what-comes-back');
    expect(said).toHaveTextContent('It comes back suspended');
    expect(said).toHaveTextContent('new passwords');
    expect(screen.getByTestId('restore-node-select')).toHaveValue('sv1');
    fireEvent.click(screen.getByTestId('restore-archive-confirm'));
    await waitFor(() => expect(lastRestore()).toEqual({ nodeName: 'sv1' }));
    expect(lastPatch()).toBeUndefined();
  });

  it('offers only the nodes that can take it, and Auto — a node that cannot says why', async () => {
    withArchive(info());
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    const select = await screen.findByTestId('restore-node-select');
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => [o.textContent, o.disabled])).toEqual([
      ['Auto — the node with the most free storage', false],
      ['sv1 (its node)', false],
      ['sv2', false],
      ['sv3 — is cordoned', true],
    ]);
    fireEvent.change(select, { target: { value: '__auto__' } });
    fireEvent.click(screen.getByTestId('restore-archive-confirm'));
    await waitFor(() => expect(lastRestore()).toEqual({ nodeName: null }));
  });

  it('a pinned node that cannot take it says why, and starts on Auto', async () => {
    withArchive(info({ placement: { pinnedNode: 'sv1', storageTier: 'local', pinProblem: 'is down (not Ready)', nodes: [{ name: 'sv1', problem: 'is down (not Ready)' }, { name: 'sv2', problem: null }] } }));
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    expect(await screen.findByTestId('restore-pin-problem')).toHaveTextContent('Its node sv1 is down (not Ready)');
    expect(screen.getByTestId('restore-node-select')).toHaveValue('__auto__');
  });

  it('refuses a size the archive\'s files cannot fit in, and says a larger one becomes the tenant\'s size', async () => {
    withArchive(info());
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    const sizeInput = await screen.findByTestId('restore-size-input');
    expect(sizeInput).toHaveValue(5);
    fireEvent.change(sizeInput, { target: { value: '1.5' } });
    expect(screen.getByTestId('restore-size-invalid')).toHaveTextContent('Between 2 and 1000 GiB');
    expect(screen.getByTestId('restore-archive-confirm')).toBeDisabled();
    fireEvent.change(sizeInput, { target: { value: '2.1' } });
    expect(screen.getByTestId('restore-size-tight')).toBeInTheDocument();
    expect(screen.getByTestId('restore-size-changes')).toHaveTextContent('becomes 2.1 GiB');
    fireEvent.change(sizeInput, { target: { value: '5' } });
    expect(screen.queryByTestId('restore-size-changes')).toBeNull();
    fireEvent.change(sizeInput, { target: { value: '8' } });
    expect(screen.getByTestId('restore-size-changes')).toHaveTextContent('becomes 8 GiB');
    fireEvent.click(screen.getByTestId('restore-archive-confirm'));
    await waitFor(() => expect(lastRestore()).toEqual({ nodeName: 'sv1', newGi: 8 }));
  });

  it('says when the archive is on a target tenant backups no longer use', async () => {
    withArchive(info({ target: { id: 'tgt-old', name: 'Old S3', bound: false } }));
    renderTenantDetail();
    expect(await screen.findByTestId('archive-target')).toHaveTextContent('Stored on Old S3 — not the target tenant backups use now');
    fireEvent.click(screen.getByTestId('restore-archived-button'));
    expect(await screen.findByTestId('restore-other-target')).toHaveTextContent('temporary, read-only connection');
  });

  it('warns that a subscription that has ended blocks the reactivation after', async () => {
    withArchive(info({ subscriptionExpiresAt: '2026-01-31T00:00:00Z' }));
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    expect(await screen.findByTestId('restore-subscription-ended')).toHaveTextContent('reactivation is refused until then');
  });

  it('a restore the API refuses says why in the dialog, which stays open', async () => {
    restoreAnswer = () => Promise.reject(Object.assign(new Error('The tenant\'s node sv1 is down (not Ready)'), { code: 'RESTORE_NODE_UNAVAILABLE', status: 409 }));
    withArchive(info());
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('restore-archived-button'));
    fireEvent.click(await screen.findByTestId('restore-archive-confirm'));
    expect(await screen.findByTestId('restore-archive-error')).toHaveTextContent('down');
    expect(screen.getByTestId('restore-archive-dialog')).toBeInTheDocument();
    restoreAnswer = () => Promise.resolve({ data: { operationId: 'op-r', snapshotId: 's-1' } });
  });

  it('an archive from before archives held everything says restore brings back the files only', async () => {
    withArchive(info({ bundle: { id: 'bkp-0', createdAt: '2026-10-01T10:00:00Z', sizeBytes: 1024, whole: false } }));
    renderTenantDetail();
    expect(await screen.findByTestId('archive-files-only')).toHaveTextContent('files only');
  });

  it('no restore when there is nothing to restore from, and why', async () => {
    withArchive(info({ bundle: null, restorable: false, notRestorableReason: 'There is no archive bundle to restore from.' }));
    renderTenantDetail();
    expect(await screen.findByTestId('restore-archived-button')).toBeDisabled();
    expect(screen.getByTestId('archive-not-restorable')).toHaveTextContent('no archive bundle');
  });

  /**
   * A restore that failed leaves the tenant in the failed storage state, and
   * every later restore is refused until it is reset to idle. The archived
   * page has no Storage tab, so the error and Reset to idle are shown on it.
   */
  describe('after a restore that failed', () => {
    const quotaError = JSON.stringify({
      code: 'PROVISION_QUOTA_EXCEEDED',
      title: 'ResourceQuota exceeded',
      detail: 'The platform or tenant ResourceQuota is full — Kubernetes refused to create the resource.',
      remediation: ['Open the namespace’s ResourceQuota and check used vs. hard.'],
      retryable: true,
    });
    const failedRestore = (lastError: string) => ({
      id: 'op-1', tenantId: 'tenant-001', opType: 'restore', state: 'failed', progressPct: 0,
      progressMessage: 'Recreating PVC', lastError, createdAt: '2026-10-21T22:20:28Z', completedAt: '2026-10-21T22:20:28Z',
    });
    function serve(state: string, ops: unknown[], onPost?: (path: string) => void): void {
      setupMockApi({ ...archived, storageLifecycleState: state }, (path, init) => {
        if (init?.method === 'POST') { onPost?.(path); return Promise.resolve({ data: { previousState: state } }); }
        if (path.endsWith('/storage/operations')) return Promise.resolve({ data: ops });
        if (path.endsWith('/archive')) {
          return Promise.resolve(info(state === 'idle' ? {} : { restorable: false, notRestorableReason: 'The last storage operation failed. Reset to idle, then restore.' }));
        }
        return undefined;
      });
    }

    it('shows the failed restore’s error, and Restore stays off until it is reset to idle', async () => {
      serve('failed', [failedRestore(quotaError)]);
      renderTenantDetail();
      const failed = await screen.findByTestId('lifecycle-failed-op');
      expect(failed).toHaveTextContent('Last restore failed');
      expect(screen.getByTestId('lifecycle-error-panel')).toHaveTextContent('ResourceQuota exceeded');
      expect(screen.getByTestId('restore-archived-button')).toBeDisabled();
      expect(screen.getByTestId('archive-not-restorable')).toHaveTextContent('Reset to idle');
    });

    it('Reset to idle clears it, and Restore comes back', async () => {
      const posted: string[] = [];
      serve('failed', [failedRestore(quotaError)], (path) => {
        posted.push(path);
        serve('idle', [failedRestore(quotaError)]); // what the API answers after the reset
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderTenantDetail();
      fireEvent.click(await screen.findByTestId('lifecycle-clear-failed-button'));
      await waitFor(() => expect(posted).toEqual(['/api/v1/admin/tenants/tenant-001/storage/clear-failed']));
      await waitFor(() => expect(screen.getByTestId('restore-archived-button')).toBeEnabled());
      expect(screen.queryByTestId('lifecycle-failed-op')).toBeNull();
      expect(screen.queryByTestId('archive-not-restorable')).toBeNull();
      confirmSpy.mockRestore();
    });

    it('a reset the API refuses says why', async () => {
      const { ApiError } = await import('@/lib/api-client');
      setupMockApi({ ...archived, storageLifecycleState: 'failed' }, (path, init) => {
        if (init?.method === 'POST') return Promise.reject(new ApiError(409, 'NOT_IN_FAILED_STATE', "Tenant is in state 'idle', not 'failed'"));
        if (path.endsWith('/storage/operations')) return Promise.resolve({ data: [failedRestore(quotaError)] });
        if (path.endsWith('/archive')) return Promise.resolve(info({ restorable: false, notRestorableReason: 'x' }));
        return undefined;
      });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderTenantDetail();
      fireEvent.click(await screen.findByTestId('lifecycle-clear-failed-button'));
      expect(await screen.findByTestId('lifecycle-clear-failed-error')).toHaveTextContent('NOT_IN_FAILED_STATE');
      confirmSpy.mockRestore();
    });

    it('an error stored as plain text is shown as it is', async () => {
      serve('failed', [failedRestore('restic: repository is locked')]);
      renderTenantDetail();
      expect(await screen.findByTestId('lifecycle-failed-op')).toHaveTextContent('restic: repository is locked');
      expect(screen.queryByTestId('lifecycle-error-panel')).toBeNull();
    });

    it('a newer operation over the failed one: the reset is still there, with the failed one’s error', async () => {
      const newer = { ...failedRestore(''), id: 'op-2', opType: 'autoheal', state: 'idle', lastError: null, createdAt: '2026-10-21T23:00:00Z' };
      serve('failed', [newer, failedRestore(quotaError)]);
      renderTenantDetail();
      expect(await screen.findByTestId('lifecycle-error-panel')).toHaveTextContent('ResourceQuota exceeded');
      expect(screen.getByTestId('lifecycle-failed-op')).toHaveTextContent('Last restore failed');
      expect(screen.getByTestId('lifecycle-clear-failed-button')).toBeEnabled();
    });

    it('the operations cannot be read: the reset is still offered', async () => {
      setupMockApi({ ...archived, storageLifecycleState: 'failed' }, (path) => {
        if (path.endsWith('/storage/operations')) return Promise.reject(new Error('network down'));
        if (path.endsWith('/archive')) return Promise.resolve(info({ restorable: false, notRestorableReason: 'x' }));
        return undefined;
      });
      renderTenantDetail();
      expect(await screen.findByTestId('lifecycle-failed-op')).toHaveTextContent('A storage operation failed');
      expect(screen.getByTestId('lifecycle-clear-failed-button')).toBeEnabled();
    });

    it('Restore in the Actions menu is off too', async () => {
      serve('failed', [failedRestore(quotaError)]);
      renderTenantDetail();
      await screen.findByTestId('lifecycle-failed-op');
      fireEvent.click(screen.getByTestId('tenant-actions-button'));
      expect(await screen.findByTestId('restore-button')).toBeDisabled();
    });

    it('a failed operation the tenant has moved on from shows nothing', async () => {
      serve('idle', [failedRestore(quotaError)]);
      renderTenantDetail();
      expect(await screen.findByTestId('restore-archived-button')).toBeEnabled();
      expect(screen.queryByTestId('lifecycle-failed-op')).toBeNull();
    });

    it('a restore running: Restore is off, and the page says what is running', async () => {
      serve('restoring', [{ ...failedRestore(''), state: 'restoring', lastError: null, completedAt: null, progressMessage: 'Restoring files' }]);
      renderTenantDetail();
      await waitFor(() => expect(screen.getByTestId('archive-not-restorable')).toHaveTextContent('Restoring files'));
      expect(screen.getByTestId('restore-archived-button')).toBeDisabled();
      expect(screen.queryByTestId('lifecycle-failed-op')).toBeNull();
    });
  });
});

/**
 * Suspend, Reactivate, Archive and Restore in the Actions menu. A request the
 * API refuses — the tenant is busy, an operation already owns it — used to
 * end with the "Dispatching…" dialog left open and nothing to say why.
 */
describe('TenantDetail — a lifecycle action the API refuses', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function refuseStatusChange(refusal: Error): void {
    setupMockApi(MOCK_CLIENT.data, (path, init) => (init?.method === 'PATCH' && /\/tenants\/tenant-001$/.test(path) ? Promise.reject(refusal) : undefined));
  }

  it('says why a suspend was refused, and takes the progress dialog away', async () => {
    const { ApiError } = await import('@/lib/api-client');
    refuseStatusChange(new ApiError(409, 'TENANT_BUSY', 'Another change to this tenant is being started, or the tenant is being deleted. Try again in a moment.'));
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('suspend-button'));
    const panel = await screen.findByTestId('tenant-lifecycle-action-error');
    expect(panel).toHaveTextContent('TENANT_BUSY');
    expect(panel).toHaveTextContent('Another change to this tenant is being started');
    expect(screen.queryByTestId('transition-progress-modal')).toBeNull();
  });

  it('clears the message when the next attempt goes through', async () => {
    const { ApiError } = await import('@/lib/api-client');
    refuseStatusChange(new ApiError(409, 'STORAGE_OP_IN_PROGRESS', 'A resizing operation is already in progress for this tenant'));
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('suspend-button'));
    await screen.findByTestId('tenant-lifecycle-action-error');

    setupMockApi(); // the operation has ended: the API accepts now
    fireEvent.click(screen.getByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('suspend-button'));
    await waitFor(() => expect(screen.queryByTestId('tenant-lifecycle-action-error')).toBeNull());
    expect(await screen.findByTestId('transition-progress-modal')).toBeInTheDocument();
  });
});

/**
 * "Keep out of automatic archive and delete" in the Actions menu: a standing
 * property of the tenant, saved the moment it is ticked, and visible on the
 * page without opening the menu.
 */
describe('TenantDetail — kept out of automatic archive and delete', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  function serveTenant(exempt: boolean, answer?: Error): void {
    setupMockApi({ ...MOCK_CLIENT.data, lifecycleAutomationExempt: exempt }, (path, init) => {
      if (init?.method === 'PUT' && path.endsWith('/admin/lifecycle/automation/tenants/tenant-001')) {
        return answer ? Promise.reject(answer) : Promise.resolve({ data: { tenantId: 'tenant-001', name: 'Acme Corp', status: 'active', exempt: !exempt } });
      }
      return undefined;
    });
  }
  const puts = (): unknown[] => mockApiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([path, init]) => [path, JSON.parse((init as RequestInit).body as string)]);

  it('a tenant that is not kept out shows no note, and ticking the box keeps it out at once', async () => {
    serveTenant(false);
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    const box = await screen.findByTestId('automation-exempt-checkbox');
    expect(box).not.toBeChecked();
    expect(screen.queryByTestId('automation-exempt-note')).toBeNull();
    fireEvent.click(box);
    await waitFor(() => expect(puts()).toEqual([['/api/v1/admin/lifecycle/automation/tenants/tenant-001', { exempt: true }]]));
  });

  it('a tenant that is kept out says so under its name, and unticking the box puts it back', async () => {
    serveTenant(true);
    renderTenantDetail();
    expect(await screen.findByTestId('automation-exempt-note')).toHaveTextContent('Kept out of automatic archive and delete.');
    fireEvent.click(screen.getByTestId('tenant-actions-button'));
    const box = await screen.findByTestId('automation-exempt-checkbox');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(puts()).toEqual([['/api/v1/admin/lifecycle/automation/tenants/tenant-001', { exempt: false }]]));
  });

  it('says why when the change is refused', async () => {
    const { ApiError } = await import('@/lib/api-client');
    serveTenant(false, new ApiError(403, 'FORBIDDEN', 'Only an admin may change this'));
    renderTenantDetail();
    fireEvent.click(await screen.findByTestId('tenant-actions-button'));
    fireEvent.click(await screen.findByTestId('automation-exempt-checkbox'));
    expect(await screen.findByTestId('tenant-lifecycle-action-error')).toHaveTextContent('Only an admin may change this');
  });
});
