import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CronJobs from '../pages/CronJobs';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/hooks/use-tenant-context', () => ({
  useTenantContext: vi.fn(() => ({ tenantId: 'c1', tenantName: 'Test Corp', isLoading: false })),
}));

// Phase 6: CronJobs now uses useCanManage which reads from useAuth.
// Default to tenant_admin so the existing tests still see the Add button.
const _mockAuthUser = { id: 'u1', email: 'u@c1.com', fullName: 'Me', role: 'tenant_admin' };
vi.mock('@/hooks/use-auth', () => ({
  useAuth: <T,>(selector?: (state: { user: typeof _mockAuthUser }) => T) => {
    const state = { user: _mockAuthUser };
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

const _MOCK_CLIENT = { id: 'c1', name: 'Test Corp' };
const MOCK_JOBS = [
  { id: 'cj1', tenantId: 'c1', name: 'daily-backup', schedule: '0 2 * * *', command: '/bin/backup.sh', enabled: 1, lastRunAt: '2026-01-10T02:00:00Z', lastRunStatus: 'success', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-10T02:00:00Z' },
  { id: 'cj2', tenantId: 'c1', name: 'cleanup', schedule: '0 0 * * 0', command: '/bin/cleanup.sh', enabled: 0, lastRunAt: null, lastRunStatus: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

function setupMocks() {
  mockApiFetch.mockImplementation((url: string) => {
    if (url.includes('/cron-jobs')) return Promise.resolve({ data: MOCK_JOBS, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Tenant CronJobs page', () => {
  it('renders heading', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-heading')).toHaveTextContent('Cron Jobs'));
  });

  it('renders cron job rows', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-table')).toBeInTheDocument());
    expect(screen.getByText('daily-backup')).toBeInTheDocument();
    expect(screen.getByText('cleanup')).toBeInTheDocument();
  });

  it('shows add cron job button', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument());
  });

  it('shows create form on click', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('add-cron-job-button')).toBeInTheDocument());
    await user.click(screen.getByTestId('add-cron-job-button'));
    expect(screen.getByTestId('cron-job-form')).toBeInTheDocument();
    expect(screen.getByTestId('cron-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('cron-schedule-input')).toBeInTheDocument();
    // Default type is webcron — shows URL field
    expect(screen.getByTestId('cron-url-input')).toBeInTheDocument();
  });

  it('has start/stop toggle per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('toggle-cron-cj1')).toBeInTheDocument());
    expect(screen.getByTestId('toggle-cron-cj2')).toBeInTheDocument();
  });

  it('has run-now button per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('run-cron-cj1')).toBeInTheDocument());
  });

  it('has delete button per cron job', async () => {
    setupMocks();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('delete-cron-cj1')).toBeInTheDocument());
  });

  it('shows empty state when no cron jobs', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/cron-jobs')) return Promise.resolve({ data: [], pagination: { total_count: 0, cursor: null, has_more: false, page_size: 50 } });
      return Promise.resolve({ data: [] });
    });
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('cron-jobs-empty')).toBeInTheDocument());
  });

  // ── Action icons ───────────────────────────────────────────────────────────
  // Pinned because the operator specified them explicitly and a swap is easy to
  // make by accident: the three actions must stay visually distinct. A stopped
  // task's Start control and Run Now previously both rendered a play triangle.
  //
  // Asserted via lucide's own `lucide-<name>` class on the emitted <svg> — the
  // icon identity is the thing under test, and there is no other handle on it.
  describe('action icons are distinct and correct', () => {
    it('a running task offers STOP (solid square); a stopped one offers PLAY', async () => {
      setupMocks();
      render(<CronJobs />, { wrapper: createWrapper() });
      // cj1 is enabled, cj2 is not.
      await waitFor(() => expect(screen.getByTestId('toggle-cron-cj1')).toBeInTheDocument());

      const running = screen.getByTestId('toggle-cron-cj1').querySelector('svg');
      expect(running?.getAttribute('class')).toContain('lucide-square');
      // Solid, not an outline box — an unfilled square reads as a checkbox.
      expect(running?.getAttribute('fill')).toBe('currentColor');

      const stopped = screen.getByTestId('toggle-cron-cj2').querySelector('svg');
      expect(stopped?.getAttribute('class')).toContain('lucide-play');
    });

    it('Run Now is a lightning bolt, on both a running and a stopped task', async () => {
      setupMocks();
      render(<CronJobs />, { wrapper: createWrapper() });
      await waitFor(() => expect(screen.getByTestId('run-cron-cj1')).toBeInTheDocument());
      for (const id of ['cj1', 'cj2']) {
        const svg = screen.getByTestId(`run-cron-${id}`).querySelector('svg');
        expect(svg?.getAttribute('class')).toContain('lucide-zap');
      }
    });

    it('Run Now never shares a glyph with the enable toggle', async () => {
      setupMocks();
      render(<CronJobs />, { wrapper: createWrapper() });
      await waitFor(() => expect(screen.getByTestId('run-cron-cj2')).toBeInTheDocument());
      // cj2 is stopped — the case where both used to be a play triangle.
      const toggleClass = screen.getByTestId('toggle-cron-cj2').querySelector('svg')?.getAttribute('class');
      const runClass = screen.getByTestId('run-cron-cj2').querySelector('svg')?.getAttribute('class');
      // Both must EXIST before "they differ" means anything — two missing icons
      // would satisfy `not.toBe` and report a pass for a blank row.
      expect(typeof toggleClass).toBe('string');
      expect(typeof runClass).toBe('string');
      expect(toggleClass).not.toBe(runClass);
    });
  });
});

