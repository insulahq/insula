/**
 * WAF Events → block button.
 *
 * The button used to put the source on the separate Static Blocklist, and
 * its hover text said so. That section is gone: the button now opens the
 * shared ban dialog with the Permanent duration preselected, and the
 * operator can still pick a timed ban before confirming.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';

const { addBan, addStaticBan } = vi.hoisted(() => ({ addBan: vi.fn(), addStaticBan: vi.fn() }));

vi.mock('@/hooks/use-waf-events', () => ({
  useWafEvents: () => ({
    data: { data: {
      events: [{
        id: '33333333-4444-4555-8666-777777777777',
        scope: 'admin-host',
        hostname: 'admin.example.test',
        routeId: null,
        tenantId: null,
        ruleId: '930130',
        severity: 'critical',
        message: 'Restricted File Access Attempt',
        requestUri: '/.env',
        requestMethod: 'GET',
        sourceIp: '203.0.113.80',
        occurredAt: '2026-10-05T10:00:00.000Z',
      }],
      truncated: false,
    } },
    isLoading: false, isError: false, isFetching: false, error: null, refetch: vi.fn(),
  }),
  useRefreshWafScraper: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useCrowdsecDecisions: idle,
    useCrowdsecCommunityBlocklist: idle,
    useSetCrowdsecCommunityBlocklist: mut,
    useDeleteCrowdsecDecision: mut,
    useAddCrowdsecAllowlistEntry: mut,
    useAddCrowdsecBan: () => ({ mutate: addBan, isPending: false, isError: false, error: null }),
    useAddCrowdsecStaticBan: () => ({ mutate: addStaticBan, isPending: false, isError: false, error: null }),
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

import { WafEventsTab } from './web-defense-tabs';

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const BUTTON = 'waf-ban-33333333-4444-4555-8666-777777777777';

describe('WAF Events — block button', () => {
  it('describes what it does now — no Static Blocklist', () => {
    render(<WafEventsTab />, { wrapper });
    const title = screen.getByTestId(BUTTON).getAttribute('title') ?? '';
    expect(title).not.toMatch(/static blocklist/i);
    expect(title).toMatch(/Permanent/);
  });

  it('opens the ban dialog with Permanent preselected and the evidence as the reason', () => {
    render(<WafEventsTab />, { wrapper });
    fireEvent.click(screen.getByTestId(BUTTON));
    expect((screen.getByTestId('ban-modal-duration') as HTMLSelectElement).value).toBe('permanent');
    expect((screen.getByTestId('ban-modal-value') as HTMLInputElement).value).toBe('203.0.113.80');
    expect((screen.getByTestId('ban-modal-reason') as HTMLTextAreaElement).value).toContain('930130');
    fireEvent.click(screen.getByTestId('ban-modal-submit'));
    expect(addStaticBan).toHaveBeenCalledWith(
      expect.objectContaining({ value: '203.0.113.80', scope: 'Ip' }),
      expect.anything(),
    );
    expect(addBan).not.toHaveBeenCalled();
  });

  it('still lets the operator choose a timed ban instead', () => {
    addBan.mockReset();
    addStaticBan.mockReset();
    render(<WafEventsTab />, { wrapper });
    fireEvent.click(screen.getByTestId(BUTTON));
    fireEvent.change(screen.getByTestId('ban-modal-duration'), { target: { value: '24h' } });
    fireEvent.click(screen.getByTestId('ban-modal-submit'));
    expect(addBan).toHaveBeenCalledWith(
      expect.objectContaining({ value: '203.0.113.80', duration: '24h' }),
      expect.anything(),
    );
    expect(addStaticBan).not.toHaveBeenCalled();
  });
});
