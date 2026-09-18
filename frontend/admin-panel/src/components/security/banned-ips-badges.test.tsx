/**
 * Banned IPs table — decision badges.
 *
 * The WAF auto-ban scheduler bans through the same `addBan` helper an
 * operator does (actor='autoban-scheduler'), so its CrowdSec scenario also
 * starts with `admin-panel:`. Every automatic ban therefore came back
 * `manualByOperator: true` and rendered in this table as **manual** — the
 * table claimed a human had clicked something nobody clicked. Observed on
 * DEV with scenario
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
  addedBy: 'auto-ban-waf',
  ...over,
});

const decisions = vi.fn();

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useCrowdsecDecisions: () => decisions(),
    // Community blocklist OFF here, so the banner stays hidden and these
    // assertions stay about the badge rendering.
    useCrowdsecCommunityBlocklist: () => ({ data: { data: { enabled: false, decisionCount: 0, pendingRestart: false } }, isError: false }),
    useSetCrowdsecCommunityBlocklist: mut,
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
    useCrowdsecScenarios: idle,
    useSetScenarioSimulation: mut,
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

describe('Banned IPs — who added the ban', () => {
  it('labels a scheduler ban as the WAF engine, not as "cscli"', () => {
    withDecisions([decision({ addedBy: 'auto-ban-waf' })]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('ban-badge-auto-ban-waf')).toHaveTextContent(/auto/i);
  });

  it('does NOT read an automatic ban as an operator action', () => {
    withDecisions([decision({ addedBy: 'auto-ban-waf' })]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('ban-badge-operator')).not.toBeInTheDocument();
  });

  it('gives the AGENT engine its own label instead of the raw origin "crowdsec"', () => {
    // The complaint this replaced: those rows printed `crowdsec`, which reads
    // as a third-party product rather than this platform's own detection.
    withDecisions([decision({
      addedBy: 'auto-ban-traffic',
      origin: 'crowdsec',
      scenario: 'crowdsecurity/http-probing',
    })]);
    render(<BannedIpsTab />, { wrapper });
    const badge = screen.getByTestId('ban-badge-auto-ban-traffic');
    expect(badge.textContent?.toLowerCase()).not.toContain('crowdsec');
    expect(screen.queryByTestId('ban-badge-operator')).not.toBeInTheDocument();
  });

  it('still labels a real operator ban as an operator action', () => {
    withDecisions([decision({
      addedBy: 'operator',
      scenario: 'admin-panel:user-123:probing /.env',
      manualByOperator: true,
      autoBanned: false,
    })]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('ban-badge-auto-ban-waf')).not.toBeInTheDocument();
    expect(screen.getByTestId('ban-badge-operator')).toHaveTextContent(/operator/i);
  });

  it('offers an auto-bans-only filter', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('bans-filter-auto')).toBeInTheDocument();
  });

  it('collapses one address with several scenarios into a single row', () => {
    withDecisions([
      decision({ id: 1, value: '203.0.113.9', scenario: 'crowdsecurity/http-probing' }),
      decision({ id: 2, value: '203.0.113.9', scenario: 'crowdsecurity/http-sensitive-files' }),
      decision({ id: 3, value: '203.0.113.9', scenario: 'crowdsecurity/http-bad-user-agent' }),
    ]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getAllByTestId(/^ban-group-/)).toHaveLength(1);
    expect(screen.getByTestId('ban-group-203.0.113.9')).toHaveTextContent('+2 more');
  });

  it('says so when every decision on an address is simulated', () => {
    // "Banned" for an address that is NOT blocked is the worst thing this
    // table can tell an operator.
    withDecisions([decision({ simulated: true })]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('ban-badge-simulated')).toHaveTextContent(/not enforced/i);
  });
});