// ── Editing a saved task ─────────────────────────────────────────────────────
//
// The page could create, enable, disable, run and delete a task, but a saved
// one could never be corrected — a typo in a schedule or a URL meant deleting
// and re-entering the whole job, losing its run history with it. The PATCH
// endpoint had accepted every field all along; only the panel could not reach
// it (`useUpdateCronJob` was typed `{ enabled?: boolean }`).
describe('editing a saved cron job', () => {
  const EDITABLE_JOBS = [
    {
      id: 'cj1', tenantId: 'c1', name: 'daily-backup', type: 'webcron',
      schedule: '0 2 * * *', url: 'https://example.test/cron.php', httpMethod: 'GET',
      command: null, deploymentId: null, timeoutSeconds: 600, timezone: 'Europe/Berlin',
      enabled: 1, lastRunAt: null, lastRunStatus: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'cj2', tenantId: 'c1', name: 'moodle-cron', type: 'deployment',
      schedule: '* * * * *', url: null, httpMethod: null,
      command: 'php admin/cli/cron.php', deploymentId: '11111111-2222-4333-8444-555555555555',
      timeoutSeconds: null, timezone: null,
      enabled: 1, lastRunAt: null, lastRunStatus: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    },
  ];

  function setupEditable() {
    mockApiFetch.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/cron-jobs') && init?.method === 'PATCH') {
        return Promise.resolve({ data: EDITABLE_JOBS[0] });
      }
      if (url.includes('/cron-jobs')) {
        return Promise.resolve({ data: EDITABLE_JOBS, pagination: { total_count: 2, cursor: null, has_more: false, page_size: 50 } });
      }
      return Promise.resolve({ data: [] });
    });
  }

  /** The PATCH body the page sent, parsed. */
  function patchBody() {
    const call = mockApiFetch.mock.calls.find(
      ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH',
    );
    expect(call, 'expected a PATCH request').toBeDefined();
    return JSON.parse((call![1] as { body: string }).body);
  }

  it('offers an edit button on every row', async () => {
    setupEditable();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    expect(screen.getByTestId('edit-cron-cj2')).toBeInTheDocument();
    expect(screen.getByTestId('edit-cron-cj1').querySelector('svg')?.getAttribute('class'))
      .toContain('lucide-pencil');
  });

  it('loads the saved values into the form — not a blank one', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));

    expect(screen.getByTestId('cron-edit-banner')).toHaveTextContent('daily-backup');
    expect(screen.getByTestId('cron-name-input')).toHaveValue('daily-backup');
    expect(screen.getByTestId('cron-schedule-input')).toHaveValue('0 2 * * *');
    expect(screen.getByTestId('cron-url-input')).toHaveValue('https://example.test/cron.php');
    expect(screen.getByTestId('cron-timeout-input')).toHaveValue(600);
  });

  it('shows the deployment fields when editing a deployment task', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj2')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj2'));

    expect(screen.getByTestId('cron-command-input')).toHaveValue('php admin/cli/cron.php');
    expect(screen.queryByTestId('cron-url-input')).not.toBeInTheDocument();
  });

  // Type decides which field set the scheduler reads; flipping it would leave
  // the row holding both a url and a command.
  it('locks the type while editing', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));

    expect(screen.getByTestId('cron-type-webcron')).toBeDisabled();
    expect(screen.getByTestId('cron-type-deployment')).toBeDisabled();
  });

  it('PATCHes the edited fields to that job', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));

    await user.clear(screen.getByTestId('cron-schedule-input'));
    await user.type(screen.getByTestId('cron-schedule-input'), '30 3 * * *');
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(patchBody().schedule).toBe('30 3 * * *'));
    const call = mockApiFetch.mock.calls.find(([, i]) => (i as { method?: string })?.method === 'PATCH');
    expect(call![0]).toContain('/cron-jobs/cj1');
    expect(patchBody()).toMatchObject({
      name: 'daily-backup',
      url: 'https://example.test/cron.php',
      http_method: 'GET',
      timeout_seconds: 600,
      timezone: 'Europe/Berlin',
    });
  });

  // Omitting a field means "leave it alone", so a cleared box has to send null
  // or the pin survives a save that visibly removed it.
  it('sends null when a pinned timeout is cleared, not nothing', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));

    await user.clear(screen.getByTestId('cron-timeout-input'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'PATCH')).toBe(true));
    const body = patchBody();
    expect(body.timeout_seconds).toBeNull();
    expect('timeout_seconds' in body).toBe(true);
  });

  it('never sends the other type’s fields', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'PATCH')).toBe(true));
    const body = patchBody();
    expect('command' in body).toBe(false);
    expect('deployment_id' in body).toBe(false);
  });

  it('closes the form and forgets the job after saving', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('edit-cron-cj1'));
    await user.click(screen.getByTestId('submit-cron-job'));

    await waitFor(() => expect(screen.queryByTestId('cron-job-form')).not.toBeInTheDocument());
  });

  // A half-loaded form left behind after Cancel is how an edit becomes an
  // accidental create with someone else's values in it.
  it('Cancel clears the loaded job so the next Add starts blank', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('edit-cron-cj1')).toBeInTheDocument());

    await user.click(screen.getByTestId('edit-cron-cj1'));
    await user.click(screen.getByTestId('cancel-cron-edit'));
    expect(screen.queryByTestId('cron-job-form')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('add-cron-job-button'));
    expect(screen.getByTestId('cron-name-input')).toHaveValue('');
    expect(screen.queryByTestId('cron-edit-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('cron-type-webcron')).not.toBeDisabled();
  });

  it('the enable/disable toggle still sends only `enabled`', async () => {
    setupEditable();
    const user = userEvent.setup();
    render(<CronJobs />, { wrapper: createWrapper() });
    await waitFor(() => expect(screen.getByTestId('toggle-cron-cj1')).toBeInTheDocument());
    await user.click(screen.getByTestId('toggle-cron-cj1'));

    await waitFor(() => expect(mockApiFetch.mock.calls.some(([, i]) => (i as { method?: string })?.method === 'PATCH')).toBe(true));
    expect(patchBody()).toEqual({ enabled: false });
  });
});
