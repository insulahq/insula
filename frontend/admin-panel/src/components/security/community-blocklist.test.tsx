/**
 * Community blocklist surfaces.
 *
 * The Banned IPs table now lists ONLY platform decisions, so an operator could
 * see a handful of rows and conclude that is everything being blocked while
 * tens of thousands of community bans are also in force (production: 16,220 vs
 * 2). The banner exists to make that impossible, and the viewer exists so the
 * feed can be inspected and individual IPs excluded.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const decisions = vi.fn();
const community = vi.fn();
const addAllowlist = vi.fn();

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null });
  return {
    useCrowdsecDecisions: () => decisions(),
    useCrowdsecCommunityBlocklist: () => community(),
    useSetCrowdsecCommunityBlocklist: mut,
    useAddCrowdsecAllowlistEntry: () => addAllowlist(),
    useDeleteCrowdsecDecision: mut,
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

import { BannedIpsTab } from './web-defense-tabs';

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const emptyList = {
  data: { data: { decisions: [], totalActive: 16222, totalMatching: 0, limit: 0, offset: 0 } },
  isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
};

beforeEach(() => {
  decisions.mockReturnValue(emptyList);
  addAllowlist.mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, error: null });
});

describe('community blocklist banner on Banned IPs', () => {
  it('announces the count when the feed is enforcing', () => {
    community.mockReturnValue({ data: { data: { enabled: true, decisionCount: 16220, pendingRestart: false } }, isError: false });
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('community-active-banner')).toBeInTheDocument();
    expect(screen.getByText(/16,220/)).toBeInTheDocument();
  });

  it('stays hidden when the feed is off — no banner to ignore', () => {
    community.mockReturnValue({ data: { data: { enabled: false, decisionCount: 0, pendingRestart: false } }, isError: false });
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('community-active-banner')).not.toBeInTheDocument();
  });

  it('does NOT claim the feed is active when the state failed to load', () => {
    // Asserting "active" on a failed read would be a security claim we cannot
    // support; asserting "inactive" would be worse. Render nothing.
    community.mockReturnValue({ data: undefined, isError: true });
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('community-active-banner')).not.toBeInTheDocument();
  });

  it('opens the viewer from the banner', () => {
    community.mockReturnValue({ data: { data: { enabled: true, decisionCount: 16220, pendingRestart: false } }, isError: false });
    render(<BannedIpsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('banner-view-community'));
    expect(screen.getByTestId('community-viewer-search')).toBeInTheDocument();
  });

  it('offers Exclude on each community row and sends it to the allowlist', () => {
    const mutate = vi.fn();
    addAllowlist.mockReturnValue({ mutate, isPending: false, isSuccess: false, isError: false, error: null });
    community.mockReturnValue({ data: { data: { enabled: true, decisionCount: 1, pendingRestart: false } }, isError: false });
    decisions.mockReturnValue({
      data: { data: {
        decisions: [{
          id: 9, origin: 'CAPI', type: 'ban', scope: 'Ip', value: '198.51.100.42',
          scenario: 'crowdsecurity/http-scan', duration: '4h', expiresAt: null,
          manualByOperator: false, staticByOperator: false, autoBanned: false, simulated: false,
        }],
        totalActive: 1, totalMatching: 1, limit: 50, offset: 0,
      } },
      isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
    });
    render(<BannedIpsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('banner-view-community'));
    fireEvent.click(screen.getByTestId('exclude-ip-198.51.100.42'));
    // The allowlist beats every ban regardless of origin — the right-sized fix
    // for one wrongly-listed scanner, versus disabling the whole feed.
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ value: '198.51.100.42', scope: 'Ip' }));
    expect(String(mutate.mock.calls[0][0].comment).length).toBeGreaterThanOrEqual(3);
  });
});
