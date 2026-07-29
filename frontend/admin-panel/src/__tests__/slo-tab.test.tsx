import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import SloTab from '../components/SloTab';

/**
 * The rule table's sort keys are derived (`evaluatedTs`, `stateRank`) rather
 * than raw fields, specifically so nullable columns sort the way an operator
 * reads them. These tests pin that behaviour — it is easy to "simplify" back to
 * sorting `lastEvaluatedAt` directly and silently float never-evaluated rules to
 * the top.
 */

const RULES = [
  {
    id: 'r-old', name: 'Oldest rule', description: 'evaluated first', severity: 'warning',
    enabled: true, state: 'ok', since: null, lastValue: 1,
    lastEvaluatedAt: '2026-07-28T10:00:00.000Z',
  },
  {
    id: 'r-never', name: 'Never evaluated', description: 'no run yet', severity: 'warning',
    enabled: true, state: 'ok', since: null, lastValue: null,
    lastEvaluatedAt: null,
  },
  {
    id: 'r-new', name: 'Newest rule', description: 'evaluated last', severity: 'critical',
    enabled: true, state: 'firing', since: '2026-07-28T11:00:00.000Z', lastValue: 9,
    lastEvaluatedAt: '2026-07-28T12:00:00.000Z',
  },
  {
    id: 'r-off', name: 'Disabled rule', description: 'switched off', severity: 'warning',
    enabled: false, state: null, since: null, lastValue: null,
    lastEvaluatedAt: '2026-07-28T11:00:00.000Z',
  },
];

vi.mock('@/lib/api-client', () => ({
  apiFetch: (path: string) => {
    if (path.endsWith('/admin/monitoring/slo')) {
      return Promise.resolve({ data: { rules: RULES, vmReachable: true, lastEvaluationAt: '2026-07-28T12:00:00.000Z' } });
    }
    // Panel series proxy — the sparkline cards; empty is fine here.
    return Promise.resolve({ data: { series: [] } });
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { readonly children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

/** Rule names in render order, skipping the header row. */
async function ruleOrder(): Promise<string[]> {
  // The thead renders before the query resolves, so findAllByRole('row')
  // succeeds with just the header. Wait for every rule row to land.
  await waitFor(() => {
    expect(screen.getAllByRole('row')).toHaveLength(RULES.length + 1);
  });
  const rows = screen.getAllByRole('row');
  return rows
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '')
    .map((t) => t.replace(/(evaluated first|no run yet|evaluated last|switched off)/, '').trim());
}

describe('SloTab rule table', () => {
  it('puts State in the first column', async () => {
    render(<SloTab />, { wrapper: createWrapper() });
    const rows = await screen.findAllByRole('row');
    const headers = within(rows[0]).getAllByRole('columnheader');
    expect(headers[0]).toHaveTextContent('State');
    expect(headers[1]).toHaveTextContent('Rule');
  });

  it('defaults to newest-evaluated first, with never-evaluated rules LAST', async () => {
    render(<SloTab />, { wrapper: createWrapper() });
    const order = await ruleOrder();
    expect(order[0]).toBe('Newest rule');
    expect(order[order.length - 1]).toBe('Never evaluated');
  });

  it('sorts by state worst-first: firing, then ok, then disabled', async () => {
    const user = userEvent.setup();
    render(<SloTab />, { wrapper: createWrapper() });
    await screen.findByTestId('sort-stateRank');
    await user.click(screen.getByTestId('sort-stateRank'));

    const order = await ruleOrder();
    expect(order[0]).toBe('Newest rule');      // the only firing rule
    expect(order[order.length - 1]).toBe('Disabled rule');
  });

  it('is sortable by rule name', async () => {
    const user = userEvent.setup();
    render(<SloTab />, { wrapper: createWrapper() });
    await screen.findByTestId('sort-name');
    await user.click(screen.getByTestId('sort-name'));

    const order = await ruleOrder();
    expect(order).toEqual([...order].sort((a, b) => a.localeCompare(b)));
  });

  it('renders a distinct state badge per state', async () => {
    render(<SloTab />, { wrapper: createWrapper() });
    expect(await screen.findByTestId('slo-state-firing')).toBeInTheDocument();
    expect(screen.getByTestId('slo-state-disabled')).toBeInTheDocument();
    expect(screen.getAllByTestId('slo-state-ok').length).toBeGreaterThan(0);
  });
});
