import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminDashboardSummary, AdminDashboardLive } from '@insula/api-contracts';
import Dashboard from '../pages/Dashboard';

/**
 * The console's two load-bearing behaviours:
 *
 *   The attention band is CONDITIONAL. When nothing is wrong it must not
 *   render an empty warnings region — a region that is usually blank is a
 *   region people stop reading.
 *
 *   A section whose source failed must SAY so. Rendering nothing makes a
 *   broken tile look identical to a tile with nothing to report.
 */

const { summaryFn, liveFn } = vi.hoisted(() => ({
  summaryFn: vi.fn(), liveFn: vi.fn(),
}));
vi.mock('@/hooks/use-operator-console', () => ({
  useConsoleSummary: () => summaryFn(),
  useConsoleLive: () => liveFn(),
}));

const okSection = <T,>(data: T) => ({ state: 'ok' as const, reason: null, observedAt: null, data });

function summary(over: Partial<AdminDashboardSummary> = {}): AdminDashboardSummary {
  return {
    generatedAt: new Date().toISOString(),
    alerts: okSection([]),
    tenants: okSection({ active: 26, total: 27, routes: 45, domains: 32, provisioningInFlight: 0 }),
    backups: okSection({
      classes: [
        { backupClass: 'system' as const, lastSuccessAt: null, targetName: 'StorageBox', targetKind: 'cifs', healthy: true },
        { backupClass: 'tenant' as const, lastSuccessAt: new Date().toISOString(), targetName: 'StorageBox', targetKind: 'cifs', healthy: true },
        { backupClass: 'mail' as const, lastSuccessAt: null, targetName: 'StorageBox', targetKind: 'cifs', healthy: true },
      ],
      bundles: 222, repoBytes: 184e9, tenantsNeverBackedUp: 0,
    }),
    certificates: okSection({ issued: 38, wildcards: 28, nearestExpiryDays: 47, failing: 0 }),
    database: okSection({ archivingHealthy: true, walBytes: null, volumeBytes: null, pressurePct: null, breakerTripped: false }),
    updates: okSection({ platformCurrent: true, deploymentsBehind: 0, autoUpgradeEnabled: 2, eolRuntimes: 0 }),
    scheduledTasks: okSection({ total: 16, enabled: 14, failed24h: 0, overdue: 0 }),
    recentChanges: okSection([]),
    ...over,
  } as AdminDashboardSummary;
}

function live(over: Partial<AdminDashboardLive> = {}): AdminDashboardLive {
  return {
    generatedAt: new Date().toISOString(),
    cluster: okSection({
      cpu: { inUse: 0.9, committed: 6.87, total: 7.5, unit: 'cores', kind: 'reserve' as const },
      memory: { inUse: 9.69, committed: 9.79, total: 14.36, unit: 'GiB', kind: 'reserve' as const },
      storage: { inUse: 178, committed: 160, total: 540, unit: 'GB', kind: 'consume' as const },
      nodeCount: 1, survivesSingleNodeLoss: false, worstNode: 'sv1',
    }),
    nodes: okSection([]),
    mail: okSection({ sent7d: 332, queueDepth: 0, queueReachable: true, mailboxes: 72, emailDomains: 19, rateLimited7d: 0, overQuotaMailboxes: 0 }),
    clusterAlerts: okSection([]),
    webDefence: okSection({ blocked24h: 48, critical24h: 41, distinctSources: 12, activeBans: 6, topRuleId: '930130', wafEnabled: true, recent: [] }),
    ...over,
  } as AdminDashboardLive;
}

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Dashboard /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => {
  summaryFn.mockReturnValue({ data: { data: summary() }, isLoading: false });
  liveFn.mockReturnValue({ data: { data: live() }, isLoading: false });
});

describe('Operator console — conditional alerts', () => {
  it('renders NO alert chips when nothing is wrong', () => {
    show();
    expect(screen.queryAllByTestId('alert-chip')).toHaveLength(0);
    expect(screen.getByText(/nothing needs attention/i)).toBeInTheDocument();
  });

  it('renders a chip per alert when something is wrong', () => {
    summaryFn.mockReturnValue({
      data: { data: summary({ alerts: okSection([{
        categoryId: 'admin.cert_expiring', severity: 'critical' as const, value: '2',
        title: 'Certificates expiring', subtitle: 'soonest in 3 days', href: '/domains',
        detail: [['Expiring within 14 days', '2']], note: null,
      }]) }) },
      isLoading: false,
    });
    show();
    expect(screen.getAllByTestId('alert-chip')).toHaveLength(1);
    expect(screen.getAllByText('Certificates expiring').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing needs attention/i)).not.toBeInTheDocument();
  });

  it('merges cluster alerts from the slow poll into the same band', () => {
    // Orphaned pods and volume fullness arrive on the live endpoint; the band
    // must fill in two stages rather than showing two separate regions.
    summaryFn.mockReturnValue({
      data: { data: summary({ alerts: okSection([{
        categoryId: 'admin.cert_expiring', severity: 'critical' as const, value: '2',
        title: 'Certificates expiring', subtitle: '', href: '/domains', detail: [], note: null,
      }]) }) }, isLoading: false,
    });
    liveFn.mockReturnValue({
      data: { data: live({ clusterAlerts: okSection([{
        categoryId: 'admin.node_event', severity: 'warning' as const, value: '12',
        title: 'Orphaned pods', subtitle: 'across 2 nodes', href: '/cluster/nodes',
        detail: [['sv1', '12 pods']], note: null,
      }]) }) }, isLoading: false,
    });
    show();
    expect(screen.getAllByTestId('alert-chip')).toHaveLength(2);
    expect(screen.getAllByText('Orphaned pods').length).toBeGreaterThan(0);
  });
});

describe('Operator console — capacity', () => {
  it('shows in-use and committed as different numbers', () => {
    show();
    // The gap is the point: 0.90 in use against 6.87 committed of 7.50.
    expect(screen.getByText('0.90')).toBeInTheDocument();
    expect(screen.getByText(/committed 92%/)).toBeInTheDocument();
  });

  it('states plainly that one node has no redundancy', () => {
    show();
    expect(screen.getByText(/no redundancy/i)).toBeInTheDocument();
  });
});

describe('Operator console — degraded sections', () => {
  it('a failed section says so instead of rendering blank', () => {
    liveFn.mockReturnValue({
      data: { data: live({
        mail: { state: 'failed', reason: 'stalwart did not answer within 2500ms', observedAt: null, data: null },
      }) }, isLoading: false,
    });
    show();
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.getByText(/stalwart did not answer/i)).toBeInTheDocument();
  });

  it('one failed section does not take the others down', () => {
    liveFn.mockReturnValue({
      data: { data: live({
        mail: { state: 'failed', reason: 'boom', observedAt: null, data: null },
      }) }, isLoading: false,
    });
    show();
    // Web defence still renders its figures (the value appears in the tile
    // and again in its hover card, so count rather than expect exactly one).
    expect(screen.getAllByText('930130').length).toBeGreaterThan(0);
  });
});

describe('Operator console — backups by class', () => {
  it('shows the three shim classes rather than one blended number', () => {
    show();
    for (const cls of ['system', 'tenant', 'mail']) {
      expect(screen.getByText(cls)).toBeInTheDocument();
    }
  });
});
