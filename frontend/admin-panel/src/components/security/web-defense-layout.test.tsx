/**
 * Web Defense layout — the operator's cleanup of the WAF Events header and the
 * WAF Settings tab.
 *
 * WAF Settings, top to bottom: status tiles → Community Blocklist → WAF
 * Auto-Ban → Malicious Traffic Detection → L4 → CrowdSec Console. The intro
 * tile and the "Automatic bans" explainer are gone; the history-style
 * sub-sections (recent auto-ban decisions, log sources, the scenario table)
 * start collapsed; traffic detection has a real Enable/Disable.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scenarios = vi.fn();
const setDetection = vi.fn();
const setDetectionState = vi.fn();
const wafEvents = vi.fn();
const simulationBusy = vi.fn(() => false);

const ok = (data: unknown) => ({ data: { data }, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });

vi.mock('@/hooks/use-crowdsec', () => {
  const idle = () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false });
  const mut = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null, data: undefined });
  return {
    useCrowdsecStatus: () => ok({
      lapiHealthy: true, lapiError: null, capiAuthenticated: true, communityBlocklistEnabled: false,
      machines: [], bouncers: [{ name: 'traefik-1', online: true }], scenariosLoaded: 53,
      coverage: { traefikPodsTotal: 1, traefikPodsCovered: 1, nodesTotal: 1, modsecPodsTotal: 1 },
      decisionCounts: null,
    }),
    useCrowdsecCommunityBlocklist: () => ok({ enabled: false, decisionCount: 0, pendingRestart: false }),
    useSetCrowdsecCommunityBlocklist: mut,
    useCrowdsecAutobanConfig: () => ok({
      enabled: true, windowSeconds: 300, eventThreshold: 20, minSeverity: 'critical',
      initialBanDuration: '1h', repeatBackoffMultiplier: 2, maxBanDuration: '7d',
      excludedRuleIds: ['949110', '913100'], includeTenantRoutes: false,
    }),
    useCrowdsecAutobanRuns: () => ok({
      runs: [{
        id: 'r1', triggeredAt: '2026-01-01T00:00:00.000Z', sourceIp: '203.0.113.9', hostname: 'admin.example.test',
        ruleIds: ['920350'], eventCount: 21, outcome: 'banned', banDuration: '1h', outcomeDetail: null,
      }],
    }),
    usePatchCrowdsecAutobanConfig: mut,
    useCalibrateAutoban: mut,
    useCrowdsecScenarios: () => scenarios(),
    useSetScenarioSimulation: mut,
    useSetTrafficDetection: () => setDetectionState(),
    useSimulationConfigBusy: () => simulationBusy(),
    useCrowdsecL4Status: () => ok({
      mode: 'disabled', totalPods: 1, appliedPods: 1, operatorIp: '198.51.100.7', operatorIpSource: 'x-real-ip',
      operatorIpTrusted: true, trustedRangeCount: 1, clusterPeerCount: 1,
    }),
    usePatchCrowdsecL4Mode: mut,
    useCrowdsecConsoleStatus: () => ok({ enrolled: false, consoleUrl: null, metaEnabled: true, features: [] }),
    useEnrollCrowdsecConsole: mut,
    useDisenrollCrowdsecConsole: mut,
    usePatchCrowdsecConsoleMeta: mut,
    usePruneCrowdsecBouncers: mut,
    useCrowdsecDecisions: idle,
    useAddCrowdsecAllowlistEntry: mut,
    useDeleteCrowdsecDecision: mut,
    useAddCrowdsecBan: mut,
    useAddCrowdsecStaticBan: mut,
    useCrowdsecAllowlist: idle,
    useRemoveCrowdsecAllowlistEntry: mut,
  };
});

vi.mock('@/hooks/use-waf-events', () => ({
  useWafEvents: () => wafEvents(),
  useRefreshWafScraper: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { WafEventsTab, WafSettingsTab } from './web-defense-tabs';

function wrapper({ children }: { readonly children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const SCENARIO_ROWS = [
  { name: 'crowdsecurity/http-probing', description: 'Detect site scanning', status: 'enabled', simulated: false, eventsPoured: 1200, alertsRaised: 4 },
  { name: 'crowdsecurity/http-crawl-non_statics', description: 'Detect aggressive crawl', status: 'enabled', simulated: true, eventsPoured: 30, alertsRaised: 0 },
];

function scenariosPayload(over: Record<string, unknown> = {}) {
  return ok({
    scenarios: SCENARIO_ROWS,
    globalSimulation: false,
    detectionEnabled: true,
    logSources: [{ type: 'traefik', source: '/var/log/traefik/access.log' }],
    error: null,
    ...over,
  });
}

beforeEach(() => {
  scenarios.mockReturnValue(scenariosPayload());
  setDetection.mockReset();
  setDetectionState.mockReturnValue({ mutate: setDetection, isPending: false, isError: false, error: null, data: undefined });
  simulationBusy.mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); });

/** a precedes b in document order */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('WAF Settings — section order and removed sections', () => {
  it('orders the sections status → community → auto-ban → traffic detection → L4 → console', () => {
    render(<WafSettingsTab />, { wrapper });
    const order = [
      'crowdsec-status-panel',
      'community-blocklist-section',
      'crowdsec-autoban-card',
      'crowdsec-scenarios-card',
      'crowdsec-l4-card',
      'crowdsec-console-card',
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i += 1) {
      expect(precedes(order[i - 1], order[i])).toBe(true);
    }
  });

  it('drops the intro tile and the "Automatic bans" explainer', () => {
    render(<WafSettingsTab />, { wrapper });
    expect(screen.queryByText(/Cluster-wide CrowdSec configuration/)).not.toBeInTheDocument();
    expect(screen.queryByText('Automatic bans')).not.toBeInTheDocument();
  });

  it('gives the community blocklist its own section with the renamed toggle, description and viewer button', () => {
    render(<WafSettingsTab />, { wrapper });
    const section = screen.getByTestId('community-blocklist-section');
    expect(within(section).getByRole('heading', { name: /Community Blocklist/ })).toBeInTheDocument();
    expect(within(section).getByLabelText(/Enable community blocklist/)).toBeInTheDocument();
    expect(within(section).getByTestId('capi-description')).toHaveTextContent(/Only this platform’s own decisions/);
    expect(within(section).getByTestId('view-community-bans')).toBeInTheDocument();
  });

  it('takes the community controls out of the LAPI tile', () => {
    render(<WafSettingsTab />, { wrapper });
    const statusPanel = screen.getByTestId('crowdsec-status-panel');
    expect(within(statusPanel).queryByTestId('capi-toggle')).not.toBeInTheDocument();
    expect(within(statusPanel).queryByTestId('view-community-bans')).not.toBeInTheDocument();
    // One toggle on the page, and only under its new name.
    expect(screen.getAllByTestId('capi-toggle')).toHaveLength(1);
    expect(screen.queryByText(/Pull community blocklist/)).not.toBeInTheDocument();
  });

  it('opens the community viewer from the new section', () => {
    render(<WafSettingsTab />, { wrapper });
    fireEvent.click(within(screen.getByTestId('community-blocklist-section')).getByTestId('view-community-bans'));
    expect(screen.getByTestId('community-viewer-search')).toBeInTheDocument();
  });
});

