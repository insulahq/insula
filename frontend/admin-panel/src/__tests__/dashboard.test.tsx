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
      storageBreakdown: { tenants: 33, mail: 38, system: 2.7, imagesAndOther: 25 },
      nodeCount: 1, survivesSingleNodeLoss: false, worstNode: 'sv1',
    }),
    nodes: okSection([]),
    mail: okSection({ sent7d: 332, queueDepth: 0, queueReachable: true, mailboxes: 72, emailDomains: 19, rateLimited7d: 0, overQuotaMailboxes: 0 }),
    clusterAlerts: okSection([]),
    webDefence: okSection({ blocked24h: 48, critical24h: 41, distinctSources: 12, activeBans: 6, topOffenders: [{ ip: '203.0.113.7', hits: 500 }, { ip: '203.0.113.9', hits: 48 }], topRuleId: '930130', wafEnabled: true, recent: [] }),
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
    // The headline now reads "0.90/7.50 cores in use", so the in-use figure is
    // matched inside its element rather than as the element's whole text.
    expect(screen.getByText((_t, el) => el?.textContent === '0.90/7.50')).toBeInTheDocument();
    expect(screen.getByText(/committed 92%/)).toBeInTheDocument();
  });

  it('puts free capacity on the headline row, not in a trailing sentence', () => {
    show();
    // Operator feedback: the "6.60 cores still free" paragraph under the bar
    // was noise, and the number belonged beside the usage it qualifies.
    expect(screen.getByText('0.63 free')).toBeInTheDocument();
    expect(screen.queryByText(/still free/)).toBeNull();
  });

  it('reports storage against the DISK, and says where it went', () => {
    // `total` used to be the sum of volume REQUESTS, which made total and
    // committed the same number and "free" the gap between requested and
    // written — never free disk. And the hover card could not answer the
    // question the headline provokes: 178 of 540 GB of WHAT?
    show();
    expect(screen.getByText('Tenant volumes')).toBeInTheDocument();
    expect(screen.getByText('Platform volumes')).toBeInTheDocument();
    expect(screen.getByText('Images & other')).toBeInTheDocument();
    // Mail is read from the platform's mailbox accounting, not Longhorn — the
    // mail stack is on a local-path PVC Longhorn cannot see, so a
    // Longhorn-fed line would read 0 on a cluster holding 38 GB of it.
    expect(screen.getByText('38.0 GB')).toBeInTheDocument();
  });

  it('draws committed capacity as a HATCH, not a second flat tint', () => {
    // The triad only works if "in use now" and "claimed but idle" look like
    // different things. Built from the written spec as two tints of one hue,
    // they read as a single gradient and the distinction vanished. The mockup
    // hatches the committed band; the legend swatch reuses the same class so
    // it cannot describe a fill the bar stopped drawing.
    const { container } = show();
    const seg = container.querySelector('[class*="seg-committed"]');
    expect(seg).not.toBeNull();

    const swatches = Array.from(container.querySelectorAll('[class*="swatch-committed"]'));
    expect(swatches.length).toBeGreaterThan(0);

    // Same tone suffix on both, so bar and legend move together.
    const suffix = (c: string): string => (/(seg|swatch)-committed(-\w+)?/.exec(c)?.[2] ?? '');
    expect(suffix(seg!.className)).toBe(suffix(swatches[0].className));

    // And free is the bare track, so its swatch needs an outline to exist.
    expect(container.querySelector('[class*="ring-gray-300"]')).not.toBeNull();
  });

  it('names banned addresses and the worst offender, not a rule id', () => {
    // Operator feedback: CRITICAL and TOP RULE described the traffic; neither
    // told you who to block. A rule number is not an actor.
    //
    // Scoped to the tile's own cells: both still appear in the hover card,
    // deliberately — nothing was removed from the panel, it was demoted out
    // of the four figures you see without hovering.
    const { container } = show();
    const cellLabels = Array.from(
      container.querySelectorAll('div.text-\\[10px\\].uppercase'),
    ).map((el) => el.textContent?.trim());

    expect(cellLabels).toContain('Banned IPs');
    expect(cellLabels).toContain('Top offenders');
    expect(cellLabels).not.toContain('Top rule');
    expect(cellLabels).not.toContain('Critical');
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });

  it('lines the NODES header up with its rows', () => {
    // Header and rows are SEPARATE grid containers, so `auto` tracks sized to
    // their own content — "Role" up top, a bordered badge in the row — and the
    // columns drifted visibly apart. Same template, fixed widths, no `auto`.
    liveFn.mockReturnValue({
      data: { data: live({
        nodes: okSection([{
          name: 'sv1', role: 'server', ready: true, pressures: [], evictionsLastHour: 0,
          diskUsedPct: 21, pods: 48, kubeletVersion: 'v1.36.2+k3s1',
          calico: 'ok' as const, csi: 'ok' as const, ingressMode: 'default', tenantWorkloads: true,
          cpu: { inUse: 0.9, committed: 6.87, total: 7.5, unit: 'cores', kind: 'reserve' as const },
          memory: { inUse: 9.69, committed: 9.79, total: 14.36, unit: 'GiB', kind: 'reserve' as const },
        }]) as AdminDashboardLive['nodes'],
      }) }, isLoading: false,
    });
    const { container } = show();

    const tpl = (el: Element | null): string =>
      (el?.className ?? '').split(/\s+/).find((c) => c.includes('grid-cols-[minmax(0,1.3fr)'))?.replace(/^lg:/, '') ?? '';

    const header = container.querySelector('[class*="rounded-t-xl"][class*="grid-cols-"]');
    const row = container.querySelector('a[href="/cluster/nodes"][class*="grid-cols-"]');
    expect(tpl(header)).not.toBe('');
    expect(tpl(row)).not.toBe('');
    expect(tpl(header)).toBe(tpl(row));
    expect(tpl(header)).not.toMatch(/_auto[_\]]/);
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
