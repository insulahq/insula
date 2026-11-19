/**
 * The mail-server memory card on Email → Settings.
 *
 * Worth pinning:
 *   - the current figure is read against the limit, and the colour follows the
 *     same threshold the alert fires at (not a second, private one);
 *   - an hour with no sample breaks the line instead of dropping it to zero,
 *     which would read as "memory fell" right before a kill;
 *   - "no samples yet" and "could not read" are different states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MailServerMemoryResponse } from '@insula/api-contracts';
import { chartSegments, hourLabel, memoryLevel } from './MailServerMemoryCard';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const HOUR = 3600;
const END = 1795071600;

const queryState: {
  data?: { data: MailServerMemoryResponse };
  isLoading: boolean;
  isError: boolean;
  error: unknown;
} = { isLoading: false, isError: false, error: null };
const refetch = vi.fn();
vi.mock('@/hooks/use-mail-server-memory', () => ({
  useMailServerMemory: () => ({ ...queryState, refetch, isFetching: false }),
}));

const { default: MailServerMemoryCard } = await import('./MailServerMemoryCard');

function points(values: Array<number | null>) {
  return values.map((bytes, i) => ({ t: END - (values.length - 1 - i) * HOUR, bytes }));
}

function response(over: Partial<MailServerMemoryResponse> = {}): MailServerMemoryResponse {
  return {
    available: true,
    reason: null,
    currentBytes: 466 * MiB,
    limitBytes: 3 * GiB,
    peakBytes: 1.8 * GiB,
    alertRatio: 0.85,
    windowHours: 168,
    stepSeconds: HOUR,
    points: points([0.5 * GiB, 1.2 * GiB, 1.8 * GiB, null, 466 * MiB]),
    lastOomKill: null,
    ...over,
  };
}

function renderWith(over: Partial<typeof queryState>) {
  Object.assign(queryState, { data: undefined, isLoading: false, isError: false, error: null }, over);
  try { localStorage.clear(); } catch { /* jsdom without storage */ }
  return render(<MailServerMemoryCard />);
}

beforeEach(() => { refetch.mockClear(); });

describe('memoryLevel', () => {
  it('follows the alert threshold, and turns critical close to the limit', () => {
    expect(memoryLevel(0.5, 0.85)).toBe('ok');
    expect(memoryLevel(0.85, 0.85)).toBe('warning');
    expect(memoryLevel(0.7, 0.6)).toBe('warning');
    expect(memoryLevel(0.96, 0.85)).toBe('critical');
    expect(memoryLevel(0.9, null)).toBe('ok');
    expect(memoryLevel(null, 0.85)).toBe('ok');
  });
});

describe('chartSegments', () => {
  it('breaks the line at an unmeasured hour instead of drawing zero', () => {
    const segs = chartSegments(points([GiB, 2 * GiB, null, GiB]), 3 * GiB);
    expect(segs).toHaveLength(2);
    expect(segs[0].split(' ')).toHaveLength(2);
  });

  it('draws a lone hour as a short tick, since a one-point line draws nothing', () => {
    const segs = chartSegments(points([null, GiB, null]), 3 * GiB);
    expect(segs).toHaveLength(1);
    const [a, b] = segs[0].split(' ').map((pt) => pt.split(',').map(Number));
    expect(a[1]).toBe(b[1]);
    expect(b[0] - a[0]).toBeGreaterThan(0);
  });

  it('keeps the tick of the newest hour inside the chart at its full width', () => {
    const tickWidth = (seg: string) => {
      const xs = seg.split(' ').map((pt) => Number(pt.split(',')[0]));
      return { min: Math.min(...xs), max: Math.max(...xs) };
    };
    const right = tickWidth(chartSegments(points([null, GiB]), 3 * GiB)[0]);
    const middle = tickWidth(chartSegments(points([null, GiB, null]), 3 * GiB)[0]);
    const left = tickWidth(chartSegments(points([GiB, null]), 3 * GiB)[0]);
    expect(right.max).toBe(600);
    expect(left.min).toBe(0);
    expect(right.max - right.min).toBe(middle.max - middle.min);
    expect(left.max - left.min).toBe(middle.max - middle.min);
  });

  it('scales to the limit: a value at the limit touches the top edge', () => {
    const [seg] = chartSegments(points([3 * GiB]), 3 * GiB);
    expect(Number(seg.split(' ')[0].split(',')[1])).toBeCloseTo(1, 1);
  });
});

