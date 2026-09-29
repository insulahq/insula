/**
 * The traffic chart: a `TrafficFrame` expressed in the shared chart's terms.
 *
 * All the drawing lives in `components/charts/TimeSeriesChart` — gaps, the
 * pinned readout, spike markers, stacking — because none of that is about
 * traffic. What belongs here is the translation: which formatter to use for
 * bytes versus requests versus milliseconds, which series may stack, and the
 * timezone pill.
 */

import type { TrafficFrame } from '@insula/api-contracts';
import { Clock } from 'lucide-react';
import TimeSeriesChart, { colourForIndex } from '@/components/charts/TimeSeriesChart';
import {
  browserTimeZone, formatAxisTick, formatInstant, formatTrafficRate, formatTrafficTotal,
  utcOffsetLabel,
} from '@/lib/format-traffic';

export { colourForIndex, findSpikes, niceCeiling } from '@/components/charts/TimeSeriesChart';

export interface TrafficChartProps {
  readonly frame: TrafficFrame;
  readonly hidden?: ReadonlySet<string>;
  readonly stacked: boolean;
  readonly onZoom?: (centreIso: string) => void;
  readonly className?: string;
}

export function stepLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day steps`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour steps`;
  return `${Math.round(seconds / 60)}-minute steps`;
}

export default function TrafficChart({
  frame, hidden, stacked, onZoom, className,
}: TrafficChartProps) {
  const series = frame.series.map((s, i) => ({
    key: s.key,
    name: s.name,
    points: s.points,
    colour: colourForIndex(i),
    // A grouped frame carries two measurements, one a subset of the other.
    // Only ungrouped series may be added together.
    stackGroup: s.group === undefined ? 'all' : undefined,
  }));

  return (
    <TimeSeriesChart
      className={className}
      times={frame.times}
      series={series}
      stepSeconds={frame.stepSeconds}
      stacked={stacked}
      hidden={hidden}
      onZoom={onZoom}
      ariaLabel="Traffic over time"
      formatValue={(v) => formatTrafficRate(v, frame.unit)}
      formatStepTotal={(v, secs) => formatTrafficTotal(v, frame.unit, secs)}
      formatTick={formatAxisTick}
      formatInstant={formatInstant}
      cornerNote={(
        <span
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border
            border-gray-200 bg-gray-50 px-2.5 py-[3px] text-[11.5px] text-gray-500
            dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-400"
          title={`Times are shown in ${browserTimeZone()}`}
          data-testid="traffic-tzpill"
        >
          <Clock size={11} />
          <b className="font-semibold text-gray-600 dark:text-gray-300">{utcOffsetLabel()}</b>
          {' '}your time
        </span>
      )}
      badge={(
        <span className="rounded-full border border-gray-200 bg-white/90 px-2 py-0.5 text-[10px]
          tabular-nums text-gray-500 dark:border-gray-700 dark:bg-gray-800/90 dark:text-gray-400"
        >
          {stepLabel(frame.stepSeconds)} · {frame.times.length} points
        </span>
      )}
    />
  );
}
