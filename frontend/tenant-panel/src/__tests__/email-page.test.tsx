import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Email from '../pages/Email';

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

vi.mock('../hooks/use-email', () => ({
  useEmailDomains: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useMailboxes: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useUpdateMailbox: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useUpdateEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteEmailAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useMailboxAliases: vi.fn(() => ({ data: { data: [] }, isLoading: false })),
  useCreateMailboxAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useUpdateMailboxAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useDeleteMailboxAlias: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useWebmailToken: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useEnableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useDisableEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null })),
  useEmailDomainDisablePreview: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  useUpdateEmailDomain: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false, error: null })),
  useEmailDomainDnsRecords: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
  useEmailConnectionInfo: vi.fn(() => ({
    data: {
      data: {
        domainName: 'example.com',
        mailServerHostname: 'mail.platform.example',
        ports: [
          { protocol: 'imap', port: 993, socketType: 'ssl', recommended: true },
          { protocol: 'imap', port: 143, socketType: 'starttls', recommended: false },
          { protocol: 'pop3', port: 995, socketType: 'ssl', recommended: true },
          { protocol: 'smtp', port: 465, socketType: 'ssl', recommended: true },
          { protocol: 'smtp', port: 587, socketType: 'starttls', recommended: false },
        ],
        webmailUrl: 'https://webmail.platform.example',
        webmailHostname: null,
      },
    },
    isLoading: false,
    error: null,
  })),
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
  useMailUsage: vi.fn(() => ({
    data: { data: { hour: { used: 3, limit: 50 }, day: { used: 10, limit: 100, recipients: 12, rateLimited: 0, quotaRejected: 0 }, suspended: false, outboundSuspended: false } },
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

import { useEmailDomains, useMailboxes, useUpdateMailbox, useEmailDomainDnsRecords } from '../hooks/use-email';
import { useDomains } from '../hooks/use-domains';

const mockedUseEmailDomains = vi.mocked(useEmailDomains);
const mockedUseMailboxes = vi.mocked(useMailboxes);
const mockedUseUpdateMailbox = vi.mocked(useUpdateMailbox);
const mockedUseEmailDomainDnsRecords = vi.mocked(useEmailDomainDnsRecords);
const mockedUseDomains = vi.mocked(useDomains);

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

describe('Email Page', () => {
  it('renders the heading', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-heading')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('shows the Enable Email card when no email domains exist', () => {
    renderWithProviders(<Email />);
    expect(screen.getByTestId('email-enable-card')).toBeInTheDocument();
    expect(screen.getByText('Enable Email Hosting')).toBeInTheDocument();
  });

  it('shows Mailboxes and Aliases tabs when domains exist', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('tab-mailboxes')).toBeInTheDocument();
    expect(screen.getByTestId('tab-aliases')).toBeInTheDocument();
    expect(screen.getByText('Mailboxes')).toBeInTheDocument();
    expect(screen.getByText('Mailing Lists')).toBeInTheDocument();
  });

  it('shows mailboxes tab content by default when domains exist', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('add-mailbox-button')).toBeInTheDocument();
    expect(screen.getByTestId('mailboxes-table')).toBeInTheDocument();
  });

  it('shows empty mailbox message when no mailboxes', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.getByText('No mailboxes yet. Create your first mailbox to get started.')).toBeInTheDocument();
  });

  it('shows an Edit button per mailbox row', async () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            tenantId: 'tenant-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('edit-mailbox-mb-1')).toBeInTheDocument();
  });

  it('opens the edit modal when the Edit button is clicked', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            tenantId: 'tenant-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-1'));

    // Modal should surface fields for the edit-allowed props
    expect(screen.getByTestId('edit-mailbox-modal')).toBeInTheDocument();
    expect(screen.getByTestId('edit-mailbox-display-name')).toHaveValue('Alice');
    expect(screen.getByTestId('edit-mailbox-quota')).toHaveValue(1024);
    // ADR-049: the edit modal no longer has a password field — credentials
    // are managed via login passwords.
    expect(screen.queryByTestId('edit-mailbox-password')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-mailbox-status')).toBeInTheDocument();
  });

  it('shows the Settings & DNS tab when domains exist', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockedUseEmailDomains.mockReturnValue({
      data: {
        data: [
          {
            id: 'd1',
            domainId: 'd1',
            domainName: 'example.com',
            enabled: 1,
            webmailEnabled: 1,
            maxMailboxes: 50,
            maxQuotaMb: 10240,
            catchAllAddress: null,
            spamThresholdJunk: '5.0',
            spamThresholdReject: '10.0',
            dnsMode: 'cname',
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    mockedUseEmailDomainDnsRecords.mockReturnValue({
      data: {
        data: {
          dnsMode: 'cname',
          manualRequired: true,
          mailServerHostname: 'mail.platform.test',
          records: [
            { type: 'MX', name: 'example.com', value: 'mail.example.com', ttl: 3600, priority: 10 },
            { type: 'TXT', name: 'example.com', value: 'v=spf1 mx ~all', ttl: 3600, priority: null },
          ],
        },
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useEmailDomainDnsRecords>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('tab-settings'));

    expect(screen.getByTestId('settings-tab')).toBeInTheDocument();
    expect(screen.getByTestId('domain-settings-form')).toBeInTheDocument();
    expect(screen.getByTestId('dns-records-card')).toBeInTheDocument();
    // cname mode → should show the manual-publish banner
    expect(screen.getByText(/Manual DNS publishing required/i)).toBeInTheDocument();
    // Records table should render the rows
    expect(screen.getByTestId('dns-records-table')).toBeInTheDocument();
  });

  it('submits only the changed fields to useUpdateMailbox', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const mutateAsync = vi.fn().mockResolvedValue({ data: { id: 'mb-1' } });
    mockedUseUpdateMailbox.mockReturnValue({
      mutateAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof useUpdateMailbox>);
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: {
        data: [
          {
            id: 'mb-1',
            emailDomainId: 'd1',
            tenantId: 'tenant-1',
            fullAddress: 'alice@example.com',
            displayName: 'Alice',
            quotaMb: 1024,
            usedMb: 128,
            status: 'active',
            mailboxType: 'mailbox',
            autoReply: 0,
            autoReplySubject: null,
          },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-1'));

    // Change the display name and quota (no password field — ADR-049)
    fireEvent.change(screen.getByTestId('edit-mailbox-display-name'), {
      target: { value: 'Alice Wonder' },
    });
    fireEvent.change(screen.getByTestId('edit-mailbox-quota'), {
      target: { value: '2048' },
    });

    fireEvent.click(screen.getByTestId('submit-edit-mailbox'));

    // Wait a microtask for the async submission
    await new Promise(r => setTimeout(r, 0));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const call = mutateAsync.mock.calls[0][0] as { id: string; input: Record<string, unknown> };
    expect(call.id).toBe('mb-1');
    expect(call.input.display_name).toBe('Alice Wonder');
    expect(call.input.quota_mb).toBe(2048);
    // Password is no longer a field at all
    expect(call.input.password).toBeUndefined();
    // Status unchanged → should NOT be sent
    expect(call.input.status).toBeUndefined();
  });

  // ── Phase 2 round 3: multi-domain Enable Email ─────────────────────

  it('shows the Enable Email card alongside tabs when eligible domains remain', () => {
    // One email-enabled domain and two total domains → one eligible.
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'ed-1', domainId: 'd1', domainName: 'first.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseDomains.mockReturnValue({
      data: {
        data: [
          { id: 'd1', domainName: 'first.com', dnsMode: 'primary' },
          { id: 'd2', domainName: 'second.com', dnsMode: 'primary' },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useDomains>);

    renderWithProviders(<Email />);

    // Both tabs AND enable card must be present
    expect(screen.getByTestId('tab-mailboxes')).toBeInTheDocument();
    expect(screen.getByTestId('email-enable-card')).toBeInTheDocument();
    // Only the second (un-enabled) domain should have an Enable row
    expect(screen.getByTestId('enable-email-row-d2')).toBeInTheDocument();
    expect(screen.queryByTestId('enable-email-row-d1')).not.toBeInTheDocument();
  });

  it('hides the Enable Email card when all domains already have email enabled', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: {
        data: [
          { id: 'ed-1', domainId: 'd1', domainName: 'first.com' },
          { id: 'ed-2', domainId: 'd2', domainName: 'second.com' },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseDomains.mockReturnValue({
      data: {
        data: [
          { id: 'd1', domainName: 'first.com', dnsMode: 'primary' },
          { id: 'd2', domainName: 'second.com', dnsMode: 'primary' },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useDomains>);

    renderWithProviders(<Email />);

    expect(screen.getByTestId('tab-mailboxes')).toBeInTheDocument();
    expect(screen.queryByTestId('email-enable-card')).not.toBeInTheDocument();
  });

  // ── Round-4 Phase 1: top-level domain selector ────────────────────

  it('shows a label (no dropdown) when only one email domain is enabled', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'ed1', domainId: 'd1', domainName: 'only.example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);

    expect(screen.getByTestId('email-domain-label')).toHaveTextContent('only.example.com');
    expect(screen.queryByTestId('email-domain-selector')).not.toBeInTheDocument();
  });

  it('shows a dropdown when multiple email domains are enabled', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: {
        data: [
          { id: 'ed1', domainId: 'd1', domainName: 'first.com' },
          { id: 'ed2', domainId: 'd2', domainName: 'second.com' },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);

    expect(screen.getByTestId('email-domain-selector')).toBeInTheDocument();
    expect(screen.queryByTestId('email-domain-label')).not.toBeInTheDocument();
  });

  // Round-4 Phase 1 review LOW-3: switching the dropdown updates
  // the URL search params so the selection survives reloads.
  it('updates the ?emailDomain= URL param when the dropdown changes', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockedUseEmailDomains.mockReturnValue({
      data: {
        data: [
          { id: 'ed1', domainId: 'd1', domainName: 'first.com' },
          { id: 'ed2', domainId: 'd2', domainName: 'second.com' },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);

    const select = screen.getByTestId('email-domain-selector') as HTMLSelectElement;
    expect(select.value).toBe('ed1');

    fireEvent.change(select, { target: { value: 'ed2' } });

    // After the change, the URL search params should reflect the
    // new selection. We can't read window.location with MemoryRouter,
    // but the select element's controlled value tracks searchParams.
    expect(select.value).toBe('ed2');
  });
});

describe('Email connection guide', () => {
  const oneDomain = {
    data: { data: [{ id: 'ed1', domainId: 'd1', domainName: 'example.com' }] },
    isLoading: false,
  } as unknown as ReturnType<typeof useEmailDomains>;

  it('renders the guide button next to the domain pill', () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    renderWithProviders(<Email />);

    const button = screen.getByTestId('open-email-connection-guide');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('How to connect to your email accounts');
  });

  it('does not render the guide button when the tenant has no email domains', () => {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);

    renderWithProviders(<Email />);
    expect(screen.queryByTestId('open-email-connection-guide')).not.toBeInTheDocument();
  });

  it('keeps the guide out of the DOM until the button is clicked', async () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    const user = userEvent.setup();
    renderWithProviders(<Email />);

    expect(screen.queryByTestId('email-connection-guide-modal')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('open-email-connection-guide'));

    // Lazily loaded — resolve the chunk before asserting.
    expect(await screen.findByTestId('email-connection-guide-modal')).toBeInTheDocument();
  });

  it('opens on the Email clients tab showing server, ports and username format', async () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    const user = userEvent.setup();
    renderWithProviders(<Email />);

    await user.click(screen.getByTestId('open-email-connection-guide'));
    await screen.findByTestId('email-connection-guide-modal');

    expect(screen.getByTestId('guide-tab-clients-content')).toBeInTheDocument();
    // Server hostname comes from the API, never a literal in the component.
    expect(screen.getByTestId('mail-server-hostname')).toHaveTextContent('mail.platform.example');
    // Username must be spelled out as the FULL address for the selected domain.
    expect(screen.getByTestId('mail-username-format')).toHaveTextContent('you@example.com');

    const table = screen.getByTestId('mail-ports-table');
    for (const port of ['993', '143', '995', '465', '587']) {
      expect(table).toHaveTextContent(port);
    }
    expect(table).toHaveTextContent('SSL/TLS');
    expect(table).toHaveTextContent('STARTTLS');
  });

  it('explains where app passwords come from', async () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    const user = userEvent.setup();
    renderWithProviders(<Email />);

    await user.click(screen.getByTestId('open-email-connection-guide'));
    const modal = await screen.findByTestId('email-connection-guide-modal');

    expect(modal).toHaveTextContent(/app password/i);
    expect(modal).toHaveTextContent(/Passwords/);
    expect(modal).toHaveTextContent(/shown/i);
  });

  it('switches to the Webmail tab and shows both access routes', async () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    const user = userEvent.setup();
    renderWithProviders(<Email />);

    await user.click(screen.getByTestId('open-email-connection-guide'));
    await screen.findByTestId('email-connection-guide-modal');

    await user.click(screen.getByTestId('guide-tab-webmail'));

    const webmail = screen.getByTestId('guide-tab-webmail-content');
    expect(webmail).toBeInTheDocument();
    // Route 1: via the panel. Route 2: the direct URL from the API.
    expect(webmail).toHaveTextContent(/Webmail/);
    expect(screen.getByTestId('webmail-url')).toHaveTextContent('https://webmail.platform.example');
    expect(screen.getByTestId('webmail-username-format')).toHaveTextContent('you@example.com');
    // The clients tab is unmounted while webmail is showing.
    expect(screen.queryByTestId('guide-tab-clients-content')).not.toBeInTheDocument();
  });

  it('closes on the Close button', async () => {
    mockedUseEmailDomains.mockReturnValue(oneDomain);
    const user = userEvent.setup();
    renderWithProviders(<Email />);

    await user.click(screen.getByTestId('open-email-connection-guide'));
    await screen.findByTestId('email-connection-guide-modal');

    await user.click(screen.getByTestId('email-guide-close-button'));
    expect(screen.queryByTestId('email-connection-guide-modal')).not.toBeInTheDocument();
  });
});

// ── Send-only accounts + forwarding (2026-08) ───────────────────────────────

describe('Send-only accounts + forwarding', () => {
  const sendOnlyMailbox = {
    id: 'mb-so',
    emailDomainId: 'd1',
    tenantId: 'tenant-1',
    fullAddress: 'no-reply@example.com',
    displayName: null,
    quotaMb: 0,
    usedMb: 0,
    status: 'active',
    mailboxType: 'send_only',
    forwardingAddresses: null,
    autoReply: 0,
    autoReplySubject: null,
  };

  function mockDomainWithMailboxes(mailboxes: unknown[]) {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseMailboxes.mockReturnValue({
      data: { data: mailboxes },
      isLoading: false,
    } as unknown as ReturnType<typeof useMailboxes>);
  }

  it('create form offers the account-type selector and hides quota for send-only', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockDomainWithMailboxes([]);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('add-mailbox-button'));

    expect(screen.getByTestId('mailbox-type')).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-quota')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('mailbox-type'), { target: { value: 'send_only' } });
    expect(screen.queryByTestId('mailbox-quota')).not.toBeInTheDocument();
  });

  it('send-only row: badge shown, webmail hidden, no quota bar', () => {
    mockDomainWithMailboxes([sendOnlyMailbox]);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('send-only-badge-mb-so')).toBeInTheDocument();
    expect(screen.queryByTestId('webmail-mb-so')).not.toBeInTheDocument();
    expect(screen.getByText('— no storage')).toBeInTheDocument();
  });

  it('forwarding badge appears when targets are set', () => {
    mockDomainWithMailboxes([{ ...sendOnlyMailbox, forwardingAddresses: ['a@example.org'] }]);

    renderWithProviders(<Email />);
    expect(screen.getByTestId('forwarding-badge-mb-so')).toBeInTheDocument();
  });

  it('send-only edit modal hides quota + auto-reply and explains the bounce default', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockDomainWithMailboxes([sendOnlyMailbox]);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-so'));

    expect(screen.getByTestId('edit-mailbox-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-mailbox-quota')).not.toBeInTheDocument();
    expect(screen.queryByTestId('edit-mailbox-auto-reply')).not.toBeInTheDocument();
    expect(screen.getByTestId('edit-mailbox-forwarding')).toBeInTheDocument();
    expect(screen.getByText(/incoming mail to this address is bounced/i)).toBeInTheDocument();
  });

  it('submits normalized forwarding_addresses when forwarding is enabled', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const mutateAsync = vi.fn().mockResolvedValue({ data: { id: 'mb-1' } });
    mockedUseUpdateMailbox.mockReturnValue({
      mutateAsync,
      isPending: false,
      error: null,
    } as unknown as ReturnType<typeof useUpdateMailbox>);
    mockDomainWithMailboxes([
      {
        id: 'mb-1',
        emailDomainId: 'd1',
        tenantId: 'tenant-1',
        fullAddress: 'alice@example.com',
        displayName: 'Alice',
        quotaMb: 1024,
        usedMb: 128,
        status: 'active',
        mailboxType: 'mailbox',
        forwardingAddresses: null,
        autoReply: 0,
        autoReplySubject: null,
      },
    ]);

    renderWithProviders(<Email />);
    fireEvent.click(screen.getByTestId('edit-mailbox-mb-1'));
    fireEvent.click(screen.getByTestId('edit-mailbox-forwarding'));
    fireEvent.change(screen.getByTestId('edit-mailbox-forwarding-addresses'), {
      target: { value: ' Bob@example.org , bob@example.org, carol@example.net ' },
    });
    fireEvent.click(screen.getByTestId('submit-edit-mailbox'));
    await new Promise(r => setTimeout(r, 0));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const call = mutateAsync.mock.calls[0][0] as { id: string; input: Record<string, unknown> };
    expect(call.input.forwarding_addresses).toEqual(['bob@example.org', 'carol@example.net']);
  });
});

// ── Aliases tab — unified edit UX (R28, 2026-08-24) ────────────────────────

import { useEmailAliases, useUpdateEmailAlias } from '../hooks/use-email';
const mockedUseEmailAliases = vi.mocked(useEmailAliases);
const mockedUseUpdateEmailAlias = vi.mocked(useUpdateEmailAlias);

describe('Aliases tab (unified UX)', () => {
  const ALIAS_ROW = {
    id: 'al-1',
    sourceAddress: 'team@example.com',
    destinationAddresses: ['a@example.org', 'b@example.org'],
    enabled: 1,
  };

  function setupWithAlias(alias = ALIAS_ROW) {
    mockedUseEmailDomains.mockReturnValue({
      data: { data: [{ id: 'd1', domainName: 'example.com' }] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailDomains>);
    mockedUseEmailAliases.mockReturnValue({
      data: { data: [alias] },
      isLoading: false,
    } as unknown as ReturnType<typeof useEmailAliases>);
  }

  async function openAliases() {
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByRole('button', { name: /Mailing Lists/ }));
    return fireEvent;
  }

  it('renders the alias row with an Edit button and no disabled badge when enabled', async () => {
    setupWithAlias();
    renderWithProviders(<Email />);
    await openAliases();
    expect(screen.getByTestId('edit-alias-al-1')).toBeInTheDocument();
    expect(screen.queryByTestId('alias-disabled-badge-al-1')).not.toBeInTheDocument();
  });

  it('shows the Disabled badge for a disabled alias', async () => {
    setupWithAlias({ ...ALIAS_ROW, enabled: 0 });
    renderWithProviders(<Email />);
    await openAliases();
    expect(screen.getByTestId('alias-disabled-badge-al-1')).toBeInTheDocument();
  });

  it('edit modal submits normalized destinations and enabled flag changes only', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ data: { id: 'al-1' } });
    mockedUseUpdateEmailAlias.mockReturnValue({
      mutateAsync, isPending: false, error: null,
    } as unknown as ReturnType<typeof useUpdateEmailAlias>);
    setupWithAlias();
    renderWithProviders(<Email />);
    const fireEvent = await openAliases();

    fireEvent.click(screen.getByTestId('edit-alias-al-1'));
    expect(screen.getByTestId('edit-alias-modal')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('edit-alias-destinations'), {
      target: { value: ' C@example.org , c@example.org ' },
    });
    fireEvent.click(screen.getByTestId('submit-edit-alias'));
    await new Promise(r => setTimeout(r, 0));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const call = mutateAsync.mock.calls[0][0] as { id: string; input: Record<string, unknown> };
    expect(call.id).toBe('al-1');
    expect(call.input.destination_addresses).toEqual(['c@example.org']);
    expect(call.input.enabled).toBeUndefined();
  });

  it('delete uses the confirm pattern (no immediate delete)', async () => {
    setupWithAlias();
    renderWithProviders(<Email />);
    const fireEvent = await openAliases();
    fireEvent.click(screen.getByTestId('delete-alias-al-1'));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });
});
