/**
 * Tenant detail → Traffic (7 days): inbound/outbound totals for the tenant
 * over the last week, and a click-through to Monitoring → Traffic with that
 * tenant and range pre-selected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TrafficFrame } from '@insula/api-contracts';

const times = Array.from({ length: 4 }, (_, i) => new Date(Date.UTC(2026, 8, 30, i)).toISOString());
const FRAME: TrafficFrame = {
  from: times[0], to: times[3], stepSeconds: 3600, times, unit: 'bytes', resolution: 'fine',
  othersFolded: 0, clamped: false,
  series: [
    { key: 'out', name: 'Outbound', kind: 'direction', points: [1_000_000, 1_000_000, null, 1_000_000] },
    { key: 'in', name: 'Inbound', kind: 'direction', points: [100_000, 100_000, 100_000, 100_000] },
  ],
};

let lastParams: Record<string, unknown> = {};
vi.mock('@/hooks/use-traffic', () => ({
  useTrafficSeries: (params: Record<string, unknown>) => {
    lastParams = params;
    return { data: FRAME, isLoading: false, error: null };
  },
}));

const { default: TenantTrafficCard, summarizeTenantTraffic } = await import('@/components/tenants/TenantTrafficCard');

describe('summarizeTenantTraffic', () => {
  it('totals each direction from rate × step, skipping gaps', () => {
    const s = summarizeTenantTraffic(FRAME);
    expect(s.outbound).toBe(3 * 1_000_000 * 3600);
    expect(s.inbound).toBe(4 * 100_000 * 3600);
    expect(s.empty).toBe(false);
  });

  it('reads a daily-rollup frame (one egress line keyed by tenant id) as outbound only', () => {
    const daily: TrafficFrame = { ...FRAME, stepSeconds: 86_400, resolution: 'daily', series: [
      { key: 'tenant-uuid', name: 'Acme', kind: 'direction', points: [10, 20, 30, 40] },
    ] };
    const s = summarizeTenantTraffic(daily);
    expect(s.outbound).toBe(100 * 86_400);
    expect(s.inbound).toBe(0);
  });

  it('is empty when nothing was measured', () => {
    const none: TrafficFrame = { ...FRAME, series: FRAME.series.map((x) => ({ ...x, points: x.points.map(() => null) })) };
    expect(summarizeTenantTraffic(none).empty).toBe(true);
  });
});

describe('TenantTrafficCard', () => {
  beforeEach(() => { lastParams = {}; });

  it('asks for this tenant, both directions, over 7 days', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    expect(lastParams).toMatchObject({ scope: 'tenant', subject: 'tenant-acme-1a2b3c4d', direction: 'both', metric: 'traffic' });
    const span = (lastParams.to as Date).getTime() - (lastParams.from as Date).getTime();
    expect(span).toBe(7 * 86_400_000);
  });

  it('shows inbound and outbound, in those words, and a graph', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    expect(screen.getByTestId('tenant-traffic-outbound').textContent).toBe('10.8 GB');
    expect(screen.getByTestId('tenant-traffic-inbound').textContent).toBe('1.44 GB');
    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getByText('Outbound')).toBeInTheDocument();
    expect(screen.queryByText(/upload|download/i)).toBeNull();
    expect(screen.getByTestId('tenant-traffic-spark').querySelectorAll('polyline')).toHaveLength(2);
  });

  it('lets the chart take the spare height of the card', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    // The card sits beside the tenant details, which set the row's height.
    expect(screen.getByTestId('tenant-traffic-chart').className).toMatch(/\bflex-1\b/);
    expect(screen.getByTestId('tenant-traffic-spark').getAttribute('class')).toMatch(/\bh-full\b/);
  });

  it('links to Monitoring → Traffic with the tenant and 7 days selected', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    expect(screen.getByTestId('tenant-traffic-link').getAttribute('href'))
      .toBe('/monitoring?scope=tenant&subject=tenant-acme-1a2b3c4d&range=7d');
  });
});
