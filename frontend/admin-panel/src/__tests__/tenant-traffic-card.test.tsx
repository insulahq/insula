/**
 * Tenant detail → Traffic (7 days): upload/download totals for the tenant
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
    expect(s.upload).toBe(3 * 1_000_000 * 3600);
    expect(s.download).toBe(4 * 100_000 * 3600);
    expect(s.empty).toBe(false);
  });

  it('reads a daily-rollup frame (one egress line keyed by tenant id) as upload only', () => {
    const daily: TrafficFrame = { ...FRAME, stepSeconds: 86_400, resolution: 'daily', series: [
      { key: 'tenant-uuid', name: 'Acme', kind: 'direction', points: [10, 20, 30, 40] },
    ] };
    const s = summarizeTenantTraffic(daily);
    expect(s.upload).toBe(100 * 86_400);
    expect(s.download).toBe(0);
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

  it('shows upload and download and a graph', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    expect(screen.getByTestId('tenant-traffic-upload').textContent).toBe('10.8 GB');
    expect(screen.getByTestId('tenant-traffic-download').textContent).toBe('1.44 GB');
    expect(screen.getByTestId('tenant-traffic-spark').querySelectorAll('polyline')).toHaveLength(2);
  });

  it('links to Monitoring → Traffic with the tenant and 7 days selected', () => {
    render(<MemoryRouter><TenantTrafficCard namespace="tenant-acme-1a2b3c4d" /></MemoryRouter>);
    expect(screen.getByTestId('tenant-traffic-link').getAttribute('href'))
      .toBe('/monitoring?scope=tenant&subject=tenant-acme-1a2b3c4d&range=7d');
  });
});
