/**
 * The tile's whole constraint is that it must not make its neighbours taller.
 * In an auto-fit grid a chart added in flow raises the row for every card
 * beside it, so the sparkline is positioned out of flow — and that is a
 * property worth pinning, because it is invisible until somebody looks at the
 * dashboard and wonders why every tile grew.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TrafficFrame } from '@insula/api-contracts';
import { TrafficTileView } from '@/components/traffic/TrafficTile';

const frame: TrafficFrame = {
  from: '2026-09-28T12:00:00.000Z',
  to: '2026-09-29T12:00:00.000Z',
  stepSeconds: 300,
  times: Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 29, i)).toISOString()),
  unit: 'bytes',
  resolution: 'fine',
  othersFolded: 0,
  clamped: false,
  series: [
    { key: 'out', name: 'Outbound', kind: 'direction', points: Array.from({ length: 12 }, () => 2_000_000) },
    { key: 'in', name: 'Inbound', kind: 'direction', points: Array.from({ length: 12 }, () => 1_000_000) },
  ],
};

const renderTile = (f: TrafficFrame) =>
  render(<MemoryRouter><TrafficTileView frame={f} /></MemoryRouter>);

describe('TrafficTile', () => {
  it('shows the combined total and both directions', () => {
    renderTile(frame);
    // 12 points × 300s × 3 MB/s combined = 10.8 GB
    expect(screen.getByText('10.8 GB')).toBeInTheDocument();
    expect(screen.getByText(/7\.20 GB out/)).toBeInTheDocument();
    expect(screen.getByText(/3\.60 GB in/)).toBeInTheDocument();
  });

  it('keeps the sparkline out of flow so the grid row does not grow', () => {
    const { container } = renderTile(frame);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('class')).toContain('absolute');
    expect(svg!.getAttribute('class')).toContain('bottom-0');
    // and it must not intercept clicks meant for the tile's own link
    expect(svg!.getAttribute('class')).toContain('pointer-events-none');
  });

  it('links to the Traffic tab', () => {
    renderTile(frame);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/monitoring?tab=traffic');
  });

  it('survives a frame with gaps rather than charting them as zero', () => {
    const gappy: TrafficFrame = {
      ...frame,
      series: [{ ...frame.series[0], points: [1_000_000, null, null, 2_000_000, ...Array(8).fill(null)] }],
    };
    const { container } = renderTile(gappy);
    const pts = container.querySelector('polyline')?.getAttribute('points') ?? '';
    // two measured points plotted, the eight nulls simply absent
    expect(pts.trim().split(/\s+/)).toHaveLength(2);
  });
});

describe('TrafficChart gap handling', () => {
  it('draws an isolated measured point as a dot rather than losing it', async () => {
    // A run of one has no segment to belong to. Dropping it hides a real
    // measurement — the mirror image of drawing a gap as zero.
    const { default: TrafficChart } = await import('@/components/traffic/TrafficChart');
    const lonely: TrafficFrame = {
      ...frame,
      series: [{ key: 'out', name: 'Outbound', kind: 'direction', points: [null, null, 5_000, null, null, null, null, null, null, null, null, null] }],
    };
    const { container } = render(<TrafficChart frame={lonely} stacked={false} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(0);
    const dots = [...container.querySelectorAll('circle')].filter((c) => c.getAttribute('r') === '1.8');
    expect(dots).toHaveLength(1);
  });

  it('breaks the line at a gap instead of bridging it', async () => {
    const { default: TrafficChart } = await import('@/components/traffic/TrafficChart');
    const gappy: TrafficFrame = {
      ...frame,
      series: [{ key: 'out', name: 'Outbound', kind: 'direction', points: [1, 2, null, null, 3, 4, null, null, 5, 6, null, null] }],
    };
    const { container } = render(<TrafficChart frame={gappy} stacked={false} />);
    // three runs of two → three separate polylines, not one across the gaps
    expect(container.querySelectorAll('polyline')).toHaveLength(3);
  });
});
