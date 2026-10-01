import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TimeSeriesChart from './TimeSeriesChart';

const times = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 8, 30, i)).toISOString());

// The production shape that exposed the bug: one tenant dwarfs the rest, and
// the small one has spikes of its OWN at different moments.
const big = times.map((_, i) => (i === 7 ? 900_000 : 20_000));
const small = times.map((_, i) => (i === 3 ? 50_000 : 4_000));
const total = times.map((_, i) => big[i] + small[i]);

const common = {
  times,
  stepSeconds: 3600,
  formatValue: (v: number | null) => (v === null ? '—' : `${Math.round(v / 1000)} kB/s`),
  formatTick: (iso: string) => iso.slice(11, 16),
  formatInstant: (iso: string) => iso,
};

const series = [
  { key: 'big', name: 'Big', points: big },
  { key: 'small', name: 'Small', points: small },
];

function pointsOf(container: HTMLElement, key: string): Array<{ x: number; y: number }> {
  const line = container.querySelector(`[data-series="${key}"] polyline`);
  expect(line).not.toBeNull();
  return line!.getAttribute('points')!.trim().split(/\s+/).map((p) => {
    const [x, y] = p.split(',').map(Number);
    return { x, y };
  });
}

/** jsdom lays nothing out; give the plot the size the chart assumes. */
function sized(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg[role="img"]') as SVGSVGElement;
  svg.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 900, height: 260, right: 900, bottom: 260, x: 0, y: 0, toJSON: () => ({}),
  });
  return svg;
}

