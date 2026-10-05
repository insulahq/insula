import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CronJobModal from '../components/CronJobModal';
import CronJobsTab from '../pages/tenants/CronJobsTab';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * The admin modal edits the same per-job failure email as the tenant panel:
 * off by default, to the tenant email and/or one more address, with the
 * tenant email shown as the address the API will actually use — for the
 * JOB's tenant, which on the cross-tenant tab is not the filter's.
 */

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message); this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

const JOB = {
  id: 'cj1', tenantId: 'tenant-9', name: 'nightly', type: 'webcron' as const,
  schedule: '0 3 * * *', url: 'https://example.test/cron.php', httpMethod: 'GET',
  command: null, deploymentId: null, timeoutSeconds: null, timezone: null,
  enabled: 1, lastRunAt: null, lastRunStatus: null, lastRunDurationMs: null,
  lastRunResponseCode: null, lastRunOutput: null,
  notifyOnFailure: true, notifyTenantEmail: true, notifyEmail: 'ops@example.test',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

function setup() {
  mockApiFetch.mockImplementation(((url: string) => {
    if (url.endsWith('/tenants/tenant-9/cron-jobs/failure-email-info')) {
      return Promise.resolve({ data: { tenantEmail: 'owner9@example.test', maxEmailsPerTenantPerDay: 20 } });
    }
    if (url.includes('/failure-email-info')) {
      return Promise.resolve({ data: { tenantEmail: 'someone-else@example.test', maxEmailsPerTenantPerDay: 20 } });
    }
    if (url.includes('/admin/cron-jobs')) {
      return Promise.resolve({
        data: [JOB, { ...JOB, id: 'cj2', name: 'quiet', notifyOnFailure: false, notifyEmail: null }],
        pagination: { total_count: 2, cursor: null, has_more: false, page_size: 20 },
      });
    }
    return Promise.resolve({ data: [] });
  }) as never);
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

function sentBody(method: 'POST' | 'PATCH') {
  const call = mockApiFetch.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === method);
  expect(call, `expected a ${method} request`).toBeDefined();
  return JSON.parse((call![1] as { body: string }).body);
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

describe('CronJobModal failure email — create', () => {
  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByTestId('cron-job-url-input'), 'https://example.test/x.php');
    await user.type(screen.getByTestId('cron-job-name-input'), 'new-one');
    await user.type(screen.getByTestId('cron-job-schedule-input'), '*/5 * * * *');
  }

  it('is off by default', () => {
    render(<CronJobModal open onClose={() => {}} tenantId="tenant-9" />, { wrapper: wrapper() });
    expect(screen.getByTestId('cron-notify-toggle')).not.toBeChecked();
    expect(screen.queryByTestId('cron-notify-email-input')).not.toBeInTheDocument();
  });

  it('names the tenant address and posts the chosen recipients', async () => {
    const user = userEvent.setup();
    render(<CronJobModal open onClose={() => {}} tenantId="tenant-9" />, { wrapper: wrapper() });
    await fillRequired(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await waitFor(() => expect(screen.getByTestId('cron-notify-tenant-email-address')).toHaveTextContent('owner9@example.test'));
    await user.type(screen.getByTestId('cron-notify-email-input'), 'ops@example.test');
    await user.click(screen.getByTestId('submit-cron-job-button'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'POST')).toBe(true));
    expect(sentBody('POST')).toMatchObject({
      notify_on_failure: true, notify_tenant_email: true, notify_email: 'ops@example.test',
    });
  });

  it('will not submit a switched-on notification with no recipient', async () => {
    const user = userEvent.setup();
    render(<CronJobModal open onClose={() => {}} tenantId="tenant-9" />, { wrapper: wrapper() });
    await fillRequired(user);
    await user.click(screen.getByTestId('cron-notify-toggle'));
    await user.click(screen.getByTestId('cron-notify-tenant-email'));

    expect(screen.getByTestId('cron-notify-recipient-error')).toBeInTheDocument();
    expect(screen.getByTestId('submit-cron-job-button')).toBeDisabled();
  });
});

describe('CronJobModal failure email — edit', () => {
  it('prefills the saved settings and resolves the JOB tenant\'s email, not the filter\'s', async () => {
    render(<CronJobModal open job={JOB as never} onClose={() => {}} tenantId="tenant-filter" />, { wrapper: wrapper() });
    expect(screen.getByTestId('cron-notify-toggle')).toBeChecked();
    expect(screen.getByTestId('cron-notify-tenant-email')).toBeChecked();
    expect(screen.getByTestId('cron-notify-email-input')).toHaveValue('ops@example.test');
    await waitFor(() => expect(screen.getByTestId('cron-notify-tenant-email-address')).toHaveTextContent('owner9@example.test'));
  });

  it('PATCHes the change and closes', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CronJobModal open job={JOB as never} onClose={onClose} tenantId="tenant-9" />, { wrapper: wrapper() });
    await user.clear(screen.getByTestId('cron-notify-email-input'));
    await user.click(screen.getByTestId('submit-cron-job-button'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sentBody('PATCH')).toMatchObject({
      notify_on_failure: true, notify_tenant_email: true, notify_email: null,
    });
  });
});

describe('CronJobsTab failure email marker', () => {
  it('marks the jobs that email on failure', async () => {
    render(<CronJobsTab />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-notify-badge-cj1')).toBeInTheDocument());
    expect(screen.getByTestId('cron-notify-badge-cj1').getAttribute('title')).toContain('ops@example.test');
    expect(screen.queryByTestId('cron-notify-badge-cj2')).not.toBeInTheDocument();
  });
});

describe('CronJobModal save failure', () => {
  // CLAUDE.md: every operator-facing failure renders an OperatorError via
  // <ErrorPanel> — title, code, detail and what to do — not a bare string.
  it('renders the API rejection through ErrorPanel and keeps the modal open', async () => {
    const onClose = vi.fn();
    mockApiFetch.mockImplementation(((url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') {
        return Promise.reject(new ApiError(
          400,
          'INVALID_FIELD_VALUE',
          'Failure emails need a recipient — tick the tenant email or enter an address',
          { field: 'notify_email' },
        ));
      }
      if (url.includes('/failure-email-info')) {
        return Promise.resolve({ data: { tenantEmail: 'owner9@example.test', maxEmailsPerTenantPerDay: 20 } });
      }
      return Promise.resolve({ data: [] });
    }) as never);
    const user = userEvent.setup();
    render(<CronJobModal open job={JOB as never} onClose={onClose} tenantId="tenant-9" />, { wrapper: wrapper() });
    await user.click(screen.getByTestId('submit-cron-job-button'));

    const panel = await screen.findByTestId('create-cron-job-error');
    expect(panel).toHaveAttribute('role', 'alert');
    expect(panel).toHaveTextContent('INVALID_FIELD_VALUE');
    expect(panel).toHaveTextContent('Failure emails need a recipient');
    expect(onClose).not.toHaveBeenCalled();
  });
});
