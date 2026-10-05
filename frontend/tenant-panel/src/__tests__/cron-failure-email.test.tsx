import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CronJobs from '../pages/CronJobs';
import { apiFetch } from '@/lib/api-client';

/**
 * Opt-in failure email on a cron job: off by default, to the tenant email
 * and/or one more address. The form must show WHO "tenant email" is — the
 * address the API will actually use — and must not let a switched-on
 * notification be saved with nobody to mail.
 */

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));

const mockAuthUser = { id: 'u1', email: 'u@example.test', fullName: 'Me', role: 'tenant_admin' };
vi.mock('@/hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof mockAuthUser }) => T) => {
    const state = { user: mockAuthUser };
    return selector ? selector(state) : state;
  },
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const JOBS = [
  {
    id: 'cj1', tenantId: 'c1', name: 'nightly-import', type: 'webcron',
    schedule: '0 3 * * *', url: 'https://example.test/cron.php', httpMethod: 'GET',
    command: null, deploymentId: null, timeoutSeconds: null, timezone: null,
    enabled: 1, lastRunAt: null, lastRunStatus: null,
    notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: 'ops@example.test',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cj2', tenantId: 'c1', name: 'quiet-job', type: 'webcron',
    schedule: '*/5 * * * *', url: 'https://example.test/ping', httpMethod: 'GET',
    command: null, deploymentId: null, timeoutSeconds: null, timezone: null,
    enabled: 1, lastRunAt: null, lastRunStatus: null,
    notifyOnFailure: false, notifyTenantEmail: true, notifyEmail: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
];

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

function setup() {
  mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/cron-jobs/failure-email-info')) {
      return Promise.resolve({ data: { tenantEmail: 'owner@example.test', maxEmailsPerTenantPerDay: 20 } });
    }
    if (url.includes('/cron-jobs') && (init?.method === 'POST' || init?.method === 'PATCH')) {
      return Promise.resolve({ data: JOBS[0] });
    }
    if (url.includes('/cron-jobs')) {
      return Promise.resolve({ data: JOBS, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
    }
    return Promise.resolve({ data: [] });
  });
}

function sentBody(method: 'POST' | 'PATCH') {
  const call = mockApiFetch.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === method);
  expect(call, `expected a ${method} request`).toBeDefined();
  return JSON.parse((call![1] as { body: string }).body);
}

async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
  render(<CronJobs />, { wrapper: wrapper() });
  await waitFor(() => expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument());
  await user.click(screen.getByTestId('add-cron-job-button'));
  await user.type(screen.getByTestId('cron-url-input'), 'https://example.test/cron.php');
  await user.type(screen.getByTestId('cron-name-input'), 'nightly');
  await user.type(screen.getByTestId('cron-schedule-input'), '0 3 * * *');
}

beforeEach(() => vi.clearAllMocks());

describe('cron failure email — create', () => {
  it('is off by default and hides the recipients until switched on', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);

    expect(screen.getByTestId('cron-notify-toggle')).not.toBeChecked();
    expect(screen.queryByTestId('cron-notify-tenant-email')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cron-notify-email-input')).not.toBeInTheDocument();
  });

  it('shows the actual tenant address and pre-selects it when switched on', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));

    expect(screen.getByTestId('cron-notify-tenant-email')).toBeChecked();
    await waitFor(() => expect(screen.getByTestId('cron-notify-tenant-email-address')).toHaveTextContent('owner@example.test'));
    // The volume promise, with the server's cap rather than a number baked into the panel.
    expect(screen.getByTestId('cron-failure-email')).toHaveTextContent(/one email per task per day/);
    expect(screen.getByTestId('cron-failure-email')).toHaveTextContent(/20/);
  });

  it('sends nothing about failure email when left off', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'POST')).toBe(true));
    expect(sentBody('POST')).toMatchObject({ notify_on_failure: false });
  });

  it('creates with the tenant email and an extra address', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await user.type(screen.getByTestId('cron-notify-email-input'), 'ops@example.test');
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'POST')).toBe(true));
    expect(sentBody('POST')).toMatchObject({
      notify_on_failure: true,
      notify_tenant_email: true,
      notify_email: 'ops@example.test',
    });
  });

  it('sends a blank extra address as null, never as an empty string the API would reject', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'POST')).toBe(true));
    expect(sentBody('POST').notify_email).toBeNull();
  });

  it('refuses to save a switched-on notification that names nobody', async () => {
    setup();
    const user = userEvent.setup();
    await openCreateForm(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await user.click(screen.getByTestId('cron-notify-tenant-email'));

    expect(screen.getByTestId('cron-notify-recipient-error')).toBeInTheDocument();
    expect(screen.getByTestId('submit-cron-job')).toBeDisabled();
    await user.click(screen.getByTestId('submit-cron-job'));
    expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'POST')).toBe(false);

    // An extra address alone is enough.
    await user.type(screen.getByTestId('cron-notify-email-input'), 'ops@example.test');
    expect(screen.queryByTestId('cron-notify-recipient-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('submit-cron-job')).not.toBeDisabled();
  });
});

describe('cron failure email — edit and list', () => {
  it('loads the saved recipients back into the form', async () => {
    setup();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));

    expect(screen.getByTestId('cron-notify-toggle')).toBeChecked();
    expect(screen.getByTestId('cron-notify-tenant-email')).not.toBeChecked();
    expect(screen.getByTestId('cron-notify-email-input')).toHaveValue('ops@example.test');
  });

  it('PATCHes a changed recipient set, clearing the extra address with null', async () => {
    setup();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));
    await user.click(screen.getByTestId('cron-notify-tenant-email'));
    await user.clear(screen.getByTestId('cron-notify-email-input'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'PATCH')).toBe(true));
    expect(sentBody('PATCH')).toMatchObject({
      notify_on_failure: true,
      notify_tenant_email: true,
      notify_email: null,
    });
  });

  it('switching it off keeps the stored extra address for next time', async () => {
    setup();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'PATCH')).toBe(true));
    expect(sentBody('PATCH')).toMatchObject({ notify_on_failure: false, notify_email: 'ops@example.test' });
  });

  it('marks the jobs that email on failure, naming who', async () => {
    setup();
    render(<CronJobs />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-table')).toBeInTheDocument());

    const marker = screen.getByTestId('cron-notify-badge-cj1');
    expect(marker.getAttribute('title')).toContain('ops@example.test');
    expect(screen.queryByTestId('cron-notify-badge-cj2')).not.toBeInTheDocument();
    // The row still reads normally around it.
    expect(within(marker.closest('tr')!).getByText('nightly-import')).toBeInTheDocument();
  });
});