describe('TimeSeriesChart', () => {
  it("draws every series at its own value — a small one does not follow the big one's spike", () => {
    const { container } = render(<TimeSeriesChart {...common} series={series} />);
    const pts = pointsOf(container, 'small');
    // Where Big spikes (index 7), Small is at its own baseline, as at index 0.
    expect(pts[7].y).toBeCloseTo(pts[0].y, 5);
    // And Small's own spike (index 3) is the highest point of its line.
    expect(pts[3].y).toBe(Math.min(...pts.map((p) => p.y)));
  });

  it('paints the lowest traffic first, so the highest is on top, and the total over all of them', () => {
    const { container } = render(
      <TimeSeriesChart
        {...common}
        series={[
          { key: 'total', name: 'Total', points: total, emphasis: 'total' },
          ...series,
        ]}
      />,
    );
    const order = [...container.querySelectorAll('[data-series]')].map((g) => g.getAttribute('data-series'));
    expect(order).toEqual(['small', 'big', 'total']);
  });

  it('fades every series but the focused one, and lifts it to the top', () => {
    const { container } = render(<TimeSeriesChart {...common} series={series} focusKey="small" />);
    const groups = [...container.querySelectorAll('[data-series]')];
    expect(groups.map((g) => g.getAttribute('data-series'))).toEqual(['big', 'small']);
    expect(container.querySelector('[data-series="big"]')!.getAttribute('data-dim')).toBe('true');
    expect(container.querySelector('[data-series="small"]')!.getAttribute('data-dim')).toBe('false');
  });

  it('treats a focus key that matches no drawn series as no focus, rather than fading everything', () => {
    // A refetch can drop the hovered row; its <tr> unmounts under the pointer
    // and no mouseleave fires, so the parent is left holding a dead key.
    const { container } = render(<TimeSeriesChart {...common} series={series} focusKey="gone" />);
    for (const g of container.querySelectorAll('[data-series]')) expect(g.getAttribute('data-dim')).toBe('false');
  });

  it('leaves a hidden series out, and keeps the colours of the rest', () => {
    const { container } = render(<TimeSeriesChart {...common} series={series} hidden={new Set(['big'])} />);
    expect(container.querySelector('[data-series="big"]')).toBeNull();
    // Small is the SECOND series, so it keeps the second colour.
    expect(container.querySelector('[data-series="small"] polyline')!.getAttribute('stroke')).toBe('#0f766e');
  });

  it('labels gridlines with round numbers', () => {
    render(<TimeSeriesChart {...common} series={[{ key: 'a', name: 'A', points: big }]} />);
    const labels = screen.getAllByTestId('y-tick').map((el) => el.textContent);
    // 900 kB/s peak → 0 / 250 / 500 / 750 / 1000, never 225 / 450 / 675.
    expect(labels).toEqual(['0 kB/s', '250 kB/s', '500 kB/s', '750 kB/s', '1000 kB/s']);
  });

  it('draws full-bleed with the axis labels inside the plot', () => {
    render(<TimeSeriesChart {...common} fullBleed series={[{ key: 'a', name: 'A', points: big }]} />);
    const labels = screen.getAllByTestId('y-tick');
    // The zero line needs no label, and every label sits right of the plot edge.
    expect(labels.map((el) => el.textContent)).not.toContain('0 kB/s');
    for (const el of labels) expect(Number(el.getAttribute('x'))).toBeGreaterThan(0);
  });

  it('breaks a line at an unmeasured interval instead of drawing zero', () => {
    const gappy = times.map((_, i) => (i === 5 || i === 6 ? null : 1000));
    const { container } = render(<TimeSeriesChart {...common} series={[{ key: 'g', name: 'G', points: gappy }]} />);
    expect(container.querySelectorAll('[data-series="g"] polyline')).toHaveLength(2);
  });

  describe('spike markers', () => {
    const t40 = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, 30, 0, i)).toISOString());
    const spiky = t40.map((_, i) => (i === 20 ? 50_000 : 1000));

    it('have a target far larger than the dot, and zoom on click or Enter', () => {
      const onZoom = vi.fn();
      render(
        <TimeSeriesChart {...common} times={t40} series={[{ key: 'a', name: 'A', points: spiky }]} onZoom={onZoom} />,
      );
      const marker = screen.getByTestId('spike-marker');
      const hit = marker.querySelector('[data-hit]')!;
      expect(Number(hit.getAttribute('r'))).toBeGreaterThanOrEqual(12);
      fireEvent.click(marker);
      expect(onZoom).toHaveBeenCalledWith(t40[20]);
      fireEvent.keyDown(marker, { key: 'Enter' });
      expect(onZoom).toHaveBeenCalledTimes(2);
    });

    it('use the indices the caller passes, so a stat tile and the markers agree', () => {
      render(<TimeSeriesChart {...common} times={t40} series={[{ key: 'a', name: 'A', points: spiky }]} spikeIndices={[5, 30]} />);
      expect(screen.getAllByTestId('spike-marker')).toHaveLength(2);
    });
  });

  describe('drag to zoom', () => {
    it('reports the instants either side of a dragged range', () => {
      const onRangeSelect = vi.fn();
      const { container } = render(<TimeSeriesChart {...common} series={series} onRangeSelect={onRangeSelect} />);
      const svg = sized(container);
      // Plot spans x 62…884 of 900; index 2 ≈ 211, index 8 ≈ 660.
      fireEvent.mouseDown(svg, { clientX: 211, clientY: 100, button: 0 });
      fireEvent.mouseMove(window, { clientX: 660, clientY: 100, buttons: 1 });
      expect(screen.getByTestId('chart-brush')).toBeInTheDocument();
      fireEvent.mouseUp(window, { clientX: 660, clientY: 100 });
      expect(onRangeSelect).toHaveBeenCalledWith(times[2], times[8]);
      expect(screen.queryByTestId('chart-brush')).toBeNull();
    });

    it('treats a click without a drag as a click, not a zoom', () => {
      const onRangeSelect = vi.fn();
      const { container } = render(<TimeSeriesChart {...common} series={series} onRangeSelect={onRangeSelect} />);
      const svg = sized(container);
      fireEvent.mouseDown(svg, { clientX: 400, clientY: 100, button: 0 });
      fireEvent.mouseUp(window, { clientX: 402, clientY: 100 });
      expect(onRangeSelect).not.toHaveBeenCalled();
    });

    it('cancels when the button was released outside the window', () => {
      const onRangeSelect = vi.fn();
      const { container } = render(<TimeSeriesChart {...common} series={series} onRangeSelect={onRangeSelect} />);
      const svg = sized(container);
      fireEvent.mouseDown(svg, { clientX: 211, clientY: 100, button: 0 });
      fireEvent.mouseMove(window, { clientX: 660, clientY: 100, buttons: 1 });
      // Back over the page with no button held: the release happened elsewhere.
      fireEvent.mouseMove(window, { clientX: 700, clientY: 100, buttons: 0 });
      expect(screen.queryByTestId('chart-brush')).toBeNull();
      fireEvent.mouseUp(window, { clientX: 700, clientY: 100 });
      expect(onRangeSelect).not.toHaveBeenCalled();
    });

    it('cancels on Escape', () => {
      const onRangeSelect = vi.fn();
      const { container } = render(<TimeSeriesChart {...common} series={series} onRangeSelect={onRangeSelect} />);
      const svg = sized(container);
      fireEvent.mouseDown(svg, { clientX: 211, clientY: 100, button: 0 });
      fireEvent.mouseMove(window, { clientX: 660, clientY: 100, buttons: 1 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.mouseUp(window, { clientX: 660, clientY: 100 });
      expect(onRangeSelect).not.toHaveBeenCalled();
    });
  });

  describe('readout', () => {
    it('lists each series with its share of the base, and sits on the side away from the pointer', () => {
      const { container } = render(<TimeSeriesChart {...common} series={series} shareBase={total} />);
      const svg = sized(container);
      // Right half → readout on the left.
      fireEvent.mouseMove(svg, { clientX: 880, clientY: 100 });
      let ro = screen.getByTestId('chart-readout');
      expect(ro.textContent).toContain('Big');
      // At the last index Big is 20 of 24 kB/s.
      expect(ro.textContent).toContain('83%');
      expect(ro.style.left).not.toBe('');
      // Left half → readout on the right.
      fireEvent.mouseMove(svg, { clientX: 80, clientY: 100 });
      ro = screen.getByTestId('chart-readout');
      expect(ro.style.right).not.toBe('');
      fireEvent.mouseLeave(svg);
      expect(screen.queryByTestId('chart-readout')).toBeNull();
    });
  });
});
