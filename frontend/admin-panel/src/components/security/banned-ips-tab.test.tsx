/**
 * Banned IPs tab — operator requests:
 *
 *   - remove the Static Blocklist section and the "Addresses this platform is
 *     blocking, one row per address…" description;
 *   - move "Add static ban" into "Add manual ban" as a Permanent duration;
 *   - for manual bans, show the OPERATOR NAME as the Added-by tooltip, and
 *     only the reason — without the user id — in the Why column.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decisions, addBan, addStaticBan } = vi.hoisted(() => ({
  decisions: vi.fn(),
  addBan: vi.fn(),
  addStaticBan: vi.fn(),
}));

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useCrowdsecDecisions: () => decisions(),
    useCrowdsecCommunityBlocklist: () => ({ data: { data: { enabled: false, decisionCount: 0, pendingRestart: false } }, isError: false }),
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

import { BannedIpsTab } from './web-defense-tabs';

const ALICE = '11111111-2222-4333-8444-555555555555';
const IN_100_YEARS = new Date(Date.now() + 875_999 * 3_600_000).toISOString();

const decision = (over: Record<string, unknown>) => ({
  id: 1,
  origin: 'cscli',
  type: 'ban',
  scope: 'Ip',
  value: '203.0.113.40',
  scenario: `admin-panel:${ALICE}:probing /.env`,
  duration: '3h59m',
  expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  manualByOperator: true,
  staticByOperator: false,
  autoBanned: false,
  simulated: false,
  addedBy: 'operator',
  operatorReason: 'probing /.env',
  addedByName: 'Alice Admin (alice@example.test)',
  ...over,
});

const permanent = (over: Record<string, unknown> = {}) => decision({
  id: 2,
  value: '203.0.113.41',
  scenario: `admin-panel-static:${ALICE}:known scanner`,
  duration: '875999h59m',
  expiresAt: IN_100_YEARS,
  manualByOperator: false,
  staticByOperator: true,
  addedBy: 'static-list',
  operatorReason: 'known scanner',
  ...over,
});

const withDecisions = (rows: unknown[]) => {
  decisions.mockReturnValue({
    data: { data: { decisions: rows, totalActive: rows.length, totalMatching: rows.length, limit: rows.length, offset: 0 } },
    isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
  });
};

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Every piece of text an operator can see or hover in an element. */
function visibleAndHoverText(el: HTMLElement): string {
  const titles = Array.from(el.querySelectorAll('[title]')).map((n) => n.getAttribute('title'));
  return `${el.textContent ?? ''}\n${titles.join('\n')}`;
}

beforeEach(() => {
  addBan.mockReset();
  addStaticBan.mockReset();
  withDecisions([]);
});

describe('Banned IPs — sections removed', () => {
  it('no longer renders the Static Blocklist section or its button', () => {
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByTestId('static-blocklist-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('static-blocklist-add')).not.toBeInTheDocument();
    expect(screen.queryByText(/static blocklist/i)).not.toBeInTheDocument();
  });

  it('no longer renders the "Addresses this platform is blocking" description', () => {
    render(<BannedIpsTab />, { wrapper });
    expect(screen.queryByText(/Addresses this platform is blocking/i)).not.toBeInTheDocument();
  });

  it('still offers a filter for the permanent bans, named for what they are now', () => {
    render(<BannedIpsTab />, { wrapper });
    const filter = screen.getByTestId('bans-filter-static');
    expect(filter.closest('label')).toHaveTextContent(/permanent/i);
  });
});

describe('Banned IPs — manual ban rows', () => {
  it('puts the operator name in the Added-by tooltip', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    const badge = screen.getByTestId('ban-badge-operator');
    expect(badge).toHaveTextContent(/operator/i);
    expect(badge.getAttribute('title')).toContain('Alice Admin (alice@example.test)');
  });

  it('shows only the reason in the Why column — no user id anywhere on the row', () => {
    withDecisions([decision({})]);
    render(<BannedIpsTab />, { wrapper });
    const row = screen.getByTestId('ban-group-203.0.113.40');
    expect(row).toHaveTextContent('probing /.env');
    expect(visibleAndHoverText(row)).not.toContain(ALICE);
  });

  it('keeps the user id out of the expanded detail rows too', () => {
    withDecisions([
      decision({ id: 1 }),
      decision({ id: 3, scenario: `admin-panel:${ALICE}:second look`, operatorReason: 'second look' }),
    ]);
    render(<BannedIpsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('ban-group-203.0.113.40'));
    const table = screen.getByTestId('bans-table');
    expect(within(table).getByTestId('ban-detail-3')).toHaveTextContent('second look');
    expect(visibleAndHoverText(table)).not.toContain(ALICE);
  });

  it('says the name is unavailable — not the raw id — for a deleted account', () => {
    withDecisions([decision({ addedByName: null })]);
    render(<BannedIpsTab />, { wrapper });
    const title = screen.getByTestId('ban-badge-operator').getAttribute('title') ?? '';
    expect(title).toMatch(/unavailable|no longer exists/i);
    expect(title).not.toContain(ALICE);
  });
});

