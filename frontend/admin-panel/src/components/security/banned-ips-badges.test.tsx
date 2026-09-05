/**
 * Banned IPs table — decision badges.
 *
 * The WAF auto-ban scheduler bans through the same `addBan` helper an
 * operator does (actor='autoban-scheduler'), so its CrowdSec scenario also
 * starts with `admin-panel:`. Every automatic ban therefore came back
 * `manualByOperator: true` and rendered in this table as **manual** — the
 * table claimed a human had clicked something nobody clicked. Observed on
 * DEV 2026-09-05 with scenario
 * `admin-panel:autoban-scheduler:auto-ban:rules 920450,930120 count 6`.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { BannedIpsTab } from './web-defense-tabs';

const decision = (over: Record<string, unknown>) => ({
  id: 1,
  origin: 'cscli',
  type: 'ban',
  scope: 'Ip',
  value: '203.0.113.77',
  scenario: 'admin-panel:autoban-scheduler:auto-ban:rules 920450,930120 count 6',
  duration: '1h',
  expiresAt: '2026-09-05T10:33:26.777Z',
  manualByOperator: false,
  staticByOperator: false,
  autoBanned: true,
  simulated: false,
  ...over,
});

const decisions = vi.fn();

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useCrowdsecDecisions: () => decisions(),
    useDeleteCrowdsecDecision: mut,
    useAddCrowdsecAllowlistEntry: mut,
    useAddCrowdsecBan: mut,
    useAddCrowdsecStaticBan: mut,
    useCalibrateAutoban: mut,
    useCrowdsecAllowlist: idle,
    useCrowdsecAutobanConfig: idle,
    useCrowdsecAutobanRuns: idle,
    useCrowdsecConsoleStatus: idle,
    useCrowdsecL4Status: idle,
    useCrowdsecStatus: idle,
    useDisenrollCrowdsecConsole: mut,
    useEnrollCrowdsecConsole: mut,
    usePatchCrowdsecAutobanConfig: mut,
    usePatchCrowdsecConsoleMeta: mut,
    usePatchCrowdsecL4Mode: mut,
    usePruneCrowdsecBouncers: mut,
    useRemoveCrowdsecAllowlistEntry: mut,
  };
});

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const withDecisions = (rows: unknown[]) => {
  decisions.mockReturnValue({
    data: { data: { decisions: rows, total: rows.length } },
    isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
  });
};

describe('Banned IPs — auto-ban badge', () => {
  it('tags a scheduler ban as auto-ban', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('ban-badge-auto')).toHaveTextContent(/auto-ban/i);
  });

  it('does NOT also label that row "manual"', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    // The whole point: an automatic ban must not read as an operator action.
    expect(screen.queryByTestId('ban-badge-manual')).not.toBeInTheDocument();
  });

  it('still labels a real operator ban "manual" and shows no auto-ban badge', () => {
    withDecisions([decision({
      scenario: 'admin-panel:user-123:probing /.env',
      manualByOperator: true,
      autoBanned: false,
    })]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('ban-badge-auto')).not.toBeInTheDocument();
    expect(screen.getByTestId('ban-badge-manual')).toHaveTextContent(/manual/i);
  });

  it('offers an auto-bans-only filter', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('bans-filter-auto')).toBeInTheDocument();
  });
});
