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
    const svg = container.querySelector('[data-testid="traffic-tile-spark"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('class')).toContain('absolute');
    expect(svg!.getAttribute('class')).toContain('bottom-0');
    // and it must not intercept clicks meant for the tile's own link
    expect(svg!.getAttribute('class')).toContain('pointer-events-none');
  });

  it('links to the Traffic tab', () => {
    renderTile(frame);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/monitoring/traffic');
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
    const { container } = render(<TrafficChart frame={lonely} />);
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
    const { container } = render(<TrafficChart frame={gappy} />);
    // three runs of two → three separate polylines, not one across the gaps
    expect(container.querySelectorAll('polyline')).toHaveLength(3);
  });
});

/**
 * The fixture above is two series. The real cluster frame is not: it carries
 * the wire rows (internet out, internet in, node-to-node — each byte once),
 * the node-to-node split, tenants, backups and the old NIC sum. Every earlier
 * version of these assertions passed against a fixture built to match the
 * component instead of the server, so this one mirrors service.ts exactly.
 */
const flat = (v: number) => Array.from({ length: 12 }, () => v);
const clusterFrame: TrafficFrame = {
  ...frame,
  series: [
    { key: 'wire:internet:out', name: 'Internet · outbound', kind: 'direction', group: 'wire', points: flat(1_000_000) },
    { key: 'wire:internet:in', name: 'Internet · inbound', kind: 'direction', group: 'wire', points: flat(500_000) },
    { key: 'wire:n2n', name: 'Node-to-node', kind: 'direction', group: 'wire', points: flat(2_000_000) },
    { key: 'n2n:kubeapi', name: 'Node-to-node · Kubernetes API', kind: 'direction', group: 'n2n', points: flat(1_200_000) },
    { key: 'tenants:out', name: 'All tenants · outbound (via ingress)', kind: 'direction', group: 'wire-subset', points: flat(300_000) },
    { key: 'backup:out', name: 'Backups · outbound (off-site)', kind: 'direction', group: 'wire-subset', points: flat(100_000) },
    { key: 'nic:out', name: 'All NICs · outbound (node-to-node counted twice)', kind: 'direction', group: 'nic', points: flat(30_000_000) },
    { key: 'nic:in', name: 'All NICs · inbound (node-to-node counted twice)', kind: 'direction', group: 'nic', points: flat(28_000_000) },
  ],
};

describe('TrafficTile against the real cluster frame', () => {
  it('headlines the unique total and splits it into internet and between nodes', () => {
    renderTile(clusterFrame);
    // 12 × 300 s × (1 + 0.5 + 2) MB/s = 12.6 GB; the NIC sum is NOT added in.
    expect(screen.getByText('12.6 GB')).toBeInTheDocument();
    expect(screen.getByText(/5\.40 GB internet/)).toBeInTheDocument();
    expect(screen.getByText(/7\.20 GB between nodes/)).toBeInTheDocument();
  });

  it('draws only the two lines its legend names', () => {
    const { container } = renderTile(clusterFrame);
    expect(container.querySelectorAll('[data-testid="traffic-tile-spark"] polyline')).toHaveLength(2);
  });

  it('scales to the drawn lines so they use the card height', () => {
    const { container } = renderTile(clusterFrame);
    // The second line (between nodes) is the larger one here. Taking the
    // ceiling from the 30 MB/s NIC rows would pin both near the bottom.
    const lines = container.querySelectorAll('[data-testid="traffic-tile-spark"] polyline');
    const ys = (lines[1]?.getAttribute('points') ?? '').split(' ')
      .map((pt) => Number(pt.split(',')[1]))
      .filter((n) => Number.isFinite(n));
    const viewBoxH = Number((container.querySelector('[data-testid="traffic-tile-spark"]')?.getAttribute('viewBox') ?? '0 0 0 48').split(' ')[3]);
    expect(Math.min(...ys)).toBeLessThan(viewBoxH * 0.25);
  });

  it('falls back to the NIC pair where the split was not measured yet', () => {
    const unmeasured: TrafficFrame = {
      ...clusterFrame,
      series: clusterFrame.series.map((s) => (s.group === 'wire' ? { ...s, points: s.points.map(() => null) } : s)),
    };
    renderTile(unmeasured);
    // 12 × 300 s × 30 MB/s = 108 GB out, 100.8 GB in.
    expect(screen.getByText(/108 GB out/)).toBeInTheDocument();
    expect(screen.getByText(/101 GB in/)).toBeInTheDocument();
  });
});