describe('WAF Settings — collapsed by default, expandable', () => {
  it.each([
    ['autoban-recent-decisions', /Recent decisions/, '203.0.113.9'],
    ['crowdsec-log-sources', /Log sources/, '/var/log/traefik/access.log'],
    ['crowdsec-scenarios-list', /Scenarios/, 'crowdsecurity/http-probing'],
  ])('%s starts collapsed and opens on click', (testId, name, revealed) => {
    render(<WafSettingsTab />, { wrapper });
    const toggle = screen.getByTestId(`${testId}-toggle`);
    // A real button: reachable with Tab, operable with Enter/Space.
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAccessibleName(name);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId(`${testId}-body`)).not.toBeInTheDocument();
    expect(screen.queryByText(revealed)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = screen.getByTestId(`${testId}-body`);
    expect(toggle).toHaveAttribute('aria-controls', body.id);
    expect(within(body).getByText(revealed, { exact: false })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId(`${testId}-body`)).not.toBeInTheDocument();
  });

  it('keeps the counts visible on the collapsed scenario header', () => {
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('crowdsec-scenarios-list-toggle'))
      .toHaveTextContent('2 loaded · 1 alert-only · 2 have seen traffic');
  });
});

describe('Malicious Traffic Detection — Enable / Disable', () => {
  it('is renamed and says exactly what Disabled means', () => {
    render(<WafSettingsTab />, { wrapper });
    const card = screen.getByTestId('crowdsec-scenarios-card');
    expect(within(card).getByRole('heading', { name: /Malicious Traffic Detection/ })).toBeInTheDocument();
    expect(within(card).getByTestId('traffic-detection-meaning'))
      .toHaveTextContent(/keeps reading the access log and raising alerts, but no scenario issues a ban/);
    expect(within(card).getByTestId('traffic-detection-meaning'))
      .toHaveTextContent(/per-scenario .* choices are kept/);
  });

  it('when enabled, Disable asks first and then sends enabled:false', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('traffic-detection-state')).toHaveTextContent(/enabled/i);
    fireEvent.click(screen.getByTestId('traffic-detection-toggle'));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/no scenario issues a ban/));
    expect(setDetection).toHaveBeenCalledWith({ enabled: false });
  });

  it('does nothing when the operator cancels the Disable confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<WafSettingsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('traffic-detection-toggle'));
    expect(setDetection).not.toHaveBeenCalled();
  });

  it('when disabled, shows the alert-only banner and Enable sends enabled:true without a prompt', () => {
    const confirm = vi.spyOn(window, 'confirm');
    scenarios.mockReturnValue(scenariosPayload({ globalSimulation: true, detectionEnabled: false }));
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('crowdsec-global-simulation')).toHaveTextContent(/alerts are still logged, no bans are issued/);
    expect(screen.getByTestId('traffic-detection-state')).toHaveTextContent(/disabled/i);
    const toggle = screen.getByTestId('traffic-detection-toggle');
    expect(toggle).toHaveTextContent('Enable');
    fireEvent.click(toggle);
    expect(confirm).not.toHaveBeenCalled();
    expect(setDetection).toHaveBeenCalledWith({ enabled: true });
  });

  it('says when the saved choice is not what the agent runs, and re-applies it on request', () => {
    scenarios.mockReturnValue(scenariosPayload({ globalSimulation: false, detectionEnabled: false }));
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('traffic-detection-not-applied')).toHaveTextContent(/Saved as disabled, but the agent still runs it enabled/);
    fireEvent.click(screen.getByTestId('traffic-detection-reapply'));
    expect(setDetection).toHaveBeenCalledWith({ enabled: false });
  });

  it('renders an apply failure as an operator error', () => {
    setDetectionState.mockReturnValue({
      mutate: setDetection, isPending: false, isError: true, error: new Error('Saved, but not applied'), data: undefined,
    });
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('traffic-detection-error')).toHaveTextContent(/Saved, but not applied/);
  });
});