describe('hourLabel', () => {
  it('names the hour a bucket covers, from its end', () => {
    const end = new Date(2026, 10, 19, 8, 0).getTime() / 1000;
    expect(hourLabel(end, HOUR)).toBe('2026-11-19 07:00–08:00');
  });
});

describe('MailServerMemoryCard', () => {
  it('shows current memory against the limit, the 7-day peak and the graph', () => {
    renderWith({ data: { data: response() } });
    expect(screen.getByTestId('mail-section-memory')).toHaveTextContent('466.0 MiB of 3.0 GiB (15 %) • 7-day peak 1.8 GiB');
    expect(screen.getByTestId('mail-memory-current')).toHaveTextContent('466.0 MiB');
    expect(screen.getByTestId('mail-memory-limit')).toHaveTextContent('of 3.0 GiB limit · 15 %');
    expect(screen.getByTestId('mail-memory-peak')).toHaveTextContent('7-day peak 1.8 GiB (60 %)');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '15');
    expect(screen.getAllByTestId('mail-memory-line')).toHaveLength(2);
    expect(screen.getByTestId('mail-memory-alert-line')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-memory-last-oom')).toBeNull();
  });

  it('colours the figure once memory passes the alert threshold', () => {
    renderWith({ data: { data: response({ currentBytes: 2.7 * GiB }) } });
    expect(screen.getByTestId('mail-memory-current').className).toContain('text-amber-700');
  });

  it('draws no alert line when the rule is disabled', () => {
    renderWith({ data: { data: response({ alertRatio: null }) } });
    expect(screen.queryByTestId('mail-memory-alert-line')).toBeNull();
  });

  it('pins an alert override above 100 % to the top edge instead of drawing it off the chart', () => {
    renderWith({ data: { data: response({ alertRatio: 1.2 }) } });
    expect(Number(screen.getByTestId('mail-memory-alert-line').getAttribute('y1'))).toBeCloseTo(1, 1);
  });

  it('explains an empty graph when only the current sample exists yet', () => {
    renderWith({ data: { data: response({ peakBytes: null, points: points([null, null, null]) }) } });
    expect(screen.getByTestId('mail-memory-current')).toHaveTextContent('466.0 MiB');
    expect(screen.getByText('The graph fills in hour by hour.')).toBeInTheDocument();
  });

  it('names the last OOM kill', () => {
    renderWith({ data: { data: response({ lastOomKill: { at: '2026-11-19T04:32:19.000Z', inferred: false } }) } });
    expect(screen.getByTestId('mail-memory-last-oom')).toHaveTextContent('Last killed for running out of memory at 2026-11-19');
  });

  it('says "most likely" when the kill was a bare forced stop rather than a reported OOM', () => {
    renderWith({ data: { data: response({ lastOomKill: { at: '2026-11-19T04:32:19.000Z', inferred: true } }) } });
    expect(screen.getByTestId('mail-memory-last-oom')).toHaveTextContent('most likely for running out of memory');
  });

  it('reads out the hovered hour', () => {
    renderWith({ data: { data: response() } });
    const plot = screen.getByTestId('mail-memory-chart').parentElement!;
    plot.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 72, right: 400, bottom: 72, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseMove(plot, { clientX: 300 });
    expect(screen.getByTestId('mail-memory-chart-readout')).toHaveTextContent('no sample');
    fireEvent.mouseMove(plot, { clientX: 400 });
    expect(screen.getByTestId('mail-memory-chart-readout')).toHaveTextContent('466.0 MiB');
  });

  it('says when there are no samples yet, without inventing zeros', () => {
    renderWith({ data: { data: response({ available: false, reason: 'No memory samples for the mail server yet.', currentBytes: null, peakBytes: null, points: points([null, null]) }) } });
    expect(screen.getByTestId('mail-section-memory')).toHaveTextContent('No samples yet');
    expect(screen.getByTestId('mail-memory-unavailable')).toHaveTextContent('No memory samples for the mail server yet.');
    expect(screen.queryByTestId('mail-memory-body')).toBeNull();
  });

  it('shows a read failure as an error with a retry, not as "no samples"', () => {
    renderWith({ isError: true, error: new Error('Could not read the mail server\'s memory') });
    expect(screen.getByTestId('mail-section-memory')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('mail-memory-error')).toBeInTheDocument();
    expect(screen.queryByTestId('mail-memory-unavailable')).toBeNull();
  });
});
