/**
 * Editing a plan must open THAT plan.
 *
 * Reported from the admin panel: clicking Edit on any row opened another
 * plan's details. Every field on the form is initialised once, from the
 * `initial` prop, so whichever plan React decides that form instance
 * belongs to is the plan the operator then edits — and saves over.
 */
import { render, screen, fireEvent } from '@testing-library/react';
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

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function W({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  };
}

const plan = (id: string, code: string, cpu: string) => ({
  id, code, name: code, description: null,
  cpuLimit: cpu, cpuTier: null, cpuBurstCores: null,
  memoryLimit: '1.00', storageLimit: '10.00', bandwidthGbLimit: 100,
  monthlyPriceUsd: '5.00', maxSubUsers: 3, maxMailboxes: 50,
  maxMailboxSizeMb: 1024, emailHourlySendLimit: 50, emailDailySendLimit: 100,
  allowCustomContainers: false, status: 'active',
});

const THREE = [
  plan('p-starter', 'starter', '0.25'),
  plan('p-premium', 'premium', '1.00'),
  plan('p-ultimate', 'ultimate', '2.00'),
];

describe('PlansPage — Edit opens the row you clicked', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it.each([
    ['p-starter', 'starter'],
    ['p-premium', 'premium'],
    ['p-ultimate', 'ultimate'],
  ])('clicking Edit on %s loads that plan into the form', async (id, code) => {
    mockApiFetch.mockResolvedValue({ data: THREE });
    render(<PlansPage />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByTestId(`edit-plan-${id}`));
    expect(await screen.findByTestId('plan-code-input')).toHaveValue(code);
  });

  /**
   * ★ The sequence that matters. Opening one plan, closing it and opening
   * another is exactly what an operator comparing two plans does, and it is
   * where a reused form instance shows the first plan's values.
   */
  it('shows the SECOND plan after editing the first and cancelling', async () => {
    mockApiFetch.mockResolvedValue({ data: THREE });
    render(<PlansPage />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByTestId('edit-plan-p-starter'));
    expect(await screen.findByTestId('plan-code-input')).toHaveValue('starter');
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(await screen.findByTestId('edit-plan-p-ultimate'));
    expect(await screen.findByTestId('plan-code-input')).toHaveValue('ultimate');
  });

  it('only one row is in edit mode at a time', async () => {
    mockApiFetch.mockResolvedValue({ data: THREE });
    render(<PlansPage />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByTestId('edit-plan-p-premium'));
    expect(screen.getAllByTestId('edit-plan-form')).toHaveLength(1);
    // And the other two rows are still rows.
    expect(screen.getByTestId('plan-p-starter')).toBeInTheDocument();
    expect(screen.getByTestId('plan-p-ultimate')).toBeInTheDocument();
  });
});
