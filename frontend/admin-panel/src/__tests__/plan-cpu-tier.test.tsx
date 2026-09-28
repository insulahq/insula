import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import PlansPage from '../pages/platform/PlansPage';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

const mockApiFetch = vi.mocked(apiFetch);

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const plan = (o: Record<string, unknown> = {}) => ({
  id: 'p1', code: 'starter', name: 'Starter', description: null,
  cpuLimit: '0.50', cpuTier: null, cpuBurstCores: null,
  memoryLimit: '1.00', storageLimit: '10.00', bandwidthGbLimit: 100,
  monthlyPriceUsd: '5.00', maxSubUsers: 3, maxMailboxes: 50,
  maxMailboxSizeMb: 1024, emailHourlySendLimit: 50, emailDailySendLimit: 100,
  allowCustomContainers: false, status: 'active', ...o,
});

/** The body of the last create/update call the page made. */
function lastWrite(): Record<string, unknown> | null {
  for (let i = mockApiFetch.mock.calls.length - 1; i >= 0; i -= 1) {
    const [, init] = mockApiFetch.mock.calls[i] as [string, { method?: string; body?: string } | undefined];
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      return JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    }
  }
  return null;
}

describe('PlansPage — CPU tier and burst ceiling (ADR-062)', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('shows a plan its tier and ceiling once it has them', async () => {
    mockApiFetch.mockResolvedValue({ data: [plan({ cpuTier: 'high', cpuBurstCores: '2.00' })] });
    render(<PlansPage />, { wrapper: createWrapper() });
    expect(await screen.findByTestId('plan-tier-starter')).toHaveTextContent('high');
  });

  /**
   * ★ A plan that has never expressed a tier must not silently acquire one
   * the moment someone opens the form and saves an unrelated field. The
   * control's first option is "derive automatically", and it has to travel as
   * null — not as the first real tier, and not as a 0 ceiling.
   */
  it('sends null, not a tier or a zero, when left on "derive automatically"', async () => {
    mockApiFetch.mockResolvedValue({ data: [plan()] });
    render(<PlansPage />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByTestId('add-plan-button'));

    fireEvent.change(screen.getByTestId('plan-code-input'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('plan-name-input'), { target: { value: 'X' } });
    fireEvent.submit(screen.getByTestId('add-plan-form'));

    await waitFor(() => expect(lastWrite()).not.toBeNull());
    expect(lastWrite()).toMatchObject({ cpu_tier: null, cpu_burst_cores: null });
  });

  it('sends the tier and ceiling an admin actually chose', async () => {
    mockApiFetch.mockResolvedValue({ data: [plan()] });
    render(<PlansPage />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByTestId('add-plan-button'));

    fireEvent.change(screen.getByTestId('plan-code-input'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('plan-name-input'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('plan-cpu-tier'), { target: { value: 'highest' } });
    fireEvent.change(screen.getByTestId('plan-cpu-burst'), { target: { value: '4' } });
    fireEvent.submit(screen.getByTestId('add-plan-form'));

    await waitFor(() => expect(lastWrite()).not.toBeNull());
    expect(lastWrite()).toMatchObject({ cpu_tier: 'highest', cpu_burst_cores: 4 });
  });

  // Editing an existing plan must round-trip what it already has, rather than
  // resetting it to "derive" because the form did not load it.
  it('loads an existing tier into the edit form', async () => {
    mockApiFetch.mockResolvedValue({ data: [plan({ cpuTier: 'normal', cpuBurstCores: '1.50' })] });
    render(<PlansPage />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByTestId('edit-plan-p1'));
    await waitFor(() => expect(screen.getByTestId('plan-cpu-tier')).toHaveValue('normal'));
    expect(screen.getByTestId('plan-cpu-burst')).toHaveValue('1.50');
  });

  /**
   * ★ Number('2 cores') is NaN, and JSON.stringify serialises NaN as null —
   * so a typo travelled as "inherit" and the admin watched their value
   * disappear with no error at all. It must be refused, not guessed at.
   */
  it('refuses a non-numeric burst ceiling instead of sending "inherit"', async () => {
    mockApiFetch.mockResolvedValue({ data: [plan()] });
    render(<PlansPage />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByTestId('add-plan-button'));

    fireEvent.change(screen.getByTestId('plan-code-input'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('plan-name-input'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('plan-cpu-burst'), { target: { value: '2 cores' } });
    fireEvent.submit(screen.getByTestId('add-plan-form'));

    expect(await screen.findByText(/must be a number of cores/i)).toBeInTheDocument();
    // …and nothing was written.
    expect(lastWrite()).toBeNull();
  });
});
