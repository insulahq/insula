import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PlansPage from '../pages/platform/PlansPage';
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlansPage', () => {
  it('shows loading state while fetching', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<PlansPage />, { wrapper: createWrapper() });
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('renders page heading and description', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('Hosting Plans')).toBeInTheDocument();
    });
    expect(screen.getByText('Manage hosting plans and resource limits.')).toBeInTheDocument();
  });

  it('shows empty state when no plans exist', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('No hosting plans configured.')).toBeInTheDocument();
    });
  });

  it('shows add plan button', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-plan-button')).toBeInTheDocument();
    });
    expect(screen.getByText('Add Plan')).toBeInTheDocument();
  });

  it('shows add form when button is clicked', async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-plan-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-plan-button'));
    expect(screen.getByTestId('add-plan-form')).toBeInTheDocument();
    expect(screen.getByTestId('plan-code-input')).toBeInTheDocument();
    expect(screen.getByTestId('plan-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('plan-price-input')).toBeInTheDocument();
  });

  it('renders plan rows when data is returned', async () => {
    mockApiFetch.mockResolvedValue({
      data: [
        {
          id: 'plan-1',
          code: 'starter',
          name: 'Starter',
          description: 'Entry level plan',
          cpuLimit: '0.50',
          memoryLimit: '1.00',
          storageLimit: '10.00',
          monthlyPriceUsd: '5.00',
          maxSubUsers: 3,
          status: 'active',
        },
      ],
    });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('plan-plan-1')).toBeInTheDocument();
    });
    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('starter')).toBeInTheDocument();
    expect(screen.getByText('$5.00/mo')).toBeInTheDocument();
  });
  // ── A plan with no mail ──────────────────────────────────────────
  //
  // The input carried min={1} while the contract accepted min(0), so a plan
  // that grants no mailboxes could not be expressed here at all — the same
  // asymmetry the per-tenant override had.

  const openAddForm = async () => {
    mockApiFetch.mockResolvedValue({ data: [] });
    render(<PlansPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByTestId('add-plan-button')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('add-plan-button'));
  };

  it('lets Max Mailboxes go to 0', async () => {
    await openAddForm();
    const input = screen.getByTestId('plan-max-mailboxes-input') as HTMLInputElement;
    expect(input.min).toBe('0');
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('0');
    expect(input.checkValidity()).toBe(true);
  });

  it('warns that a plan at 0 reaches every tenant on it', async () => {
    await openAddForm();
    fireEvent.change(screen.getByTestId('plan-max-mailboxes-input'), { target: { value: '0' } });
    expect(screen.getByTestId('plan-zero-mailboxes-hint').textContent)
      .toMatch(/every tenant on this plan/i);
  });

  it('does not warn at a non-zero value', async () => {
    await openAddForm();
    fireEvent.change(screen.getByTestId('plan-max-mailboxes-input'), { target: { value: '25' } });
    expect(screen.queryByTestId('plan-zero-mailboxes-hint')).toBeNull();
  });

  // `Number('')` is 0. Now that 0 means "no mail", an empty box would take
  // mail away from every tenant on the plan — so the field must be required
  // rather than quietly defaulting.
  it('refuses to submit Max Mailboxes empty rather than sending 0', async () => {
    await openAddForm();
    const input = screen.getByTestId('plan-max-mailboxes-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.required).toBe(true);
    expect(input.checkValidity()).toBe(false);
  });

  it('applies the same guard to Max Sub-Users', async () => {
    await openAddForm();
    const input = screen.getByTestId('plan-max-sub-users-input') as HTMLInputElement;
    expect(input.min).toBe('0');
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.checkValidity()).toBe(true);
    fireEvent.change(input, { target: { value: '' } });
    expect(input.checkValidity()).toBe(false);
  });
});