describe('Banned IPs — permanent bans in the unified list', () => {
  it('lists a permanent ban, labelled as one, with the operator name', () => {
    withDecisions([permanent()]);
    render(<BannedIpsTab />, { wrapper });
    const badge = screen.getByTestId('ban-badge-static-list');
    expect(badge).toHaveTextContent(/operator/i);
    expect(badge).toHaveTextContent(/permanent/i);
    expect(badge.getAttribute('title')).toContain('Alice Admin (alice@example.test)');
    expect(screen.getByTestId('ban-group-203.0.113.41')).toHaveTextContent('known scanner');
  });

  it('reads "Permanent" in Time left instead of a 36,499-day countdown', () => {
    withDecisions([permanent()]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('ban-time-left-203.0.113.41')).toHaveTextContent('Permanent');
    expect(screen.getByTestId('ban-group-203.0.113.41')).not.toHaveTextContent(/\d{4,}d/);
  });

  it('can still be removed from the list', () => {
    withDecisions([permanent()]);
    render(<BannedIpsTab />, { wrapper });
    expect(screen.getByTestId('bans-unban-203.0.113.41')).toBeEnabled();
  });
});

describe('Add manual ban — the Permanent duration', () => {
  const openModal = () => {
    render(<BannedIpsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('bans-add-manual'));
    fireEvent.change(screen.getByTestId('ban-modal-value'), { target: { value: '203.0.113.50' } });
    fireEvent.change(screen.getByTestId('ban-modal-reason'), { target: { value: 'known scanner' } });
  };

  it('offers Permanent alongside the timed durations', () => {
    openModal();
    const options = Array.from(
      (screen.getByTestId('ban-modal-duration') as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toContain('Permanent');
    expect(options).toContain('4 hours');
  });

  it('defaults to a timed ban', () => {
    openModal();
    expect((screen.getByTestId('ban-modal-duration') as HTMLSelectElement).value).toBe('4h');
  });

  it('a Permanent ban goes where "Add static ban" went', () => {
    openModal();
    fireEvent.change(screen.getByTestId('ban-modal-duration'), { target: { value: 'permanent' } });
    expect(screen.getByTestId('ban-modal-permanent-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ban-modal-submit'));
    expect(addStaticBan).toHaveBeenCalledWith(
      { value: '203.0.113.50', scope: 'Ip', reason: 'known scanner' },
      expect.anything(),
    );
    expect(addBan).not.toHaveBeenCalled();
  });

  it('a timed ban still sends its duration', () => {
    openModal();
    fireEvent.change(screen.getByTestId('ban-modal-duration'), { target: { value: '24h' } });
    fireEvent.click(screen.getByTestId('ban-modal-submit'));
    expect(addBan).toHaveBeenCalledWith(
      { value: '203.0.113.50', scope: 'Ip', duration: '24h', reason: 'known scanner' },
      expect.anything(),
    );
    expect(addStaticBan).not.toHaveBeenCalled();
  });

  it('no longer tells the operator their user id is stored in the reason', () => {
    openModal();
    expect(screen.getByTestId('ban-ip-modal')).not.toHaveTextContent(/userId|admin-panel:/);
  });
});
