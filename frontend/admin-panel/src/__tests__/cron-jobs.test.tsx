import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CronJobsTab from '../pages/tenants/CronJobsTab';
import CronJobModal from '../components/CronJobModal';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message); this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({ data: [] } as never);
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('CronJobsTab', () => {
  // Heading "Cron Jobs" now lives on the parent TenantsLayout (tab strip),
  // not on the tab body itself. We assert the in-tab affordances here;
  // layout-level assertions belong with the layout test.
  it('renders searchable tenant selector', () => {
    render(<CronJobsTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('tenant-search-select')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tenants...')).toBeInTheDocument();
  });

  it('shows all tenants by default without a prompt to select', () => {
    render(<CronJobsTab />, { wrapper: createWrapper() });
    expect(screen.queryByTestId('select-tenant-prompt')).not.toBeInTheDocument();
  });

  it('renders Add Cron Job button', () => {
    render(<CronJobsTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument();
    expect(screen.getByText('Add Cron Job')).toBeInTheDocument();
  });

  it('disables Add Cron Job button when no tenant selected', () => {
    render(<CronJobsTab />, { wrapper: createWrapper() });
    expect(screen.getByTestId('add-cron-job-button')).toBeDisabled();
  });
});

describe('CronJobModal', () => {
  it('renders form fields when open', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('create-cron-job-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Cron Job' })).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-schedule-input')).toBeInTheDocument();
    // Default type is webcron — shows URL field, not command
    expect(screen.getByTestId('cron-job-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-enabled-checkbox')).toBeInTheDocument();
  });

  it('is hidden when closed', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={false} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.queryByTestId('create-cron-job-modal')).not.toBeInTheDocument();
  });

  it('has required name field', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-name-input')).toBeRequired();
  });

  it('has required schedule field', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-schedule-input')).toBeRequired();
  });

  it('has required URL field for webcron type', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('cron-job-url-input')).toBeRequired();
  });

  it('defaults enabled checkbox to checked', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    const checkbox = screen.getByTestId('cron-job-enabled-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('has submit and cancel buttons', () => {
    const onClose = vi.fn();
    render(<CronJobModal open={true} onClose={onClose} tenantId="tenant-1" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByTestId('submit-cron-job-button')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });
});

// ── Editing a saved job from the admin tab ───────────────────────────────────
//
// The tab could create, bulk-enable, bulk-disable and bulk-delete, but a saved
// job could not be corrected from here at all — the same modal now opens in
// edit mode instead of a second form that would drift from the first.
describe('CronJobModal in edit mode', () => {
  const JOB = {
    id: 'cj1', tenantId: 'tenant-9', name: 'nightly', type: 'webcron' as const,
    schedule: '0 3 * * *', url: 'https://example.test/cron.php', httpMethod: 'POST',
    command: null, deploymentId: null, timeoutSeconds: 900, timezone: 'Europe/Berlin',
    enabled: 1, lastRunAt: null, lastRunStatus: null, lastRunDurationMs: null,
    lastRunResponseCode: null, lastRunOutput: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };

  function patchCall() {
    return mockApiFetch.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
    );
  }

  it('opens titled Edit, prefilled, with the type locked', async () => {
    render(<CronJobModal open job={JOB as never} onClose={() => {}} tenantId="tenant-9" />, {
      wrapper: createWrapper(),
    });
    expect(screen.getByText('Edit Cron Job')).toBeInTheDocument();
    expect(screen.getByTestId('cron-job-name-input')).toHaveValue('nightly');
    expect(screen.getByTestId('cron-job-schedule-input')).toHaveValue('0 3 * * *');
    expect(screen.getByTestId('cron-job-url-input')).toHaveValue('https://example.test/cron.php');
    expect(screen.getByTestId('cron-job-method-select')).toHaveValue('POST');
    expect(screen.getByTestId('cron-type-webcron')).toBeDisabled();
    expect(screen.getByTestId('submit-cron-job-button')).toHaveTextContent('Save Changes');
  });

  it('PATCHes the job on its OWN tenant, not the tab filter', async () => {
    const user = userEvent.setup();
    render(<CronJobModal open job={JOB as never} onClose={() => {}} tenantId="tenant-filter" />, {
      wrapper: createWrapper(),
    });
    await user.clear(screen.getByTestId('cron-job-name-input'));
    await user.type(screen.getByTestId('cron-job-name-input'), 'renamed');
    await user.click(screen.getByTestId('submit-cron-job-button'));

    await waitFor(() => expect(patchCall()).toBeDefined());
    expect(patchCall()![0]).toBe('/api/v1/tenants/tenant-9/cron-jobs/cj1');
    expect(JSON.parse((patchCall()![1] as { body: string }).body)).toMatchObject({ name: 'renamed' });
  });

  // This modal has no timeout or timezone input. Omitted means "leave it"; a
  // null would clear a pin the admin cannot even see on this screen.
  it('never touches the fields it does not show', async () => {
    const user = userEvent.setup();
    render(<CronJobModal open job={JOB as never} onClose={() => {}} tenantId="tenant-9" />, {
      wrapper: createWrapper(),
    });
    await user.click(screen.getByTestId('submit-cron-job-button'));

    await waitFor(() => expect(patchCall()).toBeDefined());
    const body = JSON.parse((patchCall()![1] as { body: string }).body);
    expect('timeout_seconds' in body).toBe(false);
    expect('timezone' in body).toBe(false);
    expect('type' in body).toBe(false);
  });

  it('still POSTs a new job when no job is supplied', async () => {
    const user = userEvent.setup();
    render(<CronJobModal open onClose={() => {}} tenantId="tenant-9" />, { wrapper: createWrapper() });
    await user.type(screen.getByTestId('cron-job-url-input'), 'https://example.test/x.php');
    await user.type(screen.getByTestId('cron-job-name-input'), 'new-one');
    await user.type(screen.getByTestId('cron-job-schedule-input'), '*/5 * * * *');
    await user.click(screen.getByTestId('submit-cron-job-button'));

    await waitFor(() => {
      const post = mockApiFetch.mock.calls.find(([, i]) => (i as { method?: string })?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as { body: string }).body)).toMatchObject({ type: 'webcron', name: 'new-one' });
    });
    expect(patchCall()).toBeUndefined();
  });
});
