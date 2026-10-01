/**
 * The traffic chart: a `TrafficFrame` expressed in the shared chart's terms.
 *
 * All the drawing lives in `components/charts/TimeSeriesChart` — gaps, the
 * readout, spike markers, paint order, drag-to-zoom — because none of that is
 * about traffic. What belongs here is the translation: which formatter to use
 * for bytes versus requests versus milliseconds, the combined line, and the
 * two pills.
 */

import { useMemo } from 'react';
import type { TrafficFrame } from '@insula/api-contracts';
import { Clock } from 'lucide-react';
import TimeSeriesChart, { colourForIndex, type ChartSeries } from '@/components/charts/TimeSeriesChart';
import {
  browserTimeZone, formatAxisTick, formatInstant, formatTrafficRate, formatTrafficTotal,
  utcOffsetLabel,
} from '@/lib/format-traffic';
import { TOTAL_KEY, totalLabel } from './combined-line';

export { colourForIndex } from '@/components/charts/TimeSeriesChart';

export interface TrafficChartProps {
  readonly frame: TrafficFrame;
  readonly hidden?: ReadonlySet<string>;
  /** The series whose row is hovered; the rest fade. */
  readonly focusKey?: string | null;
  /**
   * The combined line (`combined-line.ts`), on a view that offers one. It is
   * the base of each row's share in the readout whether or not it is drawn.
   */
  readonly combined?: ReadonlyArray<number | null> | null;
  /** Draw `combined` as the grey total line. */
  readonly showTotal?: boolean;
  /** From the same combined line the stat tiles read. */
  readonly spikeIndices?: readonly number[];
  readonly onZoom?: (centreIso: string) => void;
  readonly onRangeSelect?: (fromIso: string, toIso: string) => void;
  readonly className?: string;
}

export function stepLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day steps`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour steps`;
  return `${Math.round(seconds / 60)}-minute steps`;
}

/** One size and style for both pills — the steps pill used to be a smaller, fainter one. */
const PILL = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-gray-200 '
  + 'bg-gray-50 px-2.5 py-[3px] text-[11.5px] tabular-nums text-gray-500 '
  + 'dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-400';

export default function TrafficChart({
  frame, hidden, focusKey = null, combined = null, showTotal = false, spikeIndices,
  onZoom, onRangeSelect, className,
}: TrafficChartProps) {
  // Memoised: hovering a table row re-renders this on every row crossed, and
  // a fresh array would make the chart redo its paint order and axis each time.
  const series: ChartSeries[] = useMemo(() => [
    ...frame.series.map((s, i) => ({
      key: s.key, name: s.name, points: s.points, colour: colourForIndex(i),
    })),
    ...(showTotal && combined
      ? [{ key: TOTAL_KEY, name: totalLabel(frame.unit), points: combined, emphasis: 'total' as const }]
      : []),
  ], [frame.series, frame.unit, showTotal, combined]);
  // A share of an average means nothing; latency rows show their values only.
  const shareBase = combined && frame.unit !== 'milliseconds' ? combined : undefined;

  return (
    <TimeSeriesChart
      className={className}
      times={frame.times}
      series={series}
      stepSeconds={frame.stepSeconds}
      hidden={hidden}
      focusKey={focusKey}
      shareBase={shareBase}
      spikeIndices={spikeIndices}
      onZoom={onZoom}
      onRangeSelect={onRangeSelect}
      height={300}
      fullBleed
      ariaLabel="Traffic over time"
      formatValue={(v) => formatTrafficRate(v, frame.unit)}
      formatStepTotal={(v, secs) => formatTrafficTotal(v, frame.unit, secs)}
      formatTick={formatAxisTick}
      formatInstant={formatInstant}
      cornerNote={(
        <span className={PILL} title={`Times are shown in ${browserTimeZone()}`} data-testid="traffic-tzpill">
          <Clock size={11} />
          <b className="font-semibold text-gray-600 dark:text-gray-300">{utcOffsetLabel()}</b>
          {' '}your time
        </span>
      )}
      badge={(
        <span className={PILL} data-testid="traffic-steps-pill">
          <b className="font-semibold text-gray-600 dark:text-gray-300">{stepLabel(frame.stepSeconds)}</b>
          {' · '}
          {frame.times.length}
          {' points'}
        </span>
      )}
    />
  );
}