describe('Writes to the agent config run one at a time', () => {
  it('locks every scenario toggle and the Enable/Disable button while any write is in flight', () => {
    simulationBusy.mockReturnValue(true);
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('traffic-detection-toggle')).toBeDisabled();
    fireEvent.click(screen.getByTestId('crowdsec-scenarios-list-toggle'));
    for (const row of SCENARIO_ROWS) {
      expect(screen.getByTestId(`scenario-toggle-${row.name}`)).toBeDisabled();
    }
  });

  it('unlocks them again when nothing is in flight', () => {
    render(<WafSettingsTab />, { wrapper });
    expect(screen.getByTestId('traffic-detection-toggle')).toBeEnabled();
    fireEvent.click(screen.getByTestId('crowdsec-scenarios-list-toggle'));
    for (const row of SCENARIO_ROWS) {
      expect(screen.getByTestId(`scenario-toggle-${row.name}`)).toBeEnabled();
    }
  });
});

describe('Scenario table alignment', () => {
  it('aligns every heading the same way as its column, numbers right', () => {
    render(<WafSettingsTab />, { wrapper });
    fireEvent.click(screen.getByTestId('crowdsec-scenarios-list-toggle'));
    const table = screen.getByTestId('scenarios-table');
    const headers = Array.from(table.querySelectorAll('thead th'));
    expect(table.querySelectorAll('colgroup col')).toHaveLength(headers.length);
    const align = (el: Element) => (el.className.match(/\btext-(left|right|center)\b/) ?? [])[1];

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows.length).toBe(SCENARIO_ROWS.length);
    headers.forEach((th, col) => {
      expect(align(th)).toBeDefined();
      for (const row of rows) {
        expect(align(row.children[col])).toBe(align(th));
      }
    });
    expect(headers.map(align)).toEqual(['left', 'left', 'right', 'right', 'left']);
  });
});

describe('WAF Events — one header row', () => {
  beforeEach(() => {
    wafEvents.mockReturnValue({
      ...ok({
        events: [], truncated: false,
        stats: { windowSeconds: 86_400, totalEvents: 0, totalEventsAdminHost: 0, totalEventsTenantRoute: 0, topRules: [], topHosts: [], mostRecentAt: null },
        scraperStatus: { hasRunOnce: true, modsecPodFound: true, lastRunAt: null, scrapeIntervalMs: 30_000, lastCycleErrors: [] },
      }),
    });
  });

  it('puts the description, auto-refresh and refresh controls in one row', () => {
    render(<WafEventsTab />, { wrapper });
    const row = screen.getByTestId('waf-controls');
    for (const id of ['waf-events-description', 'waf-auto-refresh', 'waf-live-toggle', 'waf-refresh-now']) {
      expect(within(row).getByTestId(id)).toBeInTheDocument();
    }
    // It is the first thing in the tab — no separate description tile above it.
    expect(screen.getByTestId('waf-events-tab').firstElementChild).toBe(row);
  });

  it('shortens the description to one sentence', () => {
    render(<WafEventsTab />, { wrapper });
    const text = screen.getByTestId('waf-events-description').textContent ?? '';
    expect(text.length).toBeLessThan(120);
    expect(screen.queryByText(/admin-host events are capped at 500 globally/)).not.toBeInTheDocument();
  });
});
